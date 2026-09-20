# Review pack format

A pack is one JSON file. The player reads nothing else.

## Top level

| Field | Required | Notes |
|---|---|---|
| `course` | yes | Shown in the header, e.g. `"Complete Spanish"`. |
| `tracks` | yes | Array of track numbers in the pack, ascending. Drives the filter chips. |
| `generated` | no | ISO date, for your own reference. |
| `rules` | yes | Array of rule objects. May be empty only if the tracks genuinely explain nothing new. |
| `drills` | yes | Array of drill objects. Non-empty for a normal teaching track. The one exception in this repo is track 1, the course's own introduction - it's pure orientation with no Spanish in it at all, so its pack has `rules` only (the Thinking Method's own principles, plus how to use this app) and an empty `drills` array. The player falls back to the Rules view for a pack with no drills, and the Drills tab shows an empty state rather than a quiz. Don't manufacture drills just to satisfy this row - an empty array is the honest choice when a track teaches no construction. |

## Rule object

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Short kebab-case slug, unique in the pack. Drills reference it. |
| `family` | yes (combined dataset) | The concept key shared by every copy of this rule across packs — see "One rule, many tracks" below. |
| `title` | yes | A phrase the learner would recognise, in plain words: `"The \"have\" past"`, not `"Present perfect"`. Write it so it still makes sense pulled out of its track and read in a list of every rule in the course. |
| `explanation` | yes | Two or three sentences in the teacher's derivational voice. Say what you *do*, in order. Mention where the form is useful if he did. |
| `examples` | strongly preferred | Array of short strings, ideally showing the derivation with arrows: `"hablar -> hablado -> he hablado"`. Use the ASCII `->`, not `→`. |
| `track` | yes | The track that introduced it — *not* the track this copy sits in. For a carried-forward copy these differ, and that difference is what marks it as a copy. |

The explanation is read after a failed drill, so it has to be enough to rebuild
the form from, not just enough to recognise it.

### One rule, many tracks: `family`

The course teaches a mechanism once and then genuinely comes back to it — the
future ending, gustar, where the little words sit. A later track that leans on
an earlier rule gets its **own copy** of that rule object, carrying the
introducing track's wording forward plus whatever this track adds, so a track's
Rules tab is self-contained and never sends the learner hunting backwards.

Every copy carries:

- the same `family` key (kebab-case, normally the id's slug with any
  `-2`/`-3` collision suffix stripped: `t41__would-tense-ia` and
  `t83__would-tense-ia` are both `family: "would-tense-ia"`),
- the same `track` — the track that *introduced* it,
- its own pack-namespaced `id`, and its own examples if this track's examples
  are better ones.

Exactly one copy of a family is the introduction: the one sitting in the pack
whose track equals its `track`. Every other copy has `track` lower than the
track of the pack it sits in.

`family` is what the app's glossary groups on, so it has to be right:

- **Never introduce the same rule twice under two slugs.** If a track revisits
  something already taught, copy the existing family forward — don't mint
  `tener-que-have-to` when `que-have-to` already exists. Two families with the
  same title is the tell.
- **Never merge two rules into one family because they look alike.** `e-split-ie`
  and `o-split-ue` are siblings, not the same rule.

## Drill object

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `"t21-04"` style. Unique; also the key for saved progress. |
| `type` | yes | `"sentence"` for a full-sentence drill, `"word"` for a single-word conversion. This is an internal distinction the app makes, not a term from the course. |
| `prompt` | yes | **English only.** Bracketed disambiguation is allowed: `"(informal)"`, `"(you plural)"`, `"(formal, plural)"`. |
| `answer` | yes | The teacher's confirmed Spanish, with accents and `¿ ¡`. |
| `steps` | sentence: yes | Ordered scaffolding, one per decision. Revealed one at a time on request. |
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
- a mix of types: word drills are quick wins, sentence drills carry the weight
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

House style, because the prompts are read one after another:

- A `sentence` prompt is a sentence: it starts with a capital and ends with its
  own `.` or `?`.
- A `word` prompt is the word or phrase to convert, so it takes **no** final
  full stop — neither does its answer.
- A disambiguating bracket goes **after** the sentence's own punctuation and
  ends the prompt: `"You see it. (formal)"`, not `"You see it (formal)."`.
- The vocabulary in that bracket is small and reused: `(informal)`,
  `(formal)`, `(formal, plural)`, `(informal order)`, `(emphatic)`,
  `(point in the past)`, `(right now)`, plus a content hint where the English
  is genuinely open (`(the door)`, `(using auto)`).
- Two drills may share a prompt only if they share an answer. If one English
  prompt has two right answers across the course — "I would have" for both
  *habría* and *tendría* — each says which it means.

## Steps

A step names the decision it is making, then shows what that decision
produces: `"not: no, right before es"`, `"put it together: se lo vendí"`.

A step that is only the Spanish hands over the answer without the move that
got there, which is the one thing the scaffolding exists for. Steps are
lowercase (unless they open with `I` or a name) and carry no final full stop.

## Combined dataset (this repo)

`data/combined-final.json` holds every pack merged together, one pack per
individual track (`{id: "t21", tracks: [21], ...}`), each rule id namespaced
per-pack (`t21__perfect-ado`) to avoid collisions across tracks and each rule
carrying the `family` key that links it to the other copies of the same rule
in other tracks, plus a
top-level `sections` array grouping tracks into 12 thematic parts with a
`start`/`end` track range and a one-sentence `focus` each, and a `blurb` field
per pack with a one-line description of what that track teaches. `app/build_app.py`
embeds this file directly into the player HTML.
