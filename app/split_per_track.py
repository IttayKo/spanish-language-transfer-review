import json

with open('/tmp/claude-0/-home-claude/a1a82151-7143-5f7c-aee2-1c713e8f84a4/scratchpad/lt/app/combined.json', encoding='utf-8') as f:
    data = json.load(f)

old_packs = data['packs']

# map: old prefixed rule id -> rule object
ruleid_to_obj = {}
for p in old_packs:
    for r in p['rules']:
        ruleid_to_obj[r['id']] = r

all_drills = []
for p in old_packs:
    for d in p['drills']:
        all_drills.append(d)

tracks = sorted(set(d['track'] for d in all_drills))
print('tracks with drills:', tracks[0], '..', tracks[-1], 'count', len(tracks))

def suffix_of(old_id):
    return old_id.split('__', 1)[1] if '__' in old_id else old_id

new_packs = []
for T in tracks:
    tdrills = [d for d in all_drills if d['track'] == T]

    own_ids = set()
    for p in old_packs:
        for r in p['rules']:
            if r['track'] == T:
                own_ids.add(r['id'])

    ref_ids = set()
    for d in tdrills:
        for rid in d.get('rules', []) or []:
            ref_ids.add(rid)

    all_ids = own_ids | ref_ids

    id_remap = {}
    new_rules = []
    used_new_ids = set()
    # stable order: own rules first (by their track/title), then referenced-carried ones
    ordered_ids = list(own_ids) + [i for i in ref_ids if i not in own_ids]
    for old_id in ordered_ids:
        robj = ruleid_to_obj.get(old_id)
        if not robj:
            continue
        suf = suffix_of(old_id)
        new_id = f"t{T}__{suf}"
        base = new_id
        i = 2
        while new_id in used_new_ids:
            new_id = f"{base}-{i}"
            i += 1
        used_new_ids.add(new_id)
        id_remap[old_id] = new_id
        nr = dict(robj)
        nr['id'] = new_id
        new_rules.append(nr)

    new_drills = []
    for d in tdrills:
        nd = dict(d)
        if d.get('rules'):
            nd['rules'] = [id_remap.get(rid, rid) for rid in d['rules']]
        new_drills.append(nd)

    new_packs.append({
        'id': f"t{T}",
        'label': f"Track {T}",
        'tracks': [T],
        'rules': new_rules,
        'drills': new_drills,
    })

out = {'course': data['course'], 'packs': new_packs}
with open('/tmp/claude-0/-home-claude/a1a82151-7143-5f7c-aee2-1c713e8f84a4/scratchpad/lt/app/combined-per-track.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False)

total_rules = sum(len(p['rules']) for p in new_packs)
total_drills = sum(len(p['drills']) for p in new_packs)
print('per-track packs:', len(new_packs), 'total rules (with carry-dupes):', total_rules, 'total drills:', total_drills)

# sanity: every drill.rules id resolves within its own pack
missing = 0
for p in new_packs:
    rid_set = set(r['id'] for r in p['rules'])
    for d in p['drills']:
        for rid in d.get('rules', []) or []:
            if rid not in rid_set:
                missing += 1
                print('MISSING', p['id'], d['id'], rid)
print('unresolved refs:', missing)
