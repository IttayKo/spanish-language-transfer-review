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
- The UI ("Primer"): ink on warm paper, and **no cards or boxes anywhere in
  the app**. Hierarchy comes from size, space and hairlines, the way a
  reference book makes it — the track list reads like a table of contents,
  the glossary like an index, the drill like a page that changes. One system
  sans (no serif/sans mix), a 4/8/12/16/24/32/48px spacing scale, 1.5px
  boundaries only where they're meaningful (a control or its state) and
  thin decorative hairlines everywhere else, no shadows, no gradients, no
  emoji-as-icons, hover states that change colour rather than move anything.
  Colour is testimony, not flavour: **blue** means "this is live, act on it"
  (links, rule cross-references), **brick** means "this is a fact about
  reliability" (*not from the recording*, and the **Not yet** grade) — those
  are the only two coloured inks in the app. The one event is the reveal: the
  page re-composes in place (the English prompt drops to context size, the
  Spanish takes the position and scale it just occupied) rather than a panel
  sliding in. Full rationale and the computed contrast ratios behind every
  colour token live in the redesign notes this shipped from; ask if you need
  them.
- **A drill never scrolls.** The track list and the glossary are documents
  and scroll like documents; a drill is an app screen, so the running head,
  the drill itself and the two grade buttons live inside exactly one
  viewport and the page is locked against scrolling while you're in one.
  Nothing is clipped or truncated to achieve that: `fitDrill()` measures the
  stage after every reveal and gives things up in a fixed order until it
  fits — whitespace first (a tight screen still reads as the same screen),
  then type, and only on a screen short enough that neither was enough, the
  periphery (four wrapped rule titles collapse to one "4 rules" link to the
  same place, the teacher's aside folds away, the hint rows give up their
  breathing room). The grade buttons sit outside the measured area, so the
  two things you press most never shrink at all. Held sideways, where there
  is width and no height, the drill becomes two columns — prompt and answer
  left, hints right — rather than shrinking. On a normal phone almost every
  drill sits at full size; only the densest reach down the ladder at all.
  **Anything added to the drill screen has to earn its height**, and
  `npm test` says so if it didn't.
- **Three backs, three different things, and they say which.** `← Tracks`
  at the top leaves the track. `← Back a drill`, on the cue line, steps back
  through the queue and reopens that drill fresh — going back is another go,
  not a replay. `Take that back`, at the other end of the same line, only
  unwinds what you've revealed on the drill you're on: the answer first,
  then the hints one at a time, and it disappears when there's nothing left.
  It used to mean all three depending on what happened to be on screen, so
  pressing it once too often silently left the drill you were working on;
  `npm test` now presses it well past the end and fails if it moves.
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

**`/demo`** is the same build with one flag flipped (`demo/index.html`, also
generated by `build_app.py`): it opens with sample progress already in it —
tracks 1–24 finished, 25 half-done, a scatter of "not yet" grades behind
them — so someone sent a link lands on a worked-in app rather than an empty
list, with the progress bar, the recap and the mid-track counts all showing
something. It writes to its own `lt-review-demo:*` keys, never the real
ones. That matters more than it sounds: the demo shares an origin, and so a
localStorage, with the app, so a demo that seeded the real keys would
silently overwrite the saved progress of anyone who already uses it — and
there's no server copy to restore from. `npm test` lays down real progress,
opens `/demo` in the same browser profile, and fails if so much as a byte of
it moved. The demo is not installable and registers no service worker.

## Working on it

Edit `app/lt-review-app.tmpl.html` (behavior/UI) and `data/combined-final.json`
(content), never `index.html` directly, then rebuild:

```bash
python3 app/build_app.py   # data/combined-final.json + the template -> index.html, demo/index.html, sw.js
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
network-first document fetch, takes the six densest drills in the dataset
across seven viewports (a 320x568 phone through to a phone held sideways)
with every hint revealed and the answer shown and asserts that the drill
screen neither scrolls nor clips and keeps the grade buttons in view,
confirms `index.html` and `sw.js` are exactly
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
