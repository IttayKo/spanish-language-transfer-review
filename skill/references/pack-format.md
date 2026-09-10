# Review pack format

A pack is one JSON file. The player reads nothing else.

## Top level

| Field | Required | Notes |
|---|---|---|
| `course` | yes | Shown in the header, e.g. `"Complete Spanish"`. |
| `tracks` | yes | Array of track numbers in the pack, ascending. Drives the filter chips. |
| `generated` | no | ISO date, for your own reference. |
| `rules` | yes | Array of rule objects. May be empty only if the tracks genuinely explain nothing new. |
| `drills` | yes | Array of drill objects. Non-empty. |

## Rule object

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Short kebab-case slug, unique in the pack. Drills reference it. |
| `title` | yes | A phrase the learner would recognise, in plain words: `"The \"have\" past"`, not `"Present perfect"`. |
| `explanation` | yes | Two or three sentences in the teacher's derivational voice. Say what you *do*, in order. Mention where the form is useful if he did. |
| `examples` | strongly preferred | Array of short strings, ideally showing the derivation with arrows: `"hablar -> hablado -> he hablado"`. |
| `track` | yes | The track that introduced it. |

The explanation is read after a failed drill, so it has to be enough to rebuild
the form from, not just enough to recognise it.

## Drill object

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `"t21-04"` style. Unique; also the key for saved progress. |
| `type` | yes | `"build"` for a sentence, `"forge"` for a single-word conversion. |
| `prompt` | yes | **English only.** Bracketed disambiguation is allowed: `"(informal)"`, `"(you plural)"`, `"(formal, plural)"`. |
| `answer` | yes | The teacher's confirmed Spanish, with accents and `¿ ¡`. |
| `steps` | build: yes | Ordered scaffolding, one per decision. Revealed one at a time on request. |
| `rules` | yes | Array of rule ids. Shown under the answer as the "Why". |
| `track` | yes | Source track. |
| `source` | yes | `"track"` if the teacher said it, `"extension"` if you wrote it from the pack's rules. |
| `difficulty` | extensions: yes | 1 swap, 2 combine, 3 stretch. Ignored on transcript drills. |
| `note` | no | One line of extra colour from the teacher, e.g. a literal reading of an idiom. |
| `confidence` | no | `"low"` makes the player warn that the transcript is unclear here. Omit otherwise. |

## Ordering and volume

**The player does not shuffle.** It plays the file from top to bottom, so the
file order is the lesson plan. Within a track: transcript drills in the order the
teacher gave them, then the extensions ascending by difficulty. Tracks ascending.

Aim for roughly:

- 8-15 transcript drills per track, plus about a third that number of extensions
- 3-6 rules per track
- a mix of types: forge drills are quick wins, build drills carry the weight
- the last third of a track's transcript drills should combine two or more rules,
  because that's where the teacher takes the learner, and the difficulty-3
  extensions should go one step past it

These are ceilings, not quotas — a tight, well-chosen dozen beats a complete
inventory of every Q&A cycle in the transcript. When the teacher drills the
same rule on five near-identical words, that's a cue to pick the two or three
that show its range, not a mandate to transcribe all five.

## Prompt writing

The prompt is the only thing the learner sees while thinking, so it has to be
unambiguous English that maps to exactly one Spanish sentence in the material
taught so far.

Good: `"Why haven't you celebrated? (informal)"`
Bad: `"Why haven't you celebrated?"` — informal and formal both fit.
Bad: `"Why haven't you celebrated (using has)?"` — that's the answer.

Punctuate normally. Don't add the Spanish inverted marks to the English.

## Combined dataset (this repo)

`data/combined-final.json` holds every pack merged together, one pack per
individual track (`{id: "t21", tracks: [21], ...}`), each rule id namespaced
per-pack (`t21__perfect-ado`) to avoid collisions across tracks, plus a
top-level `sections` array grouping tracks into 10 thematic parts with a
`start`/`end` track range and a one-sentence `focus` each, and a `blurb` field
per pack with a one-line description of what that track teaches. `app/build_app.py`
embeds this file directly into the player HTML.
