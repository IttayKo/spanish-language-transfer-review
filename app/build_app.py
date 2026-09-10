import json

with open('/tmp/claude-0/-home-claude/a1a82151-7143-5f7c-aee2-1c713e8f84a4/scratchpad/lt/app/combined-final.json', encoding='utf-8') as f:
    data = json.load(f)

data_json = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
# escape closing script tags just in case
data_json = data_json.replace('</script', '<\\/script')

template = open('/tmp/claude-0/-home-claude/a1a82151-7143-5f7c-aee2-1c713e8f84a4/scratchpad/lt/app/lt-review-app.tmpl.html', encoding='utf-8').read()
out = template.replace('__DATA_JSON__', data_json)

with open('/tmp/claude-0/-home-claude/a1a82151-7143-5f7c-aee2-1c713e8f84a4/scratchpad/lt/app/lt-review-app.html', 'w', encoding='utf-8') as f:
    f.write(out)

print('wrote', len(out), 'bytes')
