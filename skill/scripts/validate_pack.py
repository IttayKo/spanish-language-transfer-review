#!/usr/bin/env python3
"""Check a review pack before it goes into the player.

The one failure that actually damages the method is Spanish appearing on the
front of a drill, because then the learner reads instead of building. That is
checked hardest here. Everything else is structural.

Usage:
  python3 validate_pack.py pack.json
"""

import argparse
import json
import re
import sys

SPANISH_MARKERS = {
    "el", "la", "los", "las", "un", "una", "unos", "unas", "que", "qué", "de",
    "del", "y", "es", "está", "estoy", "soy", "hemos", "han",
    "lo", "le", "te", "se", "nos", "para", "por", "con", "pero",
    "muy", "mucho", "más", "cómo", "dónde", "cuándo", "porque", "quiero",
    "puedo", "tengo", "hay", "está", "ser", "estar", "hacer", "tener",
}
# These are Spanish too, but they are also ordinary English words, so on their
# own they say nothing. They only count once a real marker is already present -
# otherwise a plain English prompt like "He has given me something" gets failed
# and has to be written around, which damages the prompt to please the checker.
AMBIGUOUS_MARKERS = {"he", "has", "ha", "me", "no", "a", "son", "van", "ven", "sea"}
ACCENTS = re.compile(r"[áéíóúñü¿¡]", re.IGNORECASE)
WORDS = re.compile(r"[a-záéíóúñü]+", re.IGNORECASE)


def spanish_leak(text):
    """Return the reason this English prompt looks like it contains Spanish."""
    if ACCENTS.search(text):
        return "contains Spanish characters or punctuation"
    words = [w for w in WORDS.findall(text.lower())]
    hits = {w for w in words if w in SPANISH_MARKERS}
    if hits:
        hits |= {w for w in words if w in AMBIGUOUS_MARKERS}
    if len(hits) >= 2:
        return f"contains Spanish words: {', '.join(sorted(hits))}"
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pack", help="path to the pack JSON file")
    args = parser.parse_args()

    try:
        with open(args.pack, encoding="utf-8") as handle:
            pack = json.load(handle)
    except json.JSONDecodeError as exc:
        sys.exit(f"FAIL: not valid JSON - {exc}")

    errors, warnings = [], []

    for field in ("course", "tracks", "rules", "drills"):
        if field not in pack:
            errors.append(f"missing top-level field: {field}")
    if errors:
        print("\n".join("ERROR: " + e for e in errors))
        sys.exit(1)

    rule_ids = set()
    for i, rule in enumerate(pack["rules"]):
        where = f"rules[{i}]"
        for field in ("id", "title", "explanation", "track"):
            if not rule.get(field):
                errors.append(f"{where}: missing {field}")
        rid = rule.get("id")
        if rid in rule_ids:
            errors.append(f"{where}: duplicate rule id {rid}")
        rule_ids.add(rid)
        if not rule.get("examples"):
            warnings.append(f"{where} ({rid}): no examples, the rule will read abstractly")

    drill_ids = set()
    used_rules = set()
    for i, drill in enumerate(pack["drills"]):
        where = f"drills[{i}]"
        for field in ("id", "type", "prompt", "answer", "track"):
            if not drill.get(field):
                errors.append(f"{where}: missing {field}")
        did = drill.get("id")
        if did in drill_ids:
            errors.append(f"{where}: duplicate drill id {did}")
        drill_ids.add(did)

        if drill.get("type") not in ("build", "forge"):
            errors.append(f"{where}: type must be 'build' or 'forge'")

        leak = spanish_leak(drill.get("prompt", ""))
        if leak:
            errors.append(f"{where} ({did}): prompt {leak} -> {drill.get('prompt')!r}")

        for rid in drill.get("rules", []):
            used_rules.add(rid)
            if rid not in rule_ids:
                errors.append(f"{where} ({did}): unknown rule id {rid}")
        if not drill.get("rules"):
            warnings.append(f"{where} ({did}): not linked to any rule")
        if drill.get("type") == "build" and not drill.get("steps"):
            warnings.append(f"{where} ({did}): no steps, so there is nothing to scaffold with")

        source = drill.get("source", "track")
        if source not in ("track", "extension"):
            errors.append(f"{where} ({did}): source must be 'track' or 'extension'")
        if source == "extension" and drill.get("difficulty") not in (1, 2, 3):
            warnings.append(f"{where} ({did}): extension without a difficulty of 1, 2 or 3")

    # The player plays the file in order, so the order has to teach.
    order = [(d.get("track"), d.get("source", "track"), d.get("difficulty"), d.get("id"))
             for d in pack["drills"]]
    seen_tracks = []
    for track, source, difficulty, did in order:
        if track not in seen_tracks:
            seen_tracks.append(track)
    if seen_tracks != sorted(seen_tracks, key=lambda t: (t is None, t)):
        warnings.append(f"tracks are not in ascending order: {seen_tracks}")
    for track in seen_tracks:
        rows = [r for r in order if r[0] == track]
        sources = [r[1] for r in rows]
        if "track" in sources and "extension" in sources:
            if sources.index("extension") < len(sources) - sources[::-1].index("track"):
                warnings.append(f"track {track}: extension drills are mixed in among the transcript drills")
        diffs = [r[2] for r in rows if r[1] == "extension" and r[2]]
        if diffs != sorted(diffs):
            warnings.append(f"track {track}: extension drills are not ordered by difficulty")

    for rid in sorted(rule_ids - used_rules):
        warnings.append(f"rule {rid} has no drills")

    for w in warnings:
        print("WARN:  " + w)
    for e in errors:
        print("ERROR: " + e)

    counts = {}
    for drill in pack["drills"]:
        key = drill.get("track")
        slot = counts.setdefault(key, [0, 0])
        slot[0 if drill.get("source", "track") == "track" else 1] += 1
    summary = ", ".join(
        f"track {t}: {n[0]} from the transcript + {n[1]} extra"
        for t, n in sorted(counts.items(), key=lambda x: str(x[0]))
    )
    print(f"\n{len(pack['rules'])} rules, {len(pack['drills'])} drills ({summary})")

    if errors:
        print("FAIL")
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
