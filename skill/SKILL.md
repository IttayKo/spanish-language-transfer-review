---
name: lt-review-pack
description: Build a review pack (rules + speaking drills) from chosen tracks of a Language Transfer audio-course transcript, and hand back the offline player app that loads it. Use this whenever someone mentions Language Transfer, the "thinking method", LT tracks, or asks to revise, drill, review, or make practice material from a track or range of tracks of a Complete/Introduction transcript PDF — including phrasings like "make me something to practise tracks 12-15", "I finished track 30, help me review it", or "turn this transcript into drills". Also use it when someone wants to check what rules a track covered.
---

# Language Transfer review packs

Language Transfer courses are audio-first and built on a specific discipline: the
learner reconstructs sentences from rules rather than memorising them. The course
intro is explicit — don't memorise, don't write anything down, don't look at the
transcript while building a sentence, think slowly, and expect to forget things
because the course revisits them by design.

That constraint decides everything about this skill. The output is **not** a
flashcard deck, a vocabulary list, or a conjugation table. It is a pack of
**construction drills** (English in, spoken Spanish out) plus the **rules** those
drills rest on, in the teacher's own derivational language. The player app shows
the English prompt alone, offers the teacher's scaffolding piece by piece if
asked, and only then reveals the target sentence.

Anything that lets the learner read the target language before producing it
defeats the whole exercise. Guard that above all else.

The pack teaches **rules**, not a word list. A word doesn't need to have earned
its own drill before it's allowed to appear inside a sentence — see the
"Don't pre-teach vocabulary" judgement call below.

## Companion files

This repo bundles everything the skill needs: `skill/scripts/` (extraction +
validation), `skill/references/pack-format.md` (schema reference), and the app
itself (`index.html` / `app/`) which loads the combined pack data in
`data/combined-final.json`.

If a plain-text transcript is already available (e.g.
`complete-spanish-transcript.txt`), use it — it's ready to search and slice
directly, no PDF tooling needed. Only fall back to a PDF transcript if no
plain-text one is available.

**Efficiency note:** once packs already exist for a track (rules + drills, as
in `data/combined-final.json`), prefer mining information from those existing
packs over re-reading the original transcript for tasks like writing one-line
summaries, grouping tracks into sections, or auditing coverage — the packs are
already a dense, curated distillation of the transcript and cost far fewer
tokens to read.

## Workflow

### 1. Find the transcript and the tracks

Ask which tracks if they weren't named. Tracks are the natural unit — one track
is roughly 8 pages and yields 8-15 drills, which is a 5-8 minute review session.
Two or three tracks is a comfortable pack. More than five and the session stops
being reviewable in one sitting.

### 2. Pull just those tracks

The transcript can run to hundreds of pages. Never read it whole; it will bury
the context window and the extra tracks would leak later material into the pack.

```bash
python3 skill/scripts/extract_track.py --txt TRANSCRIPT.txt --list
python3 skill/scripts/extract_track.py --txt TRANSCRIPT.txt --tracks 21-23 --out ./tracks
```

(Use `--pdf TRANSCRIPT.pdf` instead of `--txt` only if there's no plain-text
transcript available.)

The script finds each `Track N` heading in the text itself rather than trusting
a printed table of contents, which is known to omit at least one track in the
2019 Spanish edition.

### 3. Read each track in full, then mine it

Read the whole track before writing anything. The teacher usually states a rule
once and then exercises it for several pages; if you mine from the top you'll
write drills whose reasoning you haven't met yet.

**Rules.** Capture each thing the teacher explains as a mechanism. Write the
explanation the way he says it: "take the -ar off and put -ado on", "the e
split", "lo jumps out to the front". Do not translate it into grammar-book
terminology — no "diphthongisation", no "present perfect", no "clitic". The
jargon-free phrasing is not a stylistic preference, it's the thing that makes the
rule usable while speaking. Include the concrete examples he used.

**Drills.** Every point where the teacher asks and the student produces is a
drill. Take these three fields from the transcript:

- `prompt` — the English the teacher gave. Add a bracketed hint only where the
  Spanish would otherwise be ambiguous, e.g. "(informal)" or "(you plural)".
- `answer` — the teacher's confirmed version, never the student's first attempt.
  Students misfire constantly and the teacher corrects them; the corrected form
  is the answer.
- `steps` — the sub-prompts the teacher used to break the sentence down, in
  order. These become the scaffolding. If the teacher didn't break it down,
  write the steps in his voice anyway, one per decision the learner has to make.

Single-word conversions ("how would you say celebration?") are `type: "word"`
drills. Sentences are `type: "sentence"`. (This split is the app's own
bookkeeping, not a distinction the course draws — don't present it to the
learner as if it were.) But don't manufacture a word drill just to introduce a
word ahead of a sentence drill that needs it — see "Don't pre-teach vocabulary"
below. Only capture a word drill when the teacher genuinely drilled that word
or phrase on its own.

Mark everything taken from the transcript `"source": "track"`.

### 4. Order the drills the way the track ordered them

**The player never shuffles.** It plays the file top to bottom, because the
build-up is the teaching: a track introduces a rule on a two-word answer, then
stretches it, then folds in something from earlier, and by the end the learner is
saying a full sentence they couldn't have said at the start. Shuffling flattens
that into a quiz.

So keep transcript order within a track, and put tracks in ascending order. If
you drop drills, don't reorder the survivors to "group similar things". The one
allowed adjustment: if a drill depends on a rule the pack introduces later, move
it after that rule's first drill.

### 5. Extend past the transcript

The track's own sentences get memorised after a couple of passes, and a rule you
can only apply to the four sentences you heard isn't a rule yet. So after each
track's own drills, add fresh ones the teacher never said. Roughly one extension
for every three transcript drills — a handful that show a rule's range, not a
full second pass over the material.

Extensions are built under hard constraints, because inventing freely would drag
in material the course hasn't reached and break its ordering:

- **Only rules already in the pack**, or rules from earlier tracks the learner
  has certainly met. Nothing from later tracks. No new tense, no new pronoun, no
  new sentence pattern.
- **Only vocabulary the learner can derive or has been given.** Words reachable
  through a conversion rule in the pack are ideal, since producing them is
  itself the skill. If a sentence needs a word that isn't derivable, hand it over
  in `steps` the way the teacher does — "the word for tomorrow is mañana" — and
  use it sparingly. This is about the word being derivable, not about it having
  already appeared in an earlier drill — see "Don't pre-teach vocabulary" below.
- **Everyday and sayable.** Prefer sentences the learner might actually use this
  week over grammar-demonstration sentences. This is where a pack earns its keep.

Grade them upward with `difficulty` 1 to 3, in this order:

1. **Swap.** Same shape as a transcript drill, new content. Exercises one rule.
2. **Combine.** Two rules the track kept apart, now in one sentence.
3. **Stretch.** Six to ten words, two or three rules, including at least one from
   an earlier track. These are the ones that feel like speaking.

Mark every one `"source": "extension"` and place them after that track's
transcript drills, ascending by difficulty. The player labels them so the learner
knows they've left the recording behind.

### 6. Judgement calls

- **Don't pre-teach vocabulary.** A word doesn't need its own word drill just
  because it's about to appear inside a sentence drill a moment later — the
  sentence drill's `steps` can derive it right there in context ("to prepare:
  preparar, from preparación — drop -ción, add r"). The pack teaches rules, not
  a stockpile of words you must meet individually before you're allowed to use
  them in a phrase. Only give a word its own word drill when the teacher
  genuinely drilled it standalone (or when it's worth exercising the rule on its
  own before combining it with anything else) — not as a rehearsal step before
  the sentence that was going to use it anyway.
- **Skip chatter.** Asides, jokes, donation appeals, and the student thinking out
  loud aren't drills.
- **Skip anything the teacher explicitly parks.** He often says a word or form is
  coming later. If it isn't taught in these tracks, it doesn't go in the pack.
- **Don't run ahead.** No fuller paradigm, no "while we're here, the other forms
  are…". The order of the course is the method, and material from track 40 in a
  track 21 pack breaks it. New sentences are welcome (step 5); new machinery is
  not. If you can't build an extension without reaching forward, drop it.
- **Don't silently fix Spanish.** The transcripts are volunteer-made and contain
  real errors. If the transcript's Spanish looks wrong or the exchange is
  garbled, either drop the drill or keep it with `"confidence": "low"`, which
  makes the player warn the learner rather than teach them an error.
- **Deduplicate firmly.** The teacher drills the same form many times on
  purpose, but the pack doesn't need to. When several drills exercise the same
  rule on near-identical vocabulary — six -ción nouns in a row, say — keep the
  two or three that best show the rule's range and cut the rest. A pack that
  transcribes every single Q&A cycle is exhausting, not thorough; the goal is a
  session someone will actually finish, not an inventory of the track.
- **Carry earlier rules forward.** A late sentence often leans on a rule from an
  earlier track. Link it in `rules` if you have that rule in the pack; if not,
  put the reminder in `steps`.

### 7. Write and validate the pack

Full schema and a worked example: `skill/references/pack-format.md`. A minimal
drill:

```json
{
  "id": "t21-04",
  "type": "sentence",
  "prompt": "We have anticipated it for a long time.",
  "answer": "Lo hemos anticipado por mucho tiempo.",
  "steps": ["we have anticipated it: lo hemos anticipado, with lo out at the front",
            "for: por", "a lot, much: mucho", "time: tiempo, from tempo with the e split"],
  "rules": ["perfect-ado", "pronoun-jump", "por-time"],
  "track": 21,
  "source": "track"
}
```

An extension drill built on the same rules:

```json
{
  "id": "t21-x03",
  "type": "sentence",
  "prompt": "Why haven't you invited my brother? (informal)",
  "answer": "¿Por qué no has invitado a mi hermano?",
  "steps": ["why: por qué", "no at the front", "you: has", "invitar becomes invitado",
            "people take a before them: a mi hermano"],
  "rules": ["perfect-ado"],
  "track": 21,
  "source": "extension",
  "difficulty": 3
}
```

Then always run:

```bash
python3 skill/scripts/validate_pack.py pack.json
```

It fails on Spanish leaking into a prompt, which is the one error that actually
damages the learner's practice, and warns about unlinked rules and missing
scaffolding.

### 8. Merge into the app

`app/merge.py` combines a directory of per-range pack JSON files into one
dataset, namespacing rule ids per pack to avoid collisions. `app/split_per_track.py`
further splits that into one pack per individual track (matching how this
app's home screen is organized — one row per track rather than per batch).
`app/enrich.py` adds each track's one-line description and section grouping.
`app/build_app.py` embeds the final combined JSON directly into
`app/lt-review-app.tmpl.html`, producing the standalone `index.html` this repo
serves.

## What this skill will not produce

If asked for these, explain the conflict and offer the drill pack instead:

- Spanish-to-English cards, or multiple choice. Both are recognition. The course
  trains production.
- Vocabulary lists. Vocabulary in this course arrives through conversion rules,
  so `word` drills on the rules are the equivalent and are endlessly extendable.
- Conjugation tables. The course deliberately avoids presenting paradigms as
  grids; it builds each form from a rule.
- Timers, speed scoring, or streaks. "Think slowly to learn quickly" is a direct
  instruction from the course, and speed pressure contradicts it.
- A pack to use *during* a track. Packs are for after listening. If someone wants
  help mid-track, point them back to the audio.
