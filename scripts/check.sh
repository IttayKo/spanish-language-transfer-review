#!/usr/bin/env bash
# One command, the whole quality check: per-pack validation, cross-pack
# dataset invariants, a static guard on the localStorage progress keys, a
# build-reproducibility check, and a browser smoke test of the golden path.
#
# Usage: scripts/check.sh
#   LT_STRICT_BUILD=1 scripts/check.sh   # promote the build-drift check to a hard failure
#
# Needs only python3 and node - no npm install, no node_modules. Playwright
# and Chromium are pre-installed outside this project (see the browser step).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

PASS=0
FAIL=0
SOFT_FAIL=0

section() { printf '\n=== %s ===\n' "$1"; }

ok()   { PASS=$((PASS+1)); printf 'OK: %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL: %s\n' "$1"; }
soft() { SOFT_FAIL=$((SOFT_FAIL+1)); printf 'WARN (not counted as failure yet): %s\n' "$1"; }

# ---------------------------------------------------------------------------
section "Static guard: the localStorage progress contract still exists"
# Belt-and-braces for the case where someone refactors the storage functions
# and the browser test's seed data quietly stops matching what the app reads.
# The real behavioural check is the Playwright test below; this is just a
# fast, blunt tripwire. Real users' progress lives ONLY in localStorage under
# these two key shapes - renaming either wipes it for everyone with no error.
TMPL="app/lt-review-app.tmpl.html"
if grep -q '"lt-review:"' "$TMPL" && grep -q '"lt-review-done"' "$TMPL"; then
  ok "template still reads/writes localStorage keys lt-review:<packId> and lt-review-done"
else
  bad "template no longer contains the literal localStorage key names 'lt-review:' and/or 'lt-review-done' in $TMPL -- if this is an intentional rename, every existing user's saved progress is about to be silently wiped. Update the key AND ship a migration, don't just rename it."
fi

# Same idea for the PWA layer: a network-first document fetch and a real
# kill switch are the two things standing between a bad service worker
# deploy and permanently stale installed clients.
SW_TMPL="app/sw.tmpl.js"
if grep -q 'KILL_SWITCH' "$SW_TMPL" && grep -q 'networkFirstDocument' "$SW_TMPL"; then
  ok "sw.tmpl.js still has a kill switch and a network-first document fetch"
else
  bad "$SW_TMPL no longer contains the KILL_SWITCH toggle and/or the networkFirstDocument strategy -- a service worker that caches the document without a network-first refresh and a way to disable it can pin real users to a stale build forever."
fi

# ---------------------------------------------------------------------------
section "Saved progress: every pack and drill id that ever shipped still exists, in the same pack"
# Progress is keyed by pack id and drill id and lives only in each learner's
# browser. Renaming or dropping an id - or moving a drill to another pack -
# silently orphans every grade saved against it, with no server copy to
# restore from. data/shipped-ids.json is the append-only record of every id
# that has shipped; content edits may add ids, never remove or move one.
if python3 - "$ROOT/data/combined-final.json" "$ROOT/data/shipped-ids.json" <<'PYEOF'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
shipped = json.load(open(sys.argv[2], encoding="utf-8"))["packs"]
now = {p["id"]: {d["id"] for d in p["drills"]} for p in data["packs"]}
problems = []
for pid, drill_ids in shipped.items():
    if pid not in now:
        problems.append(f"pack {pid} is gone")
        continue
    for did in drill_ids:
        if did not in now[pid]:
            problems.append(f"drill {did} is no longer in pack {pid}")
for line in problems[:20]:
    print("  " + line)
sys.exit(1 if problems else 0)
PYEOF
then
  ok "every shipped pack id and drill id is still present in its pack - saved progress stays attached"
else
  bad "ids that saved progress is keyed by have disappeared or moved (see above) -- learners' grades for them would be silently orphaned. Restore the ids; to retire a drill, keep its id or ship a migration."
fi

# ---------------------------------------------------------------------------
section "Per-pack validation (skill/scripts/validate_pack.py x 90)"
PACK_TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$PACK_TMP_DIR" "${BUILD_TMP_DIR:-}"' EXIT

python3 - "$ROOT/data/combined-final.json" "$PACK_TMP_DIR" <<'PYEOF'
import json, os, sys
dataset_path, out_dir = sys.argv[1], sys.argv[2]
with open(dataset_path, encoding="utf-8") as f:
    data = json.load(f)
course = data.get("course")
for pack in data["packs"]:
    shaped = {
        "course": course,
        "tracks": pack.get("tracks", []),
        "rules": pack.get("rules", []),
        "drills": pack.get("drills", []),
    }
    out_path = os.path.join(out_dir, pack["id"] + ".json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(shaped, f, ensure_ascii=False)
print(len(data["packs"]))
PYEOF
if [ $? -ne 0 ]; then
  bad "could not extract packs from data/combined-final.json for per-pack validation"
else
  pack_errors=0
  pack_count=0
  for f in "$PACK_TMP_DIR"/*.json; do
    pack_count=$((pack_count+1))
    out="$(python3 skill/scripts/validate_pack.py "$f" 2>&1)"
    if [ $? -ne 0 ]; then
      pack_errors=$((pack_errors+1))
      printf -- '--- %s ---\n%s\n' "$(basename "$f" .json)" "$out"
    fi
  done
  if [ "$pack_errors" -eq 0 ]; then
    ok "all $pack_count packs pass validate_pack.py"
  else
    bad "$pack_errors of $pack_count packs failed validate_pack.py (see output above)"
  fi
fi

# ---------------------------------------------------------------------------
section "Cross-pack dataset invariants (skill/scripts/validate_dataset.py)"
if python3 skill/scripts/validate_dataset.py data/combined-final.json; then
  ok "dataset-level invariants hold (family, introducing copy, no duplicate introductions, cross-refs)"
else
  bad "dataset-level invariants failed (see output above)"
fi

# ---------------------------------------------------------------------------
section "Build reproducibility: does app/build_app.py currently produce the committed index.html, demo/index.html and sw.js?"
BUILD_TMP_DIR="$(mktemp -d)"
cp -r app "$BUILD_TMP_DIR/app"
mkdir -p "$BUILD_TMP_DIR/data"
cp data/combined-final.json "$BUILD_TMP_DIR/data/combined-final.json"
python3 "$BUILD_TMP_DIR/app/build_app.py" >/dev/null
if diff -q "$BUILD_TMP_DIR/index.html" index.html >/dev/null 2>&1; then
  ok "index.html is exactly what app/build_app.py produces from the current template + data"
else
  bytes_diff="$(diff "$BUILD_TMP_DIR/index.html" index.html | wc -l)"
  msg="index.html differs from a fresh build of the current template + data ($bytes_diff diff lines). This is expected while the template/data are mid-edit by other agents; run 'python3 app/build_app.py' and commit the result before shipping. Once the content settles this check should be promoted to a hard failure (set LT_STRICT_BUILD=1, or make it unconditional once things are stable)."
  if [ "${LT_STRICT_BUILD:-0}" = "1" ]; then
    bad "$msg"
  else
    soft "$msg"
  fi
fi
if diff -q "$BUILD_TMP_DIR/sw.js" sw.js >/dev/null 2>&1; then
  ok "sw.js is exactly what app/build_app.py produces from the current sw.tmpl.js + data (build id included)"
else
  sw_diff="$(diff "$BUILD_TMP_DIR/sw.js" sw.js 2>&1 | wc -l)"
  msg="sw.js differs from a fresh build ($sw_diff diff lines) - run 'python3 app/build_app.py' and commit the result. A stale sw.js/index.html pair can pin real users to an old build, so this matters as much as index.html itself."
  if [ "${LT_STRICT_BUILD:-0}" = "1" ]; then
    bad "$msg"
  else
    soft "$msg"
  fi
fi
if diff -q "$BUILD_TMP_DIR/demo/index.html" demo/index.html >/dev/null 2>&1; then
  ok "demo/index.html is exactly what app/build_app.py produces (the same build with DEMO on)"
else
  demo_diff="$(diff "$BUILD_TMP_DIR/demo/index.html" demo/index.html 2>&1 | wc -l)"
  msg="demo/index.html differs from a fresh build ($demo_diff diff lines) - run 'python3 app/build_app.py' and commit the result. The demo is not a separate app to maintain by hand: it is index.html with one flag flipped, and hand-editing it is how it silently stops matching what the app actually does."
  if [ "${LT_STRICT_BUILD:-0}" = "1" ]; then
    bad "$msg"
  else
    soft "$msg"
  fi
fi

# ---------------------------------------------------------------------------
section "Browser smoke test (Playwright/Chromium: golden path, localStorage regression, export/import, PWA/offline)"
if NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/smoke_test.js; then
  ok "browser smoke test passed"
else
  bad "browser smoke test failed (see output above)"
fi

# ---------------------------------------------------------------------------
section "Upgrade: progress saved on the shipped build survives loading this one"
# The previously shipped build is origin/main's index.html (what learners
# have progress in right now). Without it - no git, no origin/main - this is
# skipped with a warning rather than faked.
OLD_BUILD="$(mktemp)"
if git show origin/main:index.html > "$OLD_BUILD" 2>/dev/null && [ -s "$OLD_BUILD" ]; then
  if NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/upgrade_test.js "$OLD_BUILD" index.html; then
    ok "progress written by the shipped build (origin/main) is intact and shown after upgrading to this build"
  else
    bad "upgrading from the shipped build loses or misreads saved progress (see above) -- real learners would lose it on deploy"
  fi
else
  soft "couldn't read origin/main:index.html, so the upgrade test was skipped (run 'git fetch origin main')"
fi
rm -f "$OLD_BUILD"

# ---------------------------------------------------------------------------
section "Summary"
printf '%d OK, %d failed, %d warned (not yet hard failures)\n' "$PASS" "$FAIL" "$SOFT_FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
