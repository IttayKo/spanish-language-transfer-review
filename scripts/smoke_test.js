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
      if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }

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

  const serverState = { html };
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

    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    const offlineCardCount = await page.locator('.packcard').count();
    check(offlineCardCount === DATA.packs.length,
      'the app still loads and renders every track while offline, served from the service worker cache');
    const offlineDone = ((await page.locator(`.packcard[data-pid="${cssEscape(seedPack.id)}"]`).getAttribute('class')) || '')
      .split(/\s+/).includes('done');
    check(offlineDone === preOfflineDone,
      'progress (feature 1) survives being served offline from the cache',
      `got done=${offlineDone}, expected done=${preOfflineDone}`);
    await context.setOffline(false);

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

    // ==================== recap pool correctness ====================
    // Regression coverage for the recap bug: "seems like it's always the
    // same and only 2 drills." Root cause was that startRecap() pooled ONLY
    // drills that already carried a grade, while marking a track done via
    // the home-screen circle grades nothing - so a learner with several
    // tracks ticked done and a couple of graded drills got a pool of ~2
    // forever. Seed exactly that shape and confirm recap now draws from
    // every drill in every covered track, actually delivers RECAP_SIZE when
    // that many exist, and that two consecutive recaps genuinely differ.
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });

    const recapPacks = DATA.packs.filter((p) => (p.drills || []).length >= 3).slice(0, 6);
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

        const cue = await fitPage.$eval('.cue span', (el) => el.textContent).catch(() => '');
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
