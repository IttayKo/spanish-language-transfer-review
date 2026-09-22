#!/usr/bin/env node
// Upgrade test: does a learner's saved progress survive a deploy?
//
// Progress lives only in the browser's localStorage, keyed by pack id and
// drill id, with no server copy. So the thing a deploy must never do is
// change what an existing learner sees of their own progress. This drives
// the PREVIOUSLY SHIPPED build (the one real learners have progress in)
// through the UI - grading drills, ticking a track done - then swaps the
// served page for the NEW build at the same origin, the way a deploy lands,
// and checks that:
//   - every progress key is byte-for-byte what the old build wrote,
//   - the new build shows it (the done tick, the x/n count on a half-done
//     track), and
//   - reopening the half-done track resumes on the first ungraded drill.
//
// Usage: node scripts/upgrade_test.js OLD_INDEX_HTML NEW_INDEX_HTML
// (scripts/check.sh passes origin/main's index.html as the old build.)

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const REPO_ROOT = path.join(__dirname, '..');
const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error('usage: upgrade_test.js OLD_INDEX_HTML NEW_INDEX_HTML');
  process.exit(2);
}

let failed = false;
function check(cond, msg, detail) {
  if (cond) { console.log('PASS: ' + msg); return; }
  failed = true;
  console.error('FAIL: ' + msg + (detail ? ' (' + detail + ')' : ''));
}

const state = { html: fs.readFileSync(oldPath, 'utf-8') };
const newHtml = fs.readFileSync(newPath, 'utf-8');
const TYPES = { '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png' };

// Same shape as the real deploy: the page at "/", plus the real sw.js,
// manifest and icons, so the old build's service worker is in play when
// the new build lands - exactly as it is for an installed learner.
const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/sw.js' || urlPath === '/manifest.json' || urlPath.indexOf('/icons/') === 0) {
    fs.readFile(path.join(REPO_ROOT, urlPath), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(urlPath)] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }
  if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(state.html);
});

function progressKeys(page) {
  return page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.indexOf('lt-review') === 0) out[k] = localStorage.getItem(k);
    }
    return out;
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    // ---- as a learner on the old build ----
    await page.goto(base);
    await page.waitForSelector('.rowbtn');
    const data = await page.evaluate(() => JSON.parse(document.getElementById('pack-data').textContent));
    const byTrack = (n) => data.packs.find((p) => p.tracks[0] === n);
    const halfDone = byTrack(5), ticked = byTrack(3);

    // Grade the first three drills of a track (got, not yet, got) and leave.
    await page.click(`.rowbtn[data-pid="${halfDone.id}"]`);
    for (const ok of [true, false, true]) {
      await page.click('#revealBtn');
      await page.click(ok ? '#gotBtn' : '#stuckBtn');
    }
    await page.click('#topHomeBtn');
    // Tick another track done by hand.
    await page.click(`.donebtn[data-pid="${ticked.id}"]`);
    const before = await progressKeys(page);
    check(Object.keys(before).length >= 2, 'the old build wrote progress to seed the upgrade with',
      JSON.stringify(Object.keys(before)));

    // ---- the deploy lands ----
    state.html = newHtml;
    await page.reload();
    await page.waitForSelector('.rowbtn');
    // The embedded dataset is the cheapest fingerprint of which build is
    // running (the browser re-serialises the rest of the page).
    const embedded = (html) => (/<script id="pack-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html) || [])[1];
    const running = await page.evaluate(() => document.getElementById('pack-data').textContent);
    check(running === embedded(newHtml), 'the reload is running the new build, not a cached old one');

    const after = await progressKeys(page);
    check(JSON.stringify(after) === JSON.stringify(before),
      'every progress key is byte-for-byte what the old build wrote, after the new build loads',
      'before ' + JSON.stringify(before) + ' after ' + JSON.stringify(after));

    const tickedOn = await page.getAttribute(`.donebtn[data-pid="${ticked.id}"]`, 'aria-pressed');
    check(tickedOn === 'true', `the track ticked done on the old build (${ticked.id}) is still ticked`);
    const count = (await page.textContent(`.packcard[data-pid="${halfDone.id}"] .prog`) || '').trim();
    check(count === `2/${halfDone.drills.length}`, 'the half-done track still shows its got-count',
      `got "${count}", expected "2/${halfDone.drills.length}"`);

    await page.click(`.rowbtn[data-pid="${halfDone.id}"]`);
    const cue = (await page.textContent('.cue')) || '';
    check(/drill 4 of/.test(cue), 'reopening the half-done track resumes on the first ungraded drill', cue.trim());

    check(errors.length === 0, 'no page errors across the upgrade', errors.join(' | '));
  } catch (e) {
    check(false, 'upgrade test ran to completion', e.message);
  } finally {
    await browser.close();
    server.close();
  }
  process.exitCode = failed ? 1 : 0;
})();
