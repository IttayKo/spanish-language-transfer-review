import hashlib
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

# The service worker's cache is versioned by a hash of the exact bytes it's
# meant to serve, so a rebuild that changes so much as one character of
# content or code ships a byte-different sw.js - which the browser detects as
# an update on its own - and gets its own fresh cache. See app/sw.tmpl.js for
# why this matters (a service worker that pins users to a stale build is
# considered worse than not shipping one).
build_id = hashlib.sha256(out.encode('utf-8')).hexdigest()[:12]
sw_template = open(os.path.join(ROOT, 'app', 'sw.tmpl.js'), encoding='utf-8').read()
sw_out = sw_template.replace('__BUILD_ID__', build_id)

with open(os.path.join(ROOT, 'sw.js'), 'w', encoding='utf-8') as f:
    f.write(sw_out)

print('wrote sw.js, build', build_id)
