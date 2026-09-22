#!/usr/bin/env node
// Browser smoke test for index.html: the golden path, the localStorage
// progress contract that live users' saved progress depends on, the
// export/import round trip that is meant to be the escape hatch for it, and
// the installable/offline (PWA) layer - including that a fresh build is
// still picked up after the service worker has cached an older one.
//
// Playwright/Chromium are pre-installed outside this project's node_modules
// (there is no package.json dependency, no install step): run this with
//   NODE_PATH=/opt/node22/lib/node_modules node scripts/smoke_test.js
//
// Deliberately avoids asserting on copy, colour or exact wording (the UI is
// being reworded concurrently) - it asserts on ids, structure, counts and
// behaviour instead.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const REPO_ROOT = path.join(__dirname, '..');
const INDEX_PATH = process.env.LT_INDEX_HTML || path.join(REPO_ROOT, 'index.html');
// Must match RECAP_SIZE in app/lt-review-app.tmpl.html.
const RECAP_SIZE_EXPECTED = 12;

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exitCode = 1;
}

// Mimics just enough of the real static deploy (see vercel.json) for the PWA
// bits to work in the test: /sw.js, /manifest.json and /icons/* are served
// as real files with real content types (a service worker registration is
// rejected by the browser if it doesn't come back as a JS MIME type), and
// every other path falls back to the built index.html, same as before.
const STATIC_TYPES = { '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png' };
// `state.html` is mutable so a later test can simulate a fresh deploy
// landing (swap the bytes served for "/") without restarting the server.
function startServer(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      // "Offline" for real: refuse the connection outright. Playwright's
      // context.setOffline() doesn't reach a service worker's own fetches
      // in Chromium, so on its own it let the worker quietly fetch from the
      // network and an offline check could pass without the cache ever
      // being read. `refused` counts the attempts, so a test can prove the
      // network was actually tried and failed.
      if (state.offline) { state.refused = (state.refused || 0) + 1; req.socket.destroy(); return; }
      if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }

      // /demo is the second build the same source produces: the app
      // pointed at its own storage keys, opened with sample progress. It is
      // served here so the isolation between the two can be tested for real,
      // in one browser profile, the way a visitor would hit it.
      if (urlPath === '/demo' || urlPath === '/demo/' || urlPath === '/demo/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(state.demoHtml || '');
        return;
      }

      if (urlPath === '/sw.js' || urlPath === '/manifest.json' || urlPath.indexOf('/icons/') === 0) {
        const filePath = path.join(REPO_ROOT, urlPath);
        const ext = path.extname(filePath);
        fs.readFile(filePath, (err, data) => {
          if (err) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream' });
          res.end(data);
        });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(state.html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  if (!fs.existsSync(INDEX_PATH)) {
    fail('index.html does not exist at ' + INDEX_PATH + ' - build it first (python3 app/build_app.py)');
    return;
  }
  const html = fs.readFileSync(INDEX_PATH, 'utf-8');

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    fail('playwright is not resolvable. Run with NODE_PATH=/opt/node22/lib/node_modules. (' + e.message + ')');
    return;
  }

  const DEMO_PATH = path.join(REPO_ROOT, 'demo', 'index.html');
  const demoHtml = fs.existsSync(DEMO_PATH) ? fs.readFileSync(DEMO_PATH, 'utf-8') : '';
  const serverState = { html, demoHtml };
  const server = await startServer(serverState);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch();
  let errorCount = 0;

  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push('console error: ' + msg.text());
    });

    // ---------- ground truth, read from the page's own embedded data ----------
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('.packcard', { timeout: 10000 });

    const dataJson = await page.$eval('#pack-data', (el) => el.textContent);
    const DATA = JSON.parse(dataJson);
    if (!Array.isArray(DATA.packs) || DATA.packs.length === 0) {
      fail('embedded pack data has no packs');
      return;
    }

    // ---------- home loads with the expected track count ----------
    const cardCount = await page.locator('.packcard').count();
    check(cardCount === DATA.packs.length, 'home shows one track card per pack',
      `got ${cardCount} cards, expected ${DATA.packs.length}`);

    // ==================== extension provenance marker ====================
    // Extension drills (sentences we wrote from a track's rules, not lines
    // the teacher said) must carry a quiet provenance marker on the drill
    // screen; track drills (from the recording, the default) must not.
    // Picked straight from the embedded pack data so this stays valid as
    // content changes, and run before any progress exists so drill order
    // starts fresh at index 0.
    const markerCandidates = DATA.packs.filter((p) => {
      const drills = p.drills || [];
      return drills.some((d) => d.source === 'extension') && drills.some((d) => d.source === 'track');
    });
    check(markerCandidates.length > 0, 'at least one pack has both track and extension drills to test the marker on');
    if (markerCandidates.length > 0) {
      const markerPack = markerCandidates.slice().sort((a, b) => a.drills.length - b.drills.length)[0];
      const firstTrackIdx = markerPack.drills.findIndex((d) => d.source === 'track');
      const firstExtIdx = markerPack.drills.findIndex((d) => d.source === 'extension');
      check(firstTrackIdx !== -1 && firstExtIdx !== -1,
        `${markerPack.id} has a findable track drill and a findable extension drill`);

      await page.click(`.rowbtn[data-pid="${cssEscape(markerPack.id)}"]`);
      await page.waitForSelector('.cue');

      const lastIdx = Math.max(firstTrackIdx, firstExtIdx);
      for (let i = 0; i <= lastIdx; i++) {
        const hasMarker = await page.locator('.cue .src-tag').count() > 0;
        if (i === firstExtIdx) {
          check(hasMarker, `extension drill ${markerPack.drills[i].id} shows the provenance marker`);
        }
        if (i === firstTrackIdx) {
          check(!hasMarker, `track drill ${markerPack.drills[i].id} shows no provenance marker`);
        }
        await page.click('#revealBtn');
        await page.click('#stuckBtn');
      }

      // Reset: this walk left grades behind for markerPack, and the golden
      // path / localStorage checks below need a clean slate to reason about.
      // Which bar id is present depends on whether the walk landed exactly
      // on the summary screen (grading the pack's very last drill).
      await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
      if (await page.locator('#topHomeBtn2').count() > 0) { await page.click('#topHomeBtn2'); }
      else { await page.click('#topHomeBtn'); }
      await page.waitForSelector('.packcard');
    }

    check(pageErrors.length === 0, 'no page/console errors during the extension marker check',
      pageErrors.join('\n  '));

    // ==================== golden path ====================
    // Use the pack with the fewest (but nonzero) drills, so grading through
    // an entire track to reach the summary stays fast.
    const drillPacks = DATA.packs.filter((p) => (p.drills || []).length > 0);
    check(drillPacks.length > 0, 'at least one pack has drills');
    const goldenPack = drillPacks.slice().sort((a, b) => a.drills.length - b.drills.length)[0];

    await page.click(`.rowbtn[data-pid="${cssEscape(goldenPack.id)}"]`);
    // The redesign's pack-view header (back arrow + Drills/Rules tabs) carries
    // no title of its own - the track identifies itself in the cue line
    // instead ("Track N · drill i of n"), so that's where this check looks.
    await page.waitForSelector('.cue');
    const cueTitleText = (await page.textContent('.cue')).trim();
    check(cueTitleText.indexOf(goldenPack.label) === 0, `opening ${goldenPack.id} shows its own track label in the cue line`,
      `got ${JSON.stringify(cueTitleText)}, expected it to start with ${JSON.stringify(goldenPack.label)}`);

    check(await page.locator('#revealBtn').count() > 0, 'first drill has a reveal-answer button');
    for (let i = 0; i < goldenPack.drills.length; i++) {
      await page.click('#revealBtn');
      const answerText = (await page.textContent('.answer .es')).trim();
      check(answerText.length > 0, `drill ${i + 1}/${goldenPack.drills.length} of ${goldenPack.id} reveals a non-empty answer`);
      await page.click('#gotBtn');
    }
    // Grading the last drill should land on the summary screen. The summary
    // copy itself may be reworded, so check via the structural next-step ids
    // its bar renders instead of the wording.
    const reachedSummary = await page.locator('#continueBtn, #topHomeBtn2, #backToFullBtn').count() > 0;
    check(reachedSummary, `grading all ${goldenPack.drills.length} drills of ${goldenPack.id} reaches a summary bar`);

    // ---------- glossary: open, search, expand, practice ----------
    // The bar id in play depends on state (recap vs. rule-filtered vs. normal).
    if (await page.locator('#topHomeBtn2').count() > 0) { await page.click('#topHomeBtn2'); }
    else if (await page.locator('#topHomeBtn').count() > 0) { await page.click('#topHomeBtn'); }
    await page.waitForSelector('#glossaryBtn');
    await page.click('#glossaryBtn');
    await page.waitForSelector('#glossarySearch');

    // "track" is guaranteed to appear in every glossary entry's search text
    // (every entry lists the track(s) it appears in) regardless of content
    // rewording, so this search is content-independent.
    await page.fill('#glossarySearch', 'track');
    await page.waitForTimeout(150);
    const glossRowCount = await page.locator('.glosshead').count();
    check(glossRowCount > 0, 'searching the glossary for "track" returns rules');

    // Expand rows in order until one has a "practice this rule" target -
    // some rules have no drills of their own, so not every row has one.
    let practiced = false;
    const heads = page.locator('.glosshead');
    const headCount = await heads.count();
    for (let i = 0; i < headCount && !practiced; i++) {
      await heads.nth(i).click();
      const practiceBtn = page.locator('.gpractice').first();
      if (await practiceBtn.count() > 0) {
        const targetPid = await practiceBtn.getAttribute('data-pid');
        const targetRuleId = await practiceBtn.getAttribute('data-ruleid');
        await practiceBtn.click();
        await page.waitForSelector('.cue');

        const bannerCount = await page.locator('.filterbanner').count();
        check(bannerCount > 0, 'practicing a rule from the glossary shows the "Only drills for:" filter banner');
        const landedTitle = (await page.textContent('.cue')).trim();
        const targetPack = DATA.packs.find((p) => p.id === targetPid);
        check(!!targetPack && landedTitle.indexOf(targetPack.label) === 0,
          'practicing a glossary rule lands on the right track',
          `cue read ${JSON.stringify(landedTitle)}, expected it to start with ${JSON.stringify(targetPack && targetPack.label)}`);

        // Reveal and confirm the drill is actually tagged with the rule we
        // asked to practice (the filter did what it claims).
        if (await page.locator('#revealBtn').count() > 0) {
          await page.click('#revealBtn');
          const hasRuleLink = await page.locator(`.rulelink[data-ruleid="${cssEscape(targetRuleId)}"]`).count() > 0;
          check(hasRuleLink, `filtered drill lists rule ${targetRuleId} under "Why"`);
        }
        practiced = true;
      } else {
        await heads.nth(i).click(); // collapse before trying the next
      }
    }
    check(practiced, 'at least one glossary rule matching "track" has a "practice this rule" button');

    check(pageErrors.length === 0, 'no page/console errors during the golden path',
      pageErrors.join('\n  '));

    // ==================== localStorage progress contract ====================
    // Real users' progress lives only in localStorage. If a rename or shape
    // change ever breaks this silently, every existing user is wiped with no
    // error. Seed a known-good blob in the documented shape and confirm the
    // app actually reads it back and resumes correctly, then confirm a fresh
    // grade persists across a reload.
    const seedPack = DATA.packs.filter((p) => (p.drills || []).length >= 4)
      .sort((a, b) => b.drills.length - a.drills.length)[1] // not the golden pack, and not the very largest
      || DATA.packs.filter((p) => (p.drills || []).length >= 4)[0];
    check(!!seedPack && seedPack.id !== goldenPack.id, 'found a second pack with >=4 drills to seed for the localStorage check');

    const pool = seedPack.drills;
    const seedGrades = {};
    seedGrades[pool[0].id] = 'got';
    seedGrades[pool[1].id] = 'got';
    seedGrades[pool[2].id] = 'stuck';

    await page.evaluate(({ packId, grades }) => {
      localStorage.setItem('lt-review:' + packId, JSON.stringify(grades));
      localStorage.setItem('lt-review-done', JSON.stringify({ [packId]: true }));
    }, { packId: seedPack.id, grades: seedGrades });

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.packcard');

    const seedCard = page.locator(`.packcard[data-pid="${cssEscape(seedPack.id)}"]`);
    check(await seedCard.count() > 0, 'seeded pack has a home card after reload');
    const seedCardClass = await seedCard.getAttribute('class');
    check((seedCardClass || '').split(/\s+/).includes('done'),
      'seeded pack shows as done on the home screen, read back from lt-review-done',
      `class was ${JSON.stringify(seedCardClass)}`);
    // Success is unmarked by design: a track marked done shows nothing in the
    // progress column (the filled tick already said it) even though it also
    // has partial per-drill grades underneath - so the read-back of
    // lt-review:<id> is verified below instead, via where the track resumes.
    const progCountWhileDone = await seedCard.locator('.prog').count();
    check(progCountWhileDone === 0,
      'a done track shows nothing in the progress column, even with partial grades underneath',
      `found ${progCountWhileDone} .prog element(s)`);

    // Open it: it should resume at the first ungraded drill (index 3), not
    // restart at drill 1.
    await page.click(`.rowbtn[data-pid="${cssEscape(seedPack.id)}"]`);
    await page.waitForSelector('.cue');
    const cueText = (await page.textContent('.cue')).trim();
    check(cueText.indexOf(`drill 4 of ${pool.length}`) !== -1,
      'opening a seeded pack resumes at the first ungraded drill instead of restarting',
      `cue read ${JSON.stringify(cueText)}, expected to contain "drill 4 of ${pool.length}"`);

    // Grade the resumed drill, reload, and confirm it persisted.
    await page.click('#revealBtn');
    await page.click('#gotBtn');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.packcard');
    await page.click(`.rowbtn[data-pid="${cssEscape(seedPack.id)}"]`);
    await page.waitForSelector('.cue');
    const cueTextAfter = (await page.textContent('.cue')).trim();
    check(cueTextAfter.indexOf(`drill 5 of ${pool.length}`) !== -1,
      'a freshly graded drill survives a full page reload',
      `cue read ${JSON.stringify(cueTextAfter)}, expected to contain "drill 5 of ${pool.length}" - a grade did not persist`);

    check(pageErrors.length === 0, 'no page/console errors during the localStorage regression check',
      pageErrors.join('\n  '));

    // ==================== progress export / import ====================
    // Real users' only copy of their progress is this feature. Round-trip it
    // for real: through the actual download and the actual (hidden) file
    // input, not by calling internal functions - and confirm a malformed
    // file is rejected without touching whatever progress already exists.
    const expectedSeedGrades = Object.assign({}, seedGrades);
    expectedSeedGrades[pool[3].id] = 'got'; // the resumed drill graded just above

    await page.click('#topHomeBtn'); // leave the track, back to the track list
    await page.waitForSelector('#backupBtn');
    await page.click('#backupBtn');
    await page.waitForSelector('#exportBtn');

    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportBtn');
    const download = await downloadPromise;
    const backupPath = path.join(os.tmpdir(), 'lt-review-smoke-backup.json');
    await download.saveAs(backupPath);
    const backupRaw = fs.readFileSync(backupPath, 'utf-8');
    let backupJson = null;
    try { backupJson = JSON.parse(backupRaw); } catch (e) { /* checked below */ }

    check(!!backupJson, 'exported backup file is valid JSON');
    check(!!backupJson && backupJson.app === 'lt-review-backup', 'exported backup carries an app/schema marker');
    check(!!backupJson && backupJson.version === 1, 'exported backup carries a version number');
    check(!!backupJson && typeof backupJson.exportedAt === 'string' && backupJson.exportedAt.length > 0,
      'exported backup carries an export timestamp');
    check(!!backupJson && JSON.stringify(backupJson.progress && backupJson.progress[seedPack.id]) === JSON.stringify(expectedSeedGrades),
      `exported backup contains the exact seeded grades for ${seedPack.id}`,
      `got ${JSON.stringify(backupJson && backupJson.progress && backupJson.progress[seedPack.id])}`);
    check(!!backupJson && backupJson.done && backupJson.done[seedPack.id] === true,
      'exported backup marks the seeded pack done');

    // Wipe everything, exactly like clearing site data or landing on a new device.
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.packcard');
    const wipedCardClass = await page.locator(`.packcard[data-pid="${cssEscape(seedPack.id)}"]`).getAttribute('class');
    check(!(wipedCardClass || '').split(/\s+/).includes('done'),
      'wiping localStorage really did clear the seeded pack\'s done state (sanity check before importing)');

    await page.click('#backupBtn');
    await page.waitForSelector('#importFile', { state: 'attached' }); // hidden by design, see importFile's CSS

    // ---- malformed / unrelated / truncated files must be rejected cleanly ----
    const unrelatedPath = path.join(os.tmpdir(), 'lt-review-smoke-unrelated.json');
    fs.writeFileSync(unrelatedPath, JSON.stringify({ hello: 'world', totally: 'unrelated' }));
    await page.setInputFiles('#importFile', unrelatedPath);
    await page.waitForSelector('.backup-msg.err', { timeout: 5000 });
    let progressKeyCount = await page.evaluate(
      () => Object.keys(localStorage).filter((k) => k.indexOf('lt-review:') === 0).length);
    check(progressKeyCount === 0, 'importing an unrelated JSON file is rejected and writes nothing to localStorage');

    const truncatedPath = path.join(os.tmpdir(), 'lt-review-smoke-truncated.json');
    fs.writeFileSync(truncatedPath, backupRaw.slice(0, Math.floor(backupRaw.length / 2)));
    await page.setInputFiles('#importFile', truncatedPath);
    await page.waitForSelector('.backup-msg.err', { timeout: 5000 });
    progressKeyCount = await page.evaluate(
      () => Object.keys(localStorage).filter((k) => k.indexOf('lt-review:') === 0).length);
    check(progressKeyCount === 0, 'importing a truncated file is rejected and writes nothing to localStorage');

    // ---- the destructive path (replace) is gated behind an explicit confirmation ----
    await page.click('#modeReplace');
    await page.waitForSelector('#backupConfirm');
    check(await page.isDisabled('#importBtn'),
      'replace mode disables the import trigger until the confirmation box is checked');
    // Bypass the button and hand the input a file directly: the handler itself
    // must still refuse, not just the button's disabled attribute.
    await page.setInputFiles('#importFile', backupPath);
    await page.waitForSelector('.backup-msg.err', { timeout: 5000 });
    progressKeyCount = await page.evaluate(
      () => Object.keys(localStorage).filter((k) => k.indexOf('lt-review:') === 0).length);
    check(progressKeyCount === 0,
      'replace mode refuses to import without the confirmation checked, even if a file is supplied directly');
    check(await page.isDisabled('#importBtn'), 'import trigger is still disabled after the refused attempt');

    await page.check('#backupConfirm');
    check(!(await page.isDisabled('#importBtn')), 'checking the confirmation box enables the import trigger');

    // ---- real round trip: switch back to merge (the default) and import for real ----
    await page.click('#modeMerge');
    await page.setInputFiles('#importFile', backupPath);
    await page.waitForSelector('.backup-msg.ok', { timeout: 5000 });

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.packcard');
    const restoredCard = page.locator(`.packcard[data-pid="${cssEscape(seedPack.id)}"]`);
    const restoredCardClass = await restoredCard.getAttribute('class');
    check((restoredCardClass || '').split(/\s+/).includes('done'), 'imported backup restores the done tick');
    // Same "success is unmarked" rule as above: this track is done, so its
    // progress column is empty on the home screen; the exact restored grades
    // (the real content of the count) are checked below via localStorage.
    const restoredProgCount = await restoredCard.locator('.prog').count();
    check(restoredProgCount === 0,
      'a done track restored by import still shows nothing in the progress column',
      `found ${restoredProgCount} .prog element(s)`);

    const restoredGrades = await page.evaluate(
      (pid) => JSON.parse(localStorage.getItem('lt-review:' + pid) || '{}'), seedPack.id);
    check(JSON.stringify(restoredGrades) === JSON.stringify(expectedSeedGrades),
      'imported backup restores the exact per-drill grades, not just the count',
      `got ${JSON.stringify(restoredGrades)}, expected ${JSON.stringify(expectedSeedGrades)}`);

    check(pageErrors.length === 0, 'no page/console errors during the export/import round trip',
      pageErrors.join('\n  '));

    // ==================== PWA: manifest, service worker, offline ====================
    // The one way this feature can go wrong is worse than not shipping it:
    // a document cached badly could pin an installed user to a stale build
    // forever. So this checks both halves - offline genuinely works, AND
    // coming back online picks up a fresh build rather than the cached one -
    // plus that progress (feature 1's whole point) survives the trip.
    check(await page.locator('link[rel="manifest"]').count() > 0, 'page links a web app manifest');
    const manifestHref = await page.$eval('link[rel="manifest"]', (el) => el.getAttribute('href'));
    const manifestJson = await page.evaluate((href) => fetch(href).then((r) => r.json()), manifestHref);
    check(Array.isArray(manifestJson.icons) && manifestJson.icons.length > 0, 'manifest declares at least one icon');
    check(!!manifestJson.name && !!manifestJson.start_url, 'manifest declares a name and a start_url');

    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'load' }); // a controlled tab needs one navigation after activation
    await page.waitForSelector('.packcard');
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    check(controlled, 'the page is controlled by its own service worker after registering');

    // Whatever's on screen right now is from the import round trip above -
    // note it so we can confirm the exact same thing survives being served
    // from the offline cache below. seedPack is marked done (so its
    // progress column is empty by design - "success is unmarked"), so the
    // done tick's class is the signal to compare instead of .prog text.
    const preOfflineDone = ((await page.locator(`.packcard[data-pid="${cssEscape(seedPack.id)}"]`).getAttribute('class')) || '')
      .split(/\s+/).includes('done');
    check(preOfflineDone, 'the seeded pack is showing as done before going offline (sanity check)');

    // Both kinds of offline: the page's own requests (setOffline) and the
    // service worker's (the server refusing every connection - see
    // startServer), so the only place the page can come from is the cache.
    await context.setOffline(true);
    serverState.offline = true; serverState.refused = 0;
    await page.reload({ waitUntil: 'load' });
    check(serverState.refused > 0,
      'going offline really cut the network: the service worker tried it and was refused',
      `refused ${serverState.refused} request(s)`);
    const offlineCardCount = await page.locator('.packcard').count();
    check(offlineCardCount === DATA.packs.length,
      'the app still loads and renders every track while offline, served from the service worker cache');
    const offlineDone = ((await page.locator(`.packcard[data-pid="${cssEscape(seedPack.id)}"]`).getAttribute('class')) || '')
      .split(/\s+/).includes('done');
    check(offlineDone === preOfflineDone,
      'progress (feature 1) survives being served offline from the cache',
      `got done=${offlineDone}, expected done=${preOfflineDone}`);
    serverState.offline = false;
    await context.setOffline(false);

    // /demo is inside the worker's scope, so the worker sees that
    // navigation too. It used to cache any page it served under the app's
    // one document key, which made the demo - sample progress, demo banner
    // and all - the installed app's offline copy after a single visit.
    await page.goto(`http://127.0.0.1:${port}/demo`, { waitUntil: 'load' });
    await page.waitForSelector('.packcard');
    await context.setOffline(true);
    serverState.offline = true;
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForSelector('.packcard');
    check(await page.locator('.demo-note').count() === 0,
      'visiting /demo online does not turn the demo into the app\'s offline copy');
    serverState.offline = false;
    await context.setOffline(false);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForSelector('.packcard');

    // Simulate a real deploy landing while this client was offline: swap the
    // bytes the test server hands out for "/" and confirm the very next
    // reload fetches the fresh copy instead of quietly continuing to serve
    // the one the service worker cached earlier - the specific failure mode
    // this feature must never cause.
    const newBuildMarker = 'lt-review-smoke-new-build-marker';
    serverState.html = html.replace('</head>', `<meta name="smoke-marker" content="${newBuildMarker}"></head>`);
    await page.reload({ waitUntil: 'load' });
    const pickedUpNewBuild = await page.evaluate((marker) => {
      const m = document.querySelector('meta[name="smoke-marker"]');
      return !!m && m.getAttribute('content') === marker;
    }, newBuildMarker);
    check(pickedUpNewBuild,
      'coming back online, the next load fetches the fresh build instead of the previously cached one');
    serverState.html = html; // restore for anything else that reads the server after this

    check(pageErrors.length === 0, 'no page/console errors during the PWA/offline checks',
      pageErrors.join('\n  '));

    // ==================== history: one entry deep, back on home leaves ====================
    // Every change of screen used to push a history entry, so a normal
    // session left dozens behind and the system back button on the home
    // screen (the way out of an installed app) did nothing for press after
    // press. Real back presses here, in a fresh tab so earlier tests' history
    // can't muddy it: about:blank, then the app.
    {
      const hp = await context.newPage();
      await hp.goto(url, { waitUntil: 'load' });
      await hp.waitForSelector('.packcard');
      const histPack = DATA.packs.find((p) => p.drills.length >= 3);
      const openHistPack = async () => {
        await hp.click(`.rowbtn[data-pid="${cssEscape(histPack.id)}"]`);
        await hp.waitForSelector('#stage');
      };
      const viewOf = () => hp.evaluate(() => (document.querySelector('main') || {}).className || '');
      const back = async () => { await hp.goBack({ waitUntil: 'commit' }).catch(() => {}); await hp.waitForTimeout(200); };
      const startLen = await hp.evaluate(() => history.length);
      for (let round = 0; round < 3; round++) {
        await openHistPack();
        await hp.click('#tabRules');
        await hp.click('#tabDrills');
        await hp.click('#topHomeBtn');
        await hp.waitForSelector('.packcard');
        await hp.click('#glossaryBtn');
        await hp.waitForSelector('.glosshead');
        await hp.click('#topHomeBtn');
        await hp.waitForSelector('.packcard');
      }
      await hp.waitForTimeout(200);
      const endLen = await hp.evaluate(() => history.length);
      check(endLen <= startLen + 1,
        'three round trips through a track, its tabs and the glossary leave the history at most one entry deeper',
        `history.length went ${startLen} -> ${endLen}`);

      await openHistPack();
      await back();
      check((await viewOf()).indexOf('view-home') !== -1, 'a real back press from a drill goes home', await viewOf());

      await openHistPack();
      await hp.click('#tabRules');
      await back();
      check((await viewOf()).indexOf('view-drill') !== -1, 'a real back press from the Rules tab goes back to the drills', await viewOf());
      await back();
      check((await viewOf()).indexOf('view-home') !== -1, 'and the next back press leaves the track for home', await viewOf());

      await back();
      check(hp.url() !== url, 'one back press on the home screen leaves the app', `still at ${hp.url()}`);
      await hp.close();
    }

    // ==================== recap pool correctness ====================
    // Regression coverage for the recap bug: "seems like it's always the
    // same and only 2 drills." Root cause was that startRecap() pooled ONLY
    // drills that already carried a grade, while marking a track done via
    // the home-screen circle grades nothing - so a learner with several
    // tracks ticked done and a couple of graded drills got a pool of ~2
    // forever. Seed exactly that shape and confirm recap now draws from
    // every drill in every covered track, actually delivers RECAP_SIZE when
    // that many exist, spans several of those tracks, and that two
    // consecutive recaps genuinely differ.
    //
    // The pool used to be ranked as well - stuck first, then ungraded, then
    // already-got - and that ranking is gone; a recap is a plain mixed
    // sample across the covered tracks now. Nothing here ever asserted the
    // ranking (it asserts breadth, size and variation, which all still
    // hold), so this section needed no unpicking when it went.
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });

    // Bounded above as well as below: with every seeded track holding fewer
    // drills than RECAP_SIZE, a recap that came from a single track is
    // impossible, so the span check below cannot flake on an unlucky shuffle.
    const recapPacks = DATA.packs
      .filter((p) => (p.drills || []).length >= 3 && p.drills.length < RECAP_SIZE_EXPECTED)
      .slice(0, 6);
    check(recapPacks.length === 6, 'found 6 packs with >=3 drills to seed a realistic recap scenario');
    const totalCoveredDrills = recapPacks.reduce((n, p) => n + p.drills.length, 0);
    check(totalCoveredDrills > RECAP_SIZE_EXPECTED,
      'the seeded covered tracks hold more drills than RECAP_SIZE, so a full recap is actually exercised',
      `got ${totalCoveredDrills} drills across ${recapPacks.length} tracks`);

    await page.evaluate(({ doneIds, gradedPackId, gradedDrillIds }) => {
      const doneMap = {};
      doneIds.forEach((id) => { doneMap[id] = true; });
      localStorage.setItem('lt-review-done', JSON.stringify(doneMap));
      // Exactly two graded drills total, inside one of the done tracks -
      // this is the "5 tracks done, 2 graded drills" shape that used to
      // starve recap down to "drill 1 of 2, always the same two".
      const grades = {};
      grades[gradedDrillIds[0]] = 'got';
      grades[gradedDrillIds[1]] = 'stuck';
      localStorage.setItem('lt-review:' + gradedPackId, JSON.stringify(grades));
    }, {
      doneIds: recapPacks.map((p) => p.id),
      gradedPackId: recapPacks[0].id,
      gradedDrillIds: [recapPacks[0].drills[0].id, recapPacks[0].drills[1].id],
    });

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.packcard');
    await page.waitForSelector('#recapBtn');
    await page.click('#recapBtn');
    await page.waitForSelector('.cue');

    // Steps through an entire recap session (revealing and grading "got" on
    // every drill, which only ever touches the isolated "lt-review:recap"
    // key, never the seeded per-track grades) and returns an ordered list
    // identifying each drill served, so two runs can be compared.
    const stepThroughRecap = async () => {
      const seq = [];
      for (;;) {
        const cueText = (await page.textContent('.cue')).trim();
        const m = /drill \d+ of (\d+)/.exec(cueText);
        if (!m) break;
        const total = parseInt(m[1], 10);
        await page.click('#revealBtn');
        const answerText = (await page.textContent('.answer .es')).trim();
        seq.push(cueText.replace(/drill \d+ of \d+/, 'drill') + '|' + answerText);
        await page.click('#gotBtn');
        if (seq.length >= total) break;
        await page.waitForSelector('.cue');
      }
      return seq;
    };

    const recapSeq1 = await stepThroughRecap();
    check(recapSeq1.length > 2 * 3,
      'recap returns substantially more drills than the 2 explicitly graded ones',
      `got ${recapSeq1.length} drills from a pool with only 2 graded`);
    check(recapSeq1.length === Math.min(RECAP_SIZE_EXPECTED, totalCoveredDrills),
      'recap actually delivers RECAP_SIZE drills when that many are available across covered tracks',
      `got ${recapSeq1.length}, expected ${Math.min(RECAP_SIZE_EXPECTED, totalCoveredDrills)}`);

    // The point of a recap: it ranges over the tracks you've covered rather
    // than re-testing one of them. No seeded track holds RECAP_SIZE drills,
    // so a recap drawn from the flat pool has to touch at least this many.
    const biggestSeeded = Math.max(...recapPacks.map((p) => p.drills.length));
    const minTracksSpanned = Math.ceil(RECAP_SIZE_EXPECTED / biggestSeeded);
    const tracksIn = (seq) => new Set(seq.map((e) => (/Track (\d+)/.exec(e) || [])[1]).filter(Boolean));
    const spanned = tracksIn(recapSeq1);
    check(minTracksSpanned >= 2 && spanned.size >= minTracksSpanned,
      'a recap ranges across several of the covered tracks, not just one',
      `spanned ${spanned.size} track(s) (${[...spanned].join(', ')}), needed at least ${minTracksSpanned}`);

    await page.waitForSelector('#newRecapBtn');
    await page.click('#newRecapBtn');
    await page.waitForSelector('.cue');
    const recapSeq2 = await stepThroughRecap();
    check(recapSeq2.length === Math.min(RECAP_SIZE_EXPECTED, totalCoveredDrills),
      'a second recap also delivers RECAP_SIZE drills',
      `got ${recapSeq2.length}`);
    check(JSON.stringify(recapSeq1) !== JSON.stringify(recapSeq2),
      'two consecutive recaps are not identical',
      'both recap runs produced the exact same sequence of drills in the exact same order');

    check(pageErrors.length === 0, 'no page/console errors during the recap pool check',
      pageErrors.join('\n  '));

    // ==================== recap composition: breadth, rule diversity, no duplicate answers, course order ====================
    // The rewritten startRecap() composes a recap only from which tracks are
    // covered and the drills' own structure (track, type, rules, source,
    // answer) - deliberately no memory-based feature: no grades, no past
    // recap's history, no spaced repetition. This checks the observable
    // shape that composition is meant to produce.
    function ruleByIdTest(rid) {
      for (const p of DATA.packs) {
        const r = (p.rules || []).find((x) => x.id === rid);
        if (r) return r;
      }
      return null;
    }
    function familyOfTest(r) { return r.family || r.id.split('__')[1].replace(/-\d+$/, ''); }
    function normalizeAnswerTest(s) {
      return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    }
    // Looked up by (track, exact answer text) rather than drill id, since the
    // rendered page never exposes a drill's id - its answer text (rendered
    // via textContent, so HTML entities are already decoded) is effectively
    // unique per track in this dataset.
    const allDrillsIndex = new Map();
    DATA.packs.forEach((p) => (p.drills || []).forEach((d) => {
      allDrillsIndex.set(p.tracks[0] + '|' + d.answer, d);
    }));
    const seqToDrills = (seq) => seq.map((e) => {
      const [cuePart, answerText] = e.split('|');
      const trackNum = parseInt((/Track (\d+)/.exec(cuePart) || [])[1], 10);
      return allDrillsIndex.get(trackNum + '|' + answerText) || null;
    });

    // ---- (a) breadth: with far more covered tracks than RECAP_SIZE, a recap spans both the first and last quarter of the covered range ----
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
    const breadthPacks = DATA.packs
      .filter((p) => (p.drills || []).length >= 1)
      .sort((a, b) => a.tracks[0] - b.tracks[0])
      .slice(0, 40);
    check(breadthPacks.length === 40, 'found 40 tracks with at least one drill to seed the breadth/order/dedup checks with',
      `got ${breadthPacks.length}`);
    await page.evaluate((ids) => {
      const doneMap = {};
      ids.forEach((id) => { doneMap[id] = true; });
      localStorage.setItem('lt-review-done', JSON.stringify(doneMap));
    }, breadthPacks.map((p) => p.id));
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.packcard');
    await page.waitForSelector('#recapBtn');
    await page.click('#recapBtn');
    await page.waitForSelector('.cue');

    const breadthSeq = await stepThroughRecap();
    const breadthTrackNums = breadthSeq.map((e) => parseInt((/Track (\d+)/.exec(e) || [])[1], 10));
    check(breadthTrackNums.every((n) => !Number.isNaN(n)), 'every recap drill in the breadth check identifies its own track');

    const minTrack = breadthPacks[0].tracks[0], maxTrack = breadthPacks[breadthPacks.length - 1].tracks[0];
    const quarterSpan = (maxTrack - minTrack) / 4;
    const touchesFirstQuarter = breadthTrackNums.some((t) => t <= minTrack + quarterSpan);
    const touchesLastQuarter = breadthTrackNums.some((t) => t >= maxTrack - quarterSpan);
    check(touchesFirstQuarter && touchesLastQuarter,
      'with 40 tracks covered, a recap spans both the first and last quarter of the covered range',
      `tracks drawn: ${[...new Set(breadthTrackNums)].sort((x, y) => x - y).join(', ')} (covered range ${minTrack}-${maxTrack})`);

    // ---- (c) course order: the recap's drills come back in non-decreasing track order ----
    let nonDecreasing = true;
    for (let i = 1; i < breadthTrackNums.length; i++) {
      if (breadthTrackNums[i] < breadthTrackNums[i - 1]) { nonDecreasing = false; break; }
    }
    check(nonDecreasing,
      "the recap's drills are in non-decreasing track order (the course's own order), not the order they were drawn in",
      breadthTrackNums.join(', '));

    // ---- (b) no duplicate answers ----
    const breadthAnswers = breadthSeq.map((e) => normalizeAnswerTest(e.split('|')[1]));
    check(new Set(breadthAnswers).size === breadthAnswers.length,
      'no two drills in one recap share the same (normalised) answer',
      `${breadthAnswers.length} drills, only ${new Set(breadthAnswers).size} distinct normalised answers`);

    // ---- (d) rule diversity and the word-drill cap, when the covered pool can support both ----
    // Run it several times - each is a fresh weighted draw, so one lucky (or
    // unlucky) run proves nothing either way.
    const breadthFamilies = new Set();
    breadthPacks.forEach((p) => (p.rules || []).forEach((r) => breadthFamilies.add(familyOfTest(r))));
    const breadthSentences = breadthPacks.reduce((n, p) => n + (p.drills || []).filter((d) => d.type !== 'word').length, 0);
    check(breadthFamilies.size >= RECAP_SIZE_EXPECTED && breadthSentences >= RECAP_SIZE_EXPECTED,
      'the seeded 40-track pool has enough distinct rule families and sentence drills to actually exercise diversity + the word cap',
      `${breadthFamilies.size} families, ${breadthSentences} sentence drills`);

    let repeatFamilyRuns = 0, overWordCapRuns = 0;
    const runFamilyWordCheck = async (seq) => {
      const drills = seqToDrills(seq);
      check(drills.every(Boolean), 'every recap drill in the diversity check was matched back to its source drill',
        `${drills.filter((d) => !d).length} unmatched of ${drills.length}`);
      const seenFamilies = new Set();
      let repeated = false;
      drills.forEach((d) => {
        if (!d) return;
        (d.rules || []).forEach((rid) => {
          const r = ruleByIdTest(rid);
          const fam = r ? familyOfTest(r) : rid;
          if (seenFamilies.has(fam)) repeated = true;
          seenFamilies.add(fam);
        });
      });
      if (repeated) repeatFamilyRuns++;
      const wordCount = drills.filter((d) => d && d.type === 'word').length;
      if (wordCount > 2) overWordCapRuns++;
    };
    await runFamilyWordCheck(breadthSeq);
    for (let run = 0; run < 4; run++) {
      await page.waitForSelector('#newRecapBtn');
      await page.click('#newRecapBtn');
      await page.waitForSelector('.cue');
      const seq = await stepThroughRecap();
      await runFamilyWordCheck(seq);
    }
    check(repeatFamilyRuns === 0,
      'with a rich covered pool, no rule family repeats within a single recap, across 5 runs',
      `${repeatFamilyRuns}/5 runs had a repeated rule family`);
    check(overWordCapRuns === 0,
      'with plenty of sentence drills available, a recap never exceeds its 2-word-drill cap, across 5 runs',
      `${overWordCapRuns}/5 runs exceeded the word-drill cap`);

    check(pageErrors.length === 0, 'no page/console errors during the recap composition checks',
      pageErrors.join('\n  '));

    // ---------- the two backs on a drill screen do different things ----------
    // "Take that back" used to mean three things depending on what happened
    // to be on screen - fold the answer, fold a hint, or jump to the previous
    // drill - so pressing it one time too many silently left the drill you
    // were working on. It only unwinds reveals now, and stepping back through
    // the queue is its own control. The assertion that matters is the one
    // that broke: however many times the undo is pressed, it cannot leave
    // the drill.
    const navPack = DATA.packs.find((p) => (p.drills || []).length > 4 &&
      ((p.drills[1] || {}).steps || []).length >= 3);
    check(!!navPack, 'found a track to test the drill back controls on');
    if (navPack) {
      const navPage = await context.newPage();
      const navErrors = [];
      navPage.on('pageerror', (e) => navErrors.push('pageerror: ' + e.message));
      navPage.on('console', (m) => { if (m.type() === 'error') navErrors.push('console error: ' + m.text()); });
      await navPage.goto(url, { waitUntil: 'load' });
      await navPage.waitForSelector('.packcard');
      await navPage.evaluate(() => localStorage.clear());
      await navPage.reload({ waitUntil: 'load' });
      await navPage.waitForSelector('.packcard');
      await navPage.evaluate((id) => document.getElementById('pack-' + id).querySelector('.rowbtn').click(), navPack.id);
      await navPage.waitForSelector('#stage');

      const navState = () => navPage.evaluate(() => ({
        cue: document.querySelector('.cuetext').textContent.replace(/\s+/g, ' ').trim(),
        prev: !!document.getElementById('prevDrillBtn'),
        undo: !!document.getElementById('undoBtn'),
        hints: document.querySelectorAll('.steps li').length,
        answer: !!document.querySelector('.answer'),
      }));

      let ns = await navState();
      check(!ns.prev && !ns.undo,
        'drill 1 offers neither back control before anything has happened',
        `prev=${ns.prev} undo=${ns.undo}`);

      await navPage.click('#revealBtn');
      await navPage.click('#gotBtn');
      ns = await navState();
      check(ns.prev && ns.cue.indexOf('drill 2 of') !== -1,
        'the drill back control appears once there is a drill to go back to', ns.cue);
      check(!ns.undo, 'and the undo does not, until something has been revealed');

      for (;;) { const n = await navPage.$('#nextStepBtn'); if (!n) break; await n.click(); }
      await navPage.click('#revealBtn');
      await navPage.waitForSelector('.answer');
      const revealed = (await navState()).hints;
      check(revealed >= 3, 'every hint is out and the answer is shown', `${revealed} hints`);

      await navPage.click('#undoBtn');
      ns = await navState();
      check(!ns.answer && ns.hints === revealed,
        'the first undo folds only the answer away, leaving the hints alone',
        `answer=${ns.answer} hints=${ns.hints}/${revealed}`);

      let escaped = false;
      for (let i = 0; i < revealed + 5; i++) {
        const u = await navPage.$('#undoBtn');
        if (!u) break;
        await u.click();
        if ((await navState()).cue.indexOf('drill 2 of') === -1) { escaped = true; break; }
      }
      ns = await navState();
      check(!escaped && ns.cue.indexOf('drill 2 of') !== -1,
        'the undo cannot leave the drill, however many times it is pressed', ns.cue);
      check(ns.hints === 0 && !ns.answer && !ns.undo,
        'it unwinds one reveal at a time down to nothing, then goes away',
        `hints=${ns.hints} answer=${ns.answer} undo=${ns.undo}`);
      check(ns.prev, 'and the drill back control is untouched by any of it');

      await navPage.click('#nextStepBtn');
      await navPage.click('#prevDrillBtn');
      ns = await navState();
      check(ns.cue.indexOf('drill 1 of') !== -1, 'the drill back control steps back one drill', ns.cue);
      check(ns.hints === 0 && !ns.answer,
        'and reopens it fresh, so going back is another go rather than a replay',
        `hints=${ns.hints} answer=${ns.answer}`);
      check(!ns.prev, 'and it is gone again on the first drill');

      const headBack = await navPage.$eval('#topHomeBtn', (el) => el.textContent.replace(/\s+/g, ' ').trim());
      check(headBack.indexOf('Tracks') !== -1,
        'the header back says where it goes, so it cannot be read as the drill back',
        `header back reads "${headBack}"`);
      check(navErrors.length === 0, 'no page/console errors from the drill back controls',
        navErrors.join('\n  '));
      await navPage.close();
    }

    // ---------- the drill screen never scrolls, and never clips either ----------
    // The drill view is meant to behave like an app screen, not a document:
    // head, stage and action bar inside exactly one viewport, at every size,
    // for every drill. fitDrill() delivers that by squeezing space, then type,
    // then the periphery - so the two ways it can be wrong are letting the
    // page scroll (the guarantee broken) and running out of ladder and
    // clipping the answer off the bottom (much worse than scrolling). Both
    // are asserted here, on the densest drills in the dataset, in the tallest
    // state a drill can reach: every hint out AND the answer shown.
    const VIEWPORTS = [
      { name: 'small phone', width: 320, height: 568 },
      { name: 'phone', width: 375, height: 667 },
      { name: 'tall phone', width: 390, height: 844 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'short desktop', width: 1280, height: 600 },
      { name: 'phone, sideways', width: 844, height: 390 },
    ];
    const DENSE_N = 6;
    const density = (d) => (d.steps || []).length * 40 + d.prompt.length +
      d.answer.length * 1.4 + (d.rules || []).length * 30 + (d.note ? d.note.length : 0);
    const densest = [];
    for (const p of DATA.packs) {
      (p.drills || []).forEach((d, i) => densest.push({ packId: p.id, pack: p, idx: i, id: d.id, score: density(d) }));
    }
    densest.sort((a, b) => b.score - a.score);
    const denseTargets = densest.slice(0, DENSE_N);
    check(denseTargets.length === DENSE_N,
      `found ${DENSE_N} drills to probe the drill screen's fit with`,
      `only got ${denseTargets.length}`);

    const fitPage = await context.newPage();
    const fitErrors = [];
    fitPage.on('pageerror', (e) => fitErrors.push('pageerror: ' + e.message));
    fitPage.on('console', (m) => { if (m.type() === 'error') fitErrors.push('console error: ' + m.text()); });

    const scrolled = [], clipped = [], barLost = [], wrongDrill = [];
    for (const vp of VIEWPORTS) {
      await fitPage.setViewportSize({ width: vp.width, height: vp.height });
      for (const t of denseTargets) {
        // Resume lands on the first ungraded drill, so grading everything
        // before the target opens the pack straight onto it.
        const seed = {};
        for (let i = 0; i < t.idx; i++) seed[t.pack.drills[i].id] = 'got';
        await fitPage.goto(url, { waitUntil: 'load' });
        await fitPage.evaluate(([k, v]) => { localStorage.clear(); localStorage.setItem(k, v); },
          ['lt-review:' + t.packId, JSON.stringify(seed)]);
        await fitPage.reload({ waitUntil: 'load' });
        await fitPage.waitForSelector('.packcard');
        await fitPage.evaluate((id) => document.getElementById('pack-' + id).querySelector('.rowbtn').click(), t.packId);
        await fitPage.waitForSelector('#stage');

        const cue = await fitPage.$eval('.cuetext', (el) => el.textContent).catch(() => '');
        if (!cue.includes(`drill ${t.idx + 1} `)) { wrongDrill.push(`${vp.name}/${t.id}: ${cue}`); continue; }

        for (;;) { const n = await fitPage.$('#nextStepBtn'); if (!n) break; await n.click(); }
        await fitPage.click('#revealBtn');
        await fitPage.waitForSelector('.answer');

        const m = await fitPage.evaluate(() => {
          const st = document.getElementById('stage');
          const de = document.documentElement;
          const bar = document.getElementById('bar').getBoundingClientRect();
          return {
            clip: st.scrollHeight - st.clientHeight,
            docScroll: de.scrollHeight - de.clientHeight,
            bodyScroll: document.body.scrollHeight - document.body.clientHeight,
            barBottom: bar.bottom, barTop: bar.top, vh: window.innerHeight,
            answerBottom: document.querySelector('.answer .es').getBoundingClientRect().bottom,
          };
        });
        if (m.clip > 1) clipped.push(`${vp.name}/${t.id} by ${Math.round(m.clip)}px`);
        if (m.docScroll > 1 || m.bodyScroll > 1) scrolled.push(`${vp.name}/${t.id}`);
        if (m.barBottom > m.vh + 1) barLost.push(`${vp.name}/${t.id}: bar below the fold`);
        if (m.answerBottom > m.barTop + 1) barLost.push(`${vp.name}/${t.id}: answer runs under the bar`);

        await fitPage.mouse.wheel(0, 800);
        const y = await fitPage.evaluate(() => window.scrollY);
        if (y > 0) scrolled.push(`${vp.name}/${t.id}: wheel moved the page to ${y}`);
      }
    }
    await fitPage.close();

    check(wrongDrill.length === 0, 'the fit probe reached every drill it meant to measure', wrongDrill.join('; '));
    check(scrolled.length === 0,
      `the drill screen never scrolls (${DENSE_N} densest drills x ${VIEWPORTS.length} viewports, fully revealed)`,
      scrolled.join('; '));
    check(clipped.length === 0,
      'and fits without clipping - the fit ladder never runs out on a real drill',
      clipped.join('; '));
    check(barLost.length === 0, 'the grade buttons stay in view, with the answer clear of them',
      barLost.join('; '));
    check(fitErrors.length === 0, 'no page/console errors during the drill fit check',
      fitErrors.join('\n  '));

    // ==================== auto-finish: leaving a full track marks it done ====================
    // "Progress is full" means every drill in the pack carries a grade, got
    // or stuck alike - not that every grade is "got". Leaving a full track by
    // any exit (the new Finish button, the header back arrow, browser back)
    // is meant to tick it done on its own; a partially graded track, a
    // rule-filtered slice of one, and a recap must never be auto-ticked (see
    // maybeAutoFinish() and packFullyGraded() in the template for exactly
    // what "full" excludes and why).
    const orderedByTrack = DATA.packs.slice().sort((a, b) => a.tracks[0] - b.tracks[0]);
    const lastTrackPack = orderedByTrack[orderedByTrack.length - 1];
    const drillLessPack = DATA.packs.find((p) => (p.drills || []).length === 0);
    check(!!drillLessPack, 'found a drills-only-rules pack (track 1) to test the auto-finish exclusion on');

    // Three distinct, small, non-final packs so the scenarios below don't
    // tread on each other's stored grades.
    const finishCandidates = DATA.packs
      .filter((p) => (p.drills || []).length >= 2 && p.id !== lastTrackPack.id)
      .sort((a, b) => a.drills.length - b.drills.length);
    check(finishCandidates.length >= 3, 'found at least 3 small non-final packs for the auto-finish checks');
    const finishPack = finishCandidates[0];
    const backPack = finishCandidates[1];
    const partialPack = finishCandidates[2];

    const isDoneOnHome = async (pg, pid) => {
      const cls = await pg.locator(`.packcard[data-pid="${cssEscape(pid)}"]`).getAttribute('class');
      return (cls || '').split(/\s+/).includes('done');
    };
    const clearAndReload = async (pg) => {
      await pg.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
      await pg.reload({ waitUntil: 'load' });
      await pg.waitForSelector('.packcard');
    };
    const gradeAllGot = async (pg, n) => {
      for (let i = 0; i < n; i++) {
        await pg.click('#revealBtn');
        await pg.click('#gotBtn');
      }
    };

    // ---- 1. pressing Finish on a fully-graded track marks it done ----
    await clearAndReload(page);
    await page.click(`.rowbtn[data-pid="${cssEscape(finishPack.id)}"]`);
    await page.waitForSelector('.cue');
    await gradeAllGot(page, finishPack.drills.length);
    check(await page.locator('#finishBtn').count() > 0,
      `${finishPack.id} has a next track, so its summary offers a Finish button beside Continue`);
    await page.click('#finishBtn');
    await page.waitForSelector('.packcard');
    check(await isDoneOnHome(page, finishPack.id),
      'pressing Finish on a fully-graded track marks it done on the home screen');

    // ---- 2. leaving a fully-graded track via the header back arrow (not Finish) also marks it done ----
    await clearAndReload(page);
    await page.click(`.rowbtn[data-pid="${cssEscape(backPack.id)}"]`);
    await page.waitForSelector('.cue');
    await gradeAllGot(page, backPack.drills.length);
    await page.click('#topHomeBtn'); // header "<- Tracks", not the summary's Finish button
    await page.waitForSelector('.packcard');
    check(await isDoneOnHome(page, backPack.id),
      'leaving a fully-graded track via the header back arrow marks it done too, same as Finish');

    // ---- 3. a track only partly graded is not auto-marked when left ----
    await clearAndReload(page);
    check(partialPack.drills.length >= 2, `${partialPack.id} has enough drills to grade only some of them`);
    await page.click(`.rowbtn[data-pid="${cssEscape(partialPack.id)}"]`);
    await page.waitForSelector('.cue');
    await gradeAllGot(page, partialPack.drills.length - 1); // leave the last drill ungraded
    await page.click('#topHomeBtn');
    await page.waitForSelector('.packcard');
    check(!(await isDoneOnHome(page, partialPack.id)),
      'leaving a track with an ungraded drill left over does not mark it done');

    // ---- 4. a rule-filtered session, finished, does not finish the whole track ----
    // (unless the filter happens to cover every drill in the pack, so this
    // deliberately picks one that covers a strict subset).
    let rulePack = null, ruleId = null;
    findRule:
    for (const p of DATA.packs) {
      const drills = p.drills || [];
      if (!drills.length) continue;
      const counts = {};
      drills.forEach((d) => (d.rules || []).forEach((rid) => { counts[rid] = (counts[rid] || 0) + 1; }));
      for (const rid of Object.keys(counts)) {
        if (counts[rid] > 0 && counts[rid] < drills.length) { rulePack = p; ruleId = rid; break findRule; }
      }
    }
    check(!!rulePack && !!ruleId,
      "found a rule that covers only some of its track's drills, to test the filtered summary with");
    if (rulePack) {
      await clearAndReload(page);
      await page.click(`.rowbtn[data-pid="${cssEscape(rulePack.id)}"]`);
      await page.waitForSelector('.cue');
      await page.click('#tabRules');
      await page.waitForSelector(`.practicebtn[data-ruleid="${cssEscape(ruleId)}"]`);
      await page.click(`.practicebtn[data-ruleid="${cssEscape(ruleId)}"]`);
      await page.waitForSelector('.cue');
      const filteredCount = rulePack.drills.filter((d) => (d.rules || []).indexOf(ruleId) !== -1).length;
      await gradeAllGot(page, filteredCount);
      check(await page.locator('#backToFullBtn').count() > 0,
        'finishing a rule-filtered session reaches its own summary bar');
      await page.click('#topHomeBtn'); // leave via the header, the same funnel a Finish click uses
      await page.waitForSelector('.packcard');
      check(!(await isDoneOnHome(page, rulePack.id)),
        `finishing a rule-filtered session (${filteredCount}/${rulePack.drills.length} drills) does not mark the whole track done`);
    }

    // ---- 5. a recap can never mark anything done, including under the id "recap" ----
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
    const recapSeedPacks = DATA.packs.filter((p) => (p.drills || []).length >= 2).slice(0, 4);
    check(recapSeedPacks.length === 4, "found 4 packs to seed as \"covered\" for the recap-can't-finish check");
    await page.evaluate((ids) => {
      const doneMap = {};
      ids.forEach((id) => { doneMap[id] = true; });
      localStorage.setItem('lt-review-done', JSON.stringify(doneMap));
    }, recapSeedPacks.map((p) => p.id));
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#recapBtn');
    await page.click('#recapBtn');
    await page.waitForSelector('.cue');
    let recapTotal = null;
    for (let i = 0; ; i++) {
      const cueText = (await page.textContent('.cue')).trim();
      const m = /drill \d+ of (\d+)/.exec(cueText);
      if (!m) break;
      if (recapTotal === null) recapTotal = parseInt(m[1], 10);
      await page.click('#revealBtn');
      await page.click('#gotBtn');
      if (i + 1 >= recapTotal) break;
      await page.waitForSelector('.cue');
    }
    check(await page.locator('#topHomeBtn2').count() > 0, 'a finished recap reaches its summary bar');
    const recapFinishLabel = (await page.textContent('#topHomeBtn2')).trim();
    check(recapFinishLabel.indexOf('Finish') !== -1,
      "the recap summary's leave button says Finish - it's already the finish action, just relabelled",
      `got ${JSON.stringify(recapFinishLabel)}`);
    await page.click('#topHomeBtn2');
    await page.waitForSelector('.packcard');
    const doneMapAfterRecap = await page.evaluate(() => JSON.parse(localStorage.getItem('lt-review-done') || '{}'));
    check(!('recap' in doneMapAfterRecap),
      'finishing a recap never writes a done entry for the synthetic id "recap"',
      `done map: ${JSON.stringify(doneMapAfterRecap)}`);
    check(Object.keys(doneMapAfterRecap).sort().join(',') === recapSeedPacks.map((p) => p.id).sort().join(','),
      'finishing a recap does not mark any additional track done beyond what was already ticked',
      `done map: ${JSON.stringify(doneMapAfterRecap)}`);

    // ---- 6. a drills-only pack (no drills at all, e.g. track 1) is never auto-marked done ----
    // `every drill graded` is vacuously true over an empty array; that
    // accident is deliberately excluded (see packFullyGraded()).
    if (drillLessPack) {
      await clearAndReload(page);
      await page.click(`.rowbtn[data-pid="${cssEscape(drillLessPack.id)}"]`);
      await page.waitForSelector('#topHomeBtn');
      await page.click('#topHomeBtn');
      await page.waitForSelector('.packcard');
      check(!(await isDoneOnHome(page, drillLessPack.id)),
        `opening and leaving a drills-only pack (${drillLessPack.id}) never auto-marks it done`);
    }

    check(pageErrors.length === 0, 'no page/console errors during the auto-finish checks',
      pageErrors.join('\n  '));

    // ==================== bug fixes: home hero, listen-first, summary/back navigation, rule-filtered restart, glossary "ahead" marking, confidence:"low" ====================

    // ---- 1 & 2. nextRecommendedTrack() skips an untouched drills-only pack once there's progress; the hero label reflects "nothing yet" vs. "left off" ----
    await clearAndReload(page);
    let heroLabel = (await page.textContent('.home-hero .lbl')).trim();
    check(heroLabel === 'Start here',
      'a fresh user with no progress at all and no done-marks sees "Start here", not "Where you left off"',
      `got ${JSON.stringify(heroLabel)}`);
    let heroPid = await page.getAttribute('#continueCardBtn', 'data-pid');
    check(!!drillLessPack && heroPid === drillLessPack.id,
      'a fresh user still gets the drills-only pack (track 1) recommended first, same as before',
      `got ${heroPid}, expected ${drillLessPack && drillLessPack.id}`);
    check(await page.locator('.home-hero .listen').count() === 0,
      'the listen-first line does not show for a drills-only recommendation (there is nothing to build)');

    if (drillLessPack) {
      // Give the learner some progress elsewhere, but leave the drills-only
      // pack itself untouched and unticked - it must stop being recommended
      // once there's any sign they've moved on, rather than pointing the
      // hero at it forever until someone finds and ticks its circle by hand.
      const progressPack = DATA.packs.find((p) => p.id !== drillLessPack.id && (p.drills || []).length >= 1);
      check(!!progressPack, 'found a second pack to grade a drill in, to give the fresh user "some progress"');
      if (progressPack) {
        await page.evaluate(({ pid, did }) => {
          localStorage.setItem('lt-review:' + pid, JSON.stringify({ [did]: 'got' }));
        }, { pid: progressPack.id, did: progressPack.drills[0].id });
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('.packcard');

        heroLabel = (await page.textContent('.home-hero .lbl')).trim();
        check(heroLabel === 'Where you left off',
          'once there is any graded progress, the hero label switches to "Where you left off"',
          `got ${JSON.stringify(heroLabel)}`);
        heroPid = await page.getAttribute('#continueCardBtn', 'data-pid');
        check(heroPid !== drillLessPack.id,
          'with any progress logged, the home hero no longer recommends the still-untouched drills-only track',
          `still recommending ${heroPid}`);

        // ---- 3a. listen-first line on the home hero ----
        const listenCount = await page.locator('.home-hero .listen').count();
        check(listenCount > 0, 'the home hero now names a real track with drills, so it shows the listen-first line');
        if (listenCount > 0) {
          const listenText = (await page.textContent('.home-hero .listen')).trim();
          const heroTNumMatch = (await page.textContent('.home-hero .t')).match(/\d+/);
          check(!!heroTNumMatch && listenText.indexOf('Listen to track ' + heroTNumMatch[0]) !== -1,
            'the home hero tells the learner to listen to the recommended track\'s audio before drilling it',
            `hero track text unclear or mismatched: ${JSON.stringify(listenText)}`);
        }
      }
    }

    // ---- 3b. listen-next line on a normal summary, only when a next track exists ----
    await clearAndReload(page);
    const summaryNextPack = finishCandidates[0];
    const summaryNextExpected = orderedByTrack[orderedByTrack.findIndex((p) => p.id === summaryNextPack.id) + 1];
    check(!!summaryNextExpected, 'the chosen pack has a following track in order, to test the summary listen-next line with');
    await page.click(`.rowbtn[data-pid="${cssEscape(summaryNextPack.id)}"]`);
    await page.waitForSelector('.cue');
    await gradeAllGot(page, summaryNextPack.drills.length);
    await page.waitForSelector('.summary-line');
    const summaryListenCount = await page.locator('.listennote').count();
    check(summaryListenCount > 0,
      'a normal summary with a next track shows the listen-next-track reminder above the bar');
    if (summaryListenCount > 0) {
      const summaryListenText = (await page.textContent('.listennote')).trim();
      check(summaryListenText.indexOf(`Track ${summaryNextExpected.tracks[0]}`) !== -1 &&
        summaryListenText.toLowerCase().indexOf("after you've listened to it") !== -1,
        'the listen-next-track line names the actual next track',
        summaryListenText);
    }

    // ---- 4. browser back from a summary leaves the track; the Drills tab on a finished session shows the summary, not a dead screen ----
    await clearAndReload(page);
    const backTestPack = finishCandidates[1] || finishCandidates[0];
    await page.click(`.rowbtn[data-pid="${cssEscape(backTestPack.id)}"]`);
    await page.waitForSelector('.cue');
    await gradeAllGot(page, backTestPack.drills.length);
    await page.waitForSelector('.summary-line');
    // The app's popstate handler acts on the live `view` variable, not the
    // popped history entry, so dispatching the event is equivalent to a real
    // browser/system back press here without depending on Playwright's own
    // history navigation lining up with the SPA's pushState calls.
    await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await page.waitForTimeout(150);
    let afterBack = await page.evaluate(() => ({
      mainClass: document.querySelector('main') ? document.querySelector('main').className : '',
      hasEmpty: !!document.querySelector('.empty'),
    }));
    check(afterBack.mainClass.indexOf('view-home') !== -1 && !afterBack.hasEmpty,
      'browser/system back from a summary screen leaves the track (home), not a dead "Nothing to practice here." drill screen',
      JSON.stringify(afterBack));

    // Reopening it lands directly back on the summary now (goBack() above
    // just marked it done via maybeAutoFinish(), and a fully-graded pool
    // resumes at idx === queue.length per startSession()/resumeIndex()) -
    // exactly the "finished session" shape the Drills tab fix targets, with
    // no need to re-grade anything.
    await page.click(`.rowbtn[data-pid="${cssEscape(backTestPack.id)}"]`);
    await page.waitForSelector('.summary-line');
    await page.click('#tabDrills');
    const tabDrillsMainClass = await page.evaluate(() => document.querySelector('main').className);
    const tabDrillsEmptyCount = await page.locator('.empty').count();
    check(tabDrillsMainClass.indexOf('view-summary') !== -1 && tabDrillsEmptyCount === 0,
      'the Drills tab on a finished session shows the summary screen, not "Nothing to practice here."',
      `main class ${JSON.stringify(tabDrillsMainClass)}, .empty count ${tabDrillsEmptyCount}`);

    // ---- 5. "Start over" on a rule-filtered summary keeps the filter, instead of restarting the whole track ----
    if (rulePack) {
      await clearAndReload(page);
      await page.click(`.rowbtn[data-pid="${cssEscape(rulePack.id)}"]`);
      await page.waitForSelector('.cue');
      await page.click('#tabRules');
      await page.waitForSelector(`.practicebtn[data-ruleid="${cssEscape(ruleId)}"]`);
      await page.click(`.practicebtn[data-ruleid="${cssEscape(ruleId)}"]`);
      await page.waitForSelector('.cue');
      // Recomputed locally: the `filteredCount` from the earlier auto-finish
      // check is scoped to that check's own `if (rulePack)` block.
      const filteredCount = rulePack.drills.filter((d) => (d.rules || []).indexOf(ruleId) !== -1).length;
      await gradeAllGot(page, filteredCount);
      await page.waitForSelector('#backToFullBtn');
      check(await page.locator('.listennote').count() === 0,
        'a rule-filtered summary shows no listen-next-track line - "Back to Track N" is the only next step it offers');

      await page.click('#restartBtn');
      await page.waitForSelector('.cue');
      const restartBanner = await page.locator('.filterbanner').count();
      check(restartBanner > 0,
        '"Start over" on a rule-filtered session keeps the rule filter instead of dropping it and restarting the whole track');
      const restartCue = (await page.textContent('.cue')).trim();
      check(restartCue.indexOf(`drill 1 of ${filteredCount}`) !== -1,
        '"Start over" on a rule-filtered session restarts the same filtered set of drills, not the full track',
        `cue read ${JSON.stringify(restartCue)}, expected to contain "drill 1 of ${filteredCount}"`);
    }

    check(pageErrors.length === 0, 'no page/console errors during the bug-fix navigation checks',
      pageErrors.join('\n  '));

    // ---- 6. the "All rules" glossary marks entries introduced beyond the learner's current track ----
    await clearAndReload(page);
    const orderedGlossTest = DATA.packs.slice().sort((a, b) => a.tracks[0] - b.tracks[0]);
    const doneAheadIds = orderedGlossTest.slice(0, 3).map((p) => p.id);
    await page.evaluate((ids) => {
      const doneMap = {};
      ids.forEach((id) => { doneMap[id] = true; });
      localStorage.setItem('lt-review-done', JSON.stringify(doneMap));
    }, doneAheadIds);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.packcard');
    const curTestPack = orderedGlossTest.find((p) => !doneAheadIds.includes(p.id));
    check(!!curTestPack, 'found the next undone pack after seeding 3 done tracks, to compute the expected current track');
    const curTrackExpected = curTestPack.tracks[0];

    await page.click('#glossaryBtn');
    await page.waitForSelector('.glosshead');
    const glossState = await page.evaluate(() => [...document.querySelectorAll('.glosshead')].map((el, i) => ({
      i,
      fam: el.getAttribute('data-fam'),
      origin: parseInt(el.querySelector('.num').textContent, 10),
      ahead: el.classList.contains('ahead'),
      n: el.querySelector('.n').textContent.trim(),
    })));
    check(glossState.length > 0, 'the glossary rendered at least one entry to check "ahead" marking on');

    const wronglyAhead = glossState.filter((e) => e.origin <= curTrackExpected && e.ahead);
    check(wronglyAhead.length === 0,
      `no glossary entry introduced at or before track ${curTrackExpected} is marked "ahead"`,
      wronglyAhead.map((e) => e.fam).join(', '));
    const wronglyNotAhead = glossState.filter((e) => e.origin > curTrackExpected && !e.ahead);
    check(wronglyNotAhead.length === 0,
      `every glossary entry introduced after track ${curTrackExpected} is marked "ahead"`,
      wronglyNotAhead.slice(0, 5).map((e) => e.fam).join(', '));
    const aheadWithCount = glossState.find((e) => e.ahead && e.n !== 'not reached yet');
    check(!aheadWithCount,
      'an "ahead" entry replaces its right-hand count label with "not reached yet"',
      aheadWithCount && JSON.stringify(aheadWithCount));

    const aheadEntry = glossState.find((e) => e.ahead);
    check(!!aheadEntry, 'found at least one "ahead" entry to test the opened-panel message on');
    if (aheadEntry) {
      await page.locator('.glosshead').nth(aheadEntry.i).click();
      await page.waitForSelector('#glp-' + aheadEntry.i);
      const panelText = (await page.textContent('#glp-' + aheadEntry.i)).trim();
      check(panelText.indexOf("haven't reached it yet") !== -1 && panelText.indexOf(String(aheadEntry.origin)) !== -1,
        'opening an "ahead" entry explains which track teaches it and that it hasn\'t been reached yet',
        panelText);
    }

    check(pageErrors.length === 0, 'no page/console errors during the glossary "ahead" checks',
      pageErrors.join('\n  '));

    // ==================== low-confidence flag also fires for confidence:"low" (documented string form) ====================
    // skill/references/pack-format.md documents confidence as either a number
    // (warn below 0.7, already covered above) or the literal string "low",
    // which the player used to not handle at all. Nothing in the current
    // dataset is guaranteed to use the string form, so this injects it by
    // patching the page's own embedded JSON rather than depending on content.
    {
      const dataOpenTag = '<script id="pack-data" type="application/json">';
      const dataOpenIdx = html.indexOf(dataOpenTag);
      const dataStart = dataOpenIdx === -1 ? -1 : dataOpenIdx + dataOpenTag.length;
      const dataCloseIdx = dataStart === -1 ? -1 : html.indexOf('</script', dataStart);
      check(dataStart !== -1 && dataCloseIdx !== -1,
        'located the embedded pack-data script tag to patch for the confidence:"low" test');

      if (dataStart !== -1 && dataCloseIdx !== -1) {
        const rawDataStr = html.slice(dataStart, dataCloseIdx).replace(/<\\\/script/g, '</script');
        const patchedData = JSON.parse(rawDataStr);
        let lowPack = null, lowDrill = null, lowIdx = -1;
        outer:
        for (const p of patchedData.packs) {
          const drills = p.drills || [];
          for (let i = 0; i < drills.length; i++) {
            if (drills[i].confidence === undefined) { lowPack = p; lowDrill = drills[i]; lowIdx = i; break outer; }
          }
        }
        check(!!lowDrill, 'found a drill with no confidence field to inject "low" into');

        if (lowDrill) {
          lowDrill.confidence = 'low';
          const patchedJson = JSON.stringify(patchedData).replace(/</g, '\\u003c');
          const patchedHtml = html.slice(0, dataStart) + patchedJson + html.slice(dataCloseIdx);

          const savedHtml = serverState.html;
          serverState.html = patchedHtml;
          const lowPage = await context.newPage();
          const lowErrors = [];
          lowPage.on('pageerror', (e) => lowErrors.push('pageerror: ' + e.message));
          lowPage.on('console', (m) => { if (m.type() === 'error') lowErrors.push('console error: ' + m.text()); });
          try {
            await lowPage.goto(url, { waitUntil: 'load' });
            await lowPage.waitForSelector('.packcard');
            const seed = {};
            for (let i = 0; i < lowIdx; i++) seed[lowPack.drills[i].id] = 'got';
            await lowPage.evaluate(([k, v]) => { localStorage.clear(); localStorage.setItem(k, v); },
              ['lt-review:' + lowPack.id, JSON.stringify(seed)]);
            await lowPage.reload({ waitUntil: 'load' });
            await lowPage.waitForSelector('.packcard');
            await lowPage.evaluate((id) => document.getElementById('pack-' + id).querySelector('.rowbtn').click(), lowPack.id);
            await lowPage.waitForSelector('.cue');
            await lowPage.click('#revealBtn');
            await lowPage.waitForSelector('.answer');
            const flagCount = await lowPage.locator('.answer .flag').count();
            check(flagCount > 0,
              'a drill with confidence:"low" (the documented string form) shows the low-confidence warning after reveal',
              `flag count ${flagCount}`);
          } finally {
            serverState.html = savedHtml;
            check(lowErrors.length === 0, 'no page/console errors during the confidence:"low" check', lowErrors.join('\n  '));
            await lowPage.close();
          }
        }
      }
    }

    // ---------- /demo cannot touch a real user's progress ----------
    // The demo ships sample progress so the screens aren't empty, and it
    // lives on the same origin as the app - which means it shares
    // localStorage with it. If it ever wrote the real keys, one click on a
    // demo link would overwrite the saved work of anyone already using the
    // app, with no way back (there is no server copy). This is the check
    // that stops that: a real user's progress is laid down first, the demo
    // is opened in the same browser profile, and every byte of the real
    // progress has to still be there afterwards.
    check(demoHtml.length > 0, 'demo/index.html was built', 'run python3 app/build_app.py');
    if (demoHtml) {
      const demoPage = await context.newPage();
      const demoErrors = [];
      demoPage.on('pageerror', (e) => demoErrors.push('pageerror: ' + e.message));
      demoPage.on('console', (m) => { if (m.type() === 'error') demoErrors.push('console error: ' + m.text()); });

      const realPack = DATA.packs[2].id;
      const realGrades = JSON.stringify({ 'probe-1': 'got', 'probe-2': 'stuck' });
      const realDone = JSON.stringify({ [DATA.packs[0].id]: true, [DATA.packs[1].id]: true });

      await demoPage.goto(url, { waitUntil: 'load' });
      await demoPage.waitForSelector('.packcard');
      await demoPage.evaluate(([pk, g, d]) => {
        localStorage.clear();
        localStorage.setItem('lt-review:' + pk, g);
        localStorage.setItem('lt-review-done', d);
      }, [realPack, realGrades, realDone]);

      await demoPage.goto(url + 'demo/', { waitUntil: 'load' });
      await demoPage.waitForSelector('.packcard');

      const after = await demoPage.evaluate(([pk]) => ({
        realGrades: localStorage.getItem('lt-review:' + pk),
        realDone: localStorage.getItem('lt-review-done'),
        strayRealKeys: Object.keys(localStorage)
          .filter((k) => (k.indexOf('lt-review:') === 0 || k === 'lt-review-done')),
        demoKeys: Object.keys(localStorage).filter((k) => k.indexOf('lt-review-demo') === 0).length,
        ticked: document.querySelectorAll('.donebtn.on').length,
        partials: [...document.querySelectorAll('.packcard .prog')]
          .filter((e) => e.textContent.indexOf('/') !== -1).length,
        banner: !!document.querySelector('.demo-note'),
      }), [realPack]);

      check(after.realGrades === realGrades,
        'opening /demo leaves a real per-drill progress blob byte-for-byte intact',
        `was ${realGrades}, now ${after.realGrades}`);
      check(after.realDone === realDone,
        'opening /demo leaves the real done-map byte-for-byte intact',
        `was ${realDone}, now ${after.realDone}`);
      check(after.strayRealKeys.length === 2,
        '/demo creates no new real-app storage keys at all',
        'real keys present after the demo ran: ' + after.strayRealKeys.join(', '));
      check(after.demoKeys > 10, '/demo writes its sample progress to its own keys',
        `only ${after.demoKeys} demo keys`);
      check(after.ticked > 10 && after.partials >= 1,
        '/demo opens on a worked-in track list, not an empty one',
        `${after.ticked} done, ${after.partials} part-way`);
      check(after.banner, '/demo says plainly that it is a demo', 'no .demo-note on the page');

      // And the reverse: the real app must not display, or inherit, the demo's progress.
      await demoPage.goto(url, { waitUntil: 'load' });
      await demoPage.waitForSelector('.packcard');
      const real = await demoPage.evaluate(() => ({
        ticked: document.querySelectorAll('.donebtn.on').length,
        banner: !!document.querySelector('.demo-note'),
      }));
      check(real.ticked === 2, 'the real app still shows only the real progress',
        `${real.ticked} tracks ticked, expected 2`);
      check(!real.banner, 'the demo banner never appears in the real build');
      check(demoErrors.length === 0, 'no page/console errors from the demo build',
        demoErrors.join('\n  '));
      await demoPage.close();
    }
  } catch (e) {
    fail('smoke test threw: ' + (e && e.stack || e));
  } finally {
    await browser.close();
    server.close();
  }

  function check(cond, label, detail) {
    if (cond) {
      console.log('PASS: ' + label);
    } else {
      errorCount++;
      fail(label + (detail ? ' -- ' + detail : ''));
    }
  }

  if (errorCount > 0 || process.exitCode) {
    console.error(`\n${errorCount} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll browser smoke checks passed.');
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

main();
