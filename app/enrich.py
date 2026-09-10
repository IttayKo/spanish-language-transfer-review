import json

with open('/tmp/claude-0/-home-claude/a1a82151-7143-5f7c-aee2-1c713e8f84a4/scratchpad/lt/app/combined-per-track.json', encoding='utf-8') as f:
    data = json.load(f)

blurbs = json.load(open('/tmp/lt-blurbs/all-blurbs.json'))
sections = json.load(open('/tmp/lt-blurbs/sections.json'))['sections']

def section_for(track):
    for i, s in enumerate(sections):
        if s['start'] <= track <= s['end']:
            return i
    return -1

for p in data['packs']:
    t = p['tracks'][0]
    p['blurb'] = blurbs.get(str(t), "")
    p['sectionIndex'] = section_for(t)

data['sections'] = [{"title": s['title'], "focus": s['focus'], "start": s['start'], "end": s['end']} for s in sections]

with open('/tmp/claude-0/-home-claude/a1a82151-7143-5f7c-aee2-1c713e8f84a4/scratchpad/lt/app/combined-final.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False)

print('packs:', len(data['packs']), 'sections:', len(data['sections']))
missing_blurb = [p['id'] for p in data['packs'] if not p['blurb']]
print('packs missing blurb:', missing_blurb)
missing_section = [p['id'] for p in data['packs'] if p['sectionIndex'] < 0]
print('packs missing section:', missing_section)
