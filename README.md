# Complete Spanish — Review

A single-page review app for the Language Transfer "Complete Spanish" audio
course: 90 tracks (1–90), grouped into 12 thematic sections, each with rules
(grammar explanations in the teacher's own derivational language) and
speaking drills (English prompt in, spoken Spanish out — never the reverse).

**All rules**, reached from the top bar of the track list, is the whole
course's grammar in one searchable place, for when you remember the rule but
not which track taught it. The course teaches a mechanism once and then keeps
coming back to it, and every track that leans on an earlier rule carries its
own copy so its Rules tab stands alone — so the glossary groups those copies
by the rule's `family` and shows each of the 246 concepts once: the fullest
wording any track gives it, every track it comes back in, any track that words
it differently, and a button per track to practice it with that track's drills.

**Live app:** open `index.html` directly, or deploy it as a static site (see
below) — it's one self-contained file with the entire dataset embedded, no
build step, no server, no dependencies.

## What's in this repo

| Path | What it is |
|---|---|
| `index.html` | The finished app — one file, fully self-contained, ready to deploy as-is. |
| `app/lt-review-app.tmpl.html` | The source template (CSS + JS) with a `__DATA_JSON__` placeholder in place of the embedded dataset. Edit this, not `index.html`, when changing behavior. |
| `app/build_app.py` | Substitutes `data/combined-final.json` into the template to (re)produce `index.html`. |
| `app/merge.py` | Combines a directory of per-track-range pack JSON files into one dataset, namespacing rule ids per pack to avoid id collisions. |
| `app/split_per_track.py` | Splits a merged multi-track-range dataset into one pack per individual track. |
| `app/enrich.py` | Adds each track's one-line description (`blurb`) and section grouping (`sectionIndex`) to the dataset. |
| `data/combined-final.json` | The full dataset: 90 packs (one per track), each with its rules + drills (each rule carrying the `family` key that links it to its copies in other tracks), plus a top-level `sections` array (12 thematic groupings) and per-track blurbs. This is what's embedded into `index.html`. Track 1 is the course's own introduction (Thinking Method philosophy, no Spanish yet) and has no drills — see the note in `pack-format.md`. |
| `skill/SKILL.md` | The methodology used to mine rules/drills from the raw course transcript into pack JSON — read this before generating packs for a different course or additional tracks. |
| `skill/references/pack-format.md` | Full schema reference for a pack JSON file. |
| `skill/scripts/extract_track.py` | Pulls a track range out of a transcript file (plain text or PDF). |
| `skill/scripts/validate_pack.py` | Validates a pack JSON file before merging it in — catches English prompts leaking Spanish, unlinked rules, missing scaffolding. |

## Regenerating the app after editing data or the template

```bash
cd app
python3 build_app.py   # reads ../data/combined-final.json + lt-review-app.tmpl.html -> writes ../index.html
```

## Deploying

This is a static site — one HTML file, no build step. Any static host works:

- **Vercel:** `vercel --prod` from the repo root (uses `vercel.json`'s
  `cleanUrls` setting), or drag-and-drop the repo/`index.html` at
  [vercel.com/new](https://vercel.com/new).
- **GitHub Pages:** enable Pages on this repo, serving from the root of the
  default branch — `index.html` is already at the root.
- **Anything else:** any static file host will serve `index.html` as-is.

## Adding more tracks or a different course

Follow `skill/SKILL.md` end to end: extract the relevant track range with
`extract_track.py`, mine rules/drills per the methodology, validate with
`validate_pack.py`, then run `merge.py` → `split_per_track.py` → `enrich.py` →
`build_app.py` to fold the new pack(s) into `data/combined-final.json` and
regenerate `index.html`.
