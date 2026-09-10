import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

with open(os.path.join(ROOT, 'data', 'combined-final.json'), encoding='utf-8') as f:
    data = json.load(f)

data_json = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
# escape closing script tags just in case
data_json = data_json.replace('</script', '<\\/script')

template = open(os.path.join(ROOT, 'app', 'lt-review-app.tmpl.html'), encoding='utf-8').read()
out = template.replace('__DATA_JSON__', data_json)

with open(os.path.join(ROOT, 'index.html'), 'w', encoding='utf-8') as f:
    f.write(out)

print('wrote', len(out), 'bytes')
