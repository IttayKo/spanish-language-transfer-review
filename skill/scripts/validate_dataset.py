#!/usr/bin/env python3
"""Check invariants that only exist across the whole combined dataset.

`validate_pack.py` checks one pack in isolation and can't see these: it has
no way to know that a rule id it doesn't recognise belongs to another track's
copy of the same family, or that two "different" rules are actually the same
mechanism introduced twice under different slugs. This script reads the
combined dataset and checks the cross-pack invariants documented in
`skill/references/pack-format.md` under "One rule, many tracks: `family`".

Checks:
  - every rule has a non-empty `family`
  - exactly one copy per family is the introducing copy (the copy sitting in
    the pack whose track equals the rule's own `track`)
  - every other copy has `track` lower than the track of the pack it sits in
  - no two distinct families share an introducing `title` (the tell for the
    same rule being introduced twice under two slugs)
  - no drill references a rule id that doesn't exist in its own pack

Usage:
  python3 validate_dataset.py data/combined-final.json
"""

import argparse
import json
import sys
from collections import defaultdict


def pack_track(pack):
    """The single track this pack sits in (combined dataset: one per pack)."""
    tracks = pack.get("tracks") or []
    return tracks[0] if tracks else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", help="path to the combined dataset JSON file")
    args = parser.parse_args()

    try:
        with open(args.dataset, encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        sys.exit(f"FAIL: not valid JSON - {exc}")

    packs = data.get("packs")
    if not isinstance(packs, list) or not packs:
        sys.exit("FAIL: no top-level 'packs' array")

    errors, warnings = [], []

    # family -> list of {packId, packTrack, rule}
    families = defaultdict(list)
    for pack in packs:
        pid = pack.get("id", "?")
        pt = pack_track(pack)
        for i, rule in enumerate(pack.get("rules") or []):
            where = f"{pid}.rules[{i}] ({rule.get('id','?')})"
            fam = rule.get("family")
            if not fam:
                errors.append(f"{where}: missing/empty family")
                continue
            families[fam].append({"packId": pid, "packTrack": pt, "rule": rule})

    # Exactly one introducing copy per family; every other copy's `track`
    # must be lower than the track of the pack it sits in.
    for fam, copies in sorted(families.items()):
        introducing = [c for c in copies if c["rule"].get("track") == c["packTrack"]]
        if len(introducing) == 0:
            tracks = sorted({c["packTrack"] for c in copies})
            errors.append(
                f"family {fam!r}: no introducing copy (no copy sits in the "
                f"track its own `track` names; copies sit in {tracks})"
            )
        elif len(introducing) > 1:
            where = ", ".join(f"{c['packId']} (track {c['rule'].get('track')})" for c in introducing)
            errors.append(f"family {fam!r}: {len(introducing)} introducing copies - {where}")

        for c in copies:
            if c["rule"].get("track") != c["packTrack"] and c["packTrack"] is not None:
                if not (isinstance(c["rule"].get("track"), int) and c["rule"]["track"] < c["packTrack"]):
                    errors.append(
                        f"family {fam!r}: copy in {c['packId']} (pack track {c['packTrack']}) "
                        f"has rule.track={c['rule'].get('track')!r}, expected it lower than the "
                        f"pack's own track"
                    )

    # No two distinct families share an introducing title.
    title_to_families = defaultdict(set)
    for fam, copies in families.items():
        introducing = [c for c in copies if c["rule"].get("track") == c["packTrack"]]
        for c in introducing:
            title = c["rule"].get("title")
            if title:
                title_to_families[title].add(fam)
    for title, fams in sorted(title_to_families.items()):
        if len(fams) > 1:
            errors.append(
                f"title {title!r} is the introducing title of {len(fams)} distinct families "
                f"({', '.join(sorted(fams))}) - looks like the same rule introduced twice under "
                f"two slugs"
            )

    # No drill references a rule id that doesn't exist in its own pack.
    # (validate_pack.py checks this too when run per-pack; kept here as a
    # cheap, self-contained defense that needs no extraction step.)
    for pack in packs:
        pid = pack.get("id", "?")
        rule_ids = {r.get("id") for r in (pack.get("rules") or [])}
        for i, drill in enumerate(pack.get("drills") or []):
            for rid in drill.get("rules") or []:
                if rid not in rule_ids:
                    errors.append(
                        f"{pid}.drills[{i}] ({drill.get('id','?')}): references rule id "
                        f"{rid!r} which is not in its own pack"
                    )

    for w in warnings:
        print("WARN:  " + w)
    for e in errors:
        print("ERROR: " + e)

    print(f"\n{len(packs)} packs, {len(families)} rule families")

    if errors:
        print("FAIL")
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
