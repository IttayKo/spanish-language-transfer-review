# Complete Spanish — Review

A speaking-drill companion for Language Transfer's *Complete Spanish* audio
course, built strictly around its own "Thinking Method": you build the
Spanish yourself before you ever see it. Every drill is English in, spoken
Spanish out — no recognition, no multiple choice, no vocabulary lists. It
sits next to the audio course; it doesn't replace it.

**Two ways in, from the home screen:**

- **Tracks** (1–90, in 12 thematic sections) — open one, work its drills in
  the order the teacher gave them, reveal scaffolding a piece at a time, mark
  it done. Reopening resumes where you left off. "Recap practice" mixes
  drills from tracks you've covered, weighted toward what you got stuck on.
- **All rules** — the same ~250 grammar mechanisms in one searchable list,
  for when you remember the rule but not the track. The course teaches a
  mechanism once and keeps coming back to it, and each returning track gets
  its own self-contained copy (the `family` field in `pack-format.md` links
  copies of the same rule together); the glossary groups them back into one
  entry per concept, with a practice button per track that drills it.

Progress lives only in the browser's `localStorage` — there's no account and
no server copy, so clearing site data or switching devices loses it with no
way back. A low-key **"Back up or restore progress"** link at the bottom of
the track list downloads a small JSON file (grades + done-tracks, with a
schema/version marker) and can load one back in. Bringing a file back in
defaults to **merge** (union both sides, "got" always beats "stuck" on a
disagreement — never loses a result); **replace** wipes existing progress
first and is gated behind an explicit confirmation checkbox, so the
destructive option can never fire by accident. A bad or unrelated file is
rejected before anything is written.

**Design intent behind this repo — read before editing content or UI:**

- Nothing gets ahead of what the course has actually taught by that track:
  an extension drill uses only rules and vocabulary already introduced.
- Rules are written in the teacher's own derivational language ("take the
  -ar off and put -ado on"), never grammar-book terms.
- The UI stays plain on purpose: no gradients, emoji-as-icons, or decorative
  animation — a two-surface dark/paper palette, hairline-divided lists,
  bordered cards reserved for the two things that are genuinely separate
  objects (the prompt, the revealed answer).
- Track 1 (the course's own orientation) has no Spanish in it at all, so its
  pack is rules only, no drills — an honest empty array beats a manufactured
  quiz the transcript doesn't support. Track 90 (dialect variation) is the
  same idea applied more lightly: two drillable rules, two awareness-only
  ones left undrilled.

It installs to the home screen and works offline (an unofficial companion,
not a Language Transfer product) — the service worker always fetches the
page itself from the network first and only falls back to its cached copy
when there's no connection, so being installed never means being stuck on an
old build. See `app/sw.tmpl.js` for the update strategy and its kill switch.

**Live app:** `index.html` is one dependency-free file with the whole
dataset embedded — open it directly, or deploy it to any static host
(Vercel, GitHub Pages, ...). `manifest.json`, `sw.js` and `icons/` at the
repo root make it installable; they're static (or, for `sw.js`, generated —
see below) and need no build step of their own to serve.

## Working on it

Edit `app/lt-review-app.tmpl.html` (behavior/UI) and `data/combined-final.json`
(content), never `index.html` directly, then rebuild:

```bash
python3 app/build_app.py   # data/combined-final.json + the template -> index.html, sw.js
```

The same command also regenerates `sw.js` from `app/sw.tmpl.js`, stamping in
a build id hashed from the freshly built `index.html` — so any content or
code change ships a byte-different service worker, which is what makes the
browser pick it up as an update on its own. Edit `app/sw.tmpl.js`, never
`sw.js` directly. `manifest.json` and `icons/` are plain static files with no
build step of their own — edit them by hand (name, theme color, artwork).

- `skill/references/pack-format.md` — the full data schema (rule, drill,
  `family`, section).
- `skill/SKILL.md` — the methodology for mining new tracks from a transcript
  into that schema, and the constraints (don't run ahead, deduplicate
  firmly, don't pre-teach vocabulary) that keep new content consistent with
  what's already here.
- `skill/scripts/validate_pack.py` — structural checks for a pack before it
  goes in (Spanish leaking into an English prompt, unlinked rules, missing
  scaffolding).
- `skill/scripts/validate_dataset.py` — checks the invariants that only exist
  across the whole combined dataset, chiefly around `family`: every rule has
  one, exactly one copy per family is the introduction, and no two families
  introduce themselves under the same title (that's a rule taught twice under
  two slugs).

**Before shipping a content or template change, run `npm test`** (no install
step — it's a wrapper around `scripts/check.sh`, needs only python3 and
node). It runs `validate_pack.py` over all 90 packs, `validate_dataset.py`
across the dataset, a static check that the template still reads/writes the
`lt-review:<packId>` / `lt-review-done` localStorage keys real users'
progress lives in (there's no server copy — silently renaming either wipes
everyone) and that `app/sw.tmpl.js` still has its kill switch and
network-first document fetch, confirms `index.html` and `sw.js` are exactly
what `build_app.py` currently produces (reported as a warning while other
passes are still mid-flight, promotable to a hard failure with
`LT_STRICT_BUILD=1`), and drives the app in headless Chromium through opening
a track, grading a drill, reaching the summary, and practicing a rule from
the "All rules" glossary — plus seeding a known progress blob and confirming
it's read back and resumed correctly, a full export/import round trip
(including that a malformed file is rejected without touching existing
progress), and the PWA layer (manifest present, service worker takes
control, the app still renders while offline with progress intact, and —
the one failure mode that matters most here — a fresh build is actually
picked up the next time it's back online instead of the cached one), so a
build that breaks any of this fails loudly instead of shipping.
