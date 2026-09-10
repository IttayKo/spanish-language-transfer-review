import json, glob, re, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

files = sorted(glob.glob(os.path.join(ROOT, 'data', 'per-track', 'lt-review-track*.json')),
               key=lambda f: min(int(x) for x in re.findall(r'\d+', os.path.basename(f))))

packs = []
seen_tracks = set()
for f in files:
    d = json.load(open(f))
    tracks = d['tracks']
    # dedupe: skip if these exact tracks already loaded (shouldn't happen, but safe)
    key = tuple(tracks)
    pid = f"p{tracks[0]}-{tracks[-1]}" if len(tracks) > 1 else f"p{tracks[0]}"
    label = f"Tracks {tracks[0]}–{tracks[-1]}" if len(tracks) > 1 else f"Track {tracks[0]}"

    # namespace rule ids to avoid cross-pack collisions
    id_map = {}
    rules = []
    for r in d.get('rules', []):
        old_id = r['id']
        new_id = f"{pid}__{old_id}"
        id_map[old_id] = new_id
        r2 = dict(r)
        r2['id'] = new_id
        rules.append(r2)

    drills = []
    for dr in d.get('drills', []):
        dr2 = dict(dr)
        dr2['rules'] = [id_map.get(rid, rid) for rid in dr.get('rules', [])]
        drills.append(dr2)

    packs.append({
        'id': pid,
        'label': label,
        'tracks': tracks,
        'rules': rules,
        'drills': drills,
    })
    seen_tracks.update(tracks)

packs.sort(key=lambda p: p['tracks'][0])

combined = {
    'course': 'Complete Spanish',
    'packs': packs,
}

out_path = os.path.join(ROOT, 'data', 'combined-per-track.json')
with open(out_path, 'w', encoding='utf-8') as fh:
    json.dump(combined, fh, ensure_ascii=False)

print('packs:', len(packs))
print('tracks covered:', sorted(seen_tracks))
missing = [t for t in range(1, 91) if t not in seen_tracks]
print('tracks missing:', missing)
total_drills = sum(len(p['drills']) for p in packs)
total_rules = sum(len(p['rules']) for p in packs)
print('total drills:', total_drills, 'total rules:', total_rules)
print('file size bytes:', os.path.getsize(out_path))
