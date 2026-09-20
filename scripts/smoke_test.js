#!/usr/bin/env node
// Browser smoke test for index.html: the golden path plus the localStorage
// progress contract that live users' saved progress depends on.
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
const path = require('path');
const http = require('http');

const INDEX_PATH = process.env.LT_INDEX_HTML || path.join(__dirname, '..', 'index.html');

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exitCode = 1;
}

function startServer(html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
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

  const server = await startServer(html);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch();
  let errorCount = 0;

  try {
    const context = await browser.newContext();
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

    // ==================== golden path ====================
    // Use the pack with the fewest (but nonzero) drills, so grading through
    // an entire track to reach the summary stays fast.
    const drillPacks = DATA.packs.filter((p) => (p.drills || []).length > 0);
    check(drillPacks.length > 0, 'at least one pack has drills');
    const goldenPack = drillPacks.slice().sort((a, b) => a.drills.length - b.drills.length)[0];

    await page.click(`.rowbtn[data-pid="${cssEscape(goldenPack.id)}"]`);
    await page.waitForSelector('#top h1');
    const trackTitle = (await page.textContent('#top h1')).trim();
    check(trackTitle === goldenPack.label, `opening ${goldenPack.id} shows its own title in the top bar`,
      `got ${JSON.stringify(trackTitle)}, expected ${JSON.stringify(goldenPack.label)}`);

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
        await page.waitForSelector('#top h1');

        const bannerCount = await page.locator('.filterbanner').count();
        check(bannerCount > 0, 'practicing a rule from the glossary shows the "Practicing:" filter banner');
        const landedTitle = (await page.textContent('#top h1')).trim();
        const targetPack = DATA.packs.find((p) => p.id === targetPid);
        check(landedTitle === (targetPack ? targetPack.label : null),
          'practicing a glossary rule lands on the right track',
          `got ${JSON.stringify(landedTitle)}, expected ${JSON.stringify(targetPack && targetPack.label)}`);

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
    const progText = (await seedCard.locator('.prog').textContent()).trim();
    check(progText === `2/${pool.length}`,
      'seeded pack shows the right progress count, read back from lt-review:<id>',
      `got ${JSON.stringify(progText)}, expected "2/${pool.length}" (2 "got" grades)`);

    // Open it: it should resume at the first ungraded drill (index 3), not
    // restart at piece 1.
    await page.click(`.rowbtn[data-pid="${cssEscape(seedPack.id)}"]`);
    await page.waitForSelector('.cue');
    const cueText = (await page.textContent('.cue')).trim();
    check(cueText.indexOf(`piece 4 of ${pool.length}`) !== -1,
      'opening a seeded pack resumes at the first ungraded drill instead of restarting',
      `cue read ${JSON.stringify(cueText)}, expected to contain "piece 4 of ${pool.length}"`);

    // Grade the resumed drill, reload, and confirm it persisted.
    await page.click('#revealBtn');
    await page.click('#gotBtn');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.packcard');
    await page.click(`.rowbtn[data-pid="${cssEscape(seedPack.id)}"]`);
    await page.waitForSelector('.cue');
    const cueTextAfter = (await page.textContent('.cue')).trim();
    check(cueTextAfter.indexOf(`piece 5 of ${pool.length}`) !== -1,
      'a freshly graded drill survives a full page reload',
      `cue read ${JSON.stringify(cueTextAfter)}, expected to contain "piece 5 of ${pool.length}" - a grade did not persist`);

    check(pageErrors.length === 0, 'no page/console errors during the localStorage regression check',
      pageErrors.join('\n  '));
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
