import hashlib
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

with open(os.path.join(ROOT, 'data', 'combined-final.json'), encoding='utf-8') as f:
    data = json.load(f)

data_json = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
# escape closing script tags just in case
data_json = data_json.replace('</script', '<\\/script')

template = open(os.path.join(ROOT, 'app', 'lt-review-app.tmpl.html'), encoding='utf-8').read()
with_data = template.replace('__DATA_JSON__', data_json)

# The demo (served at /demo) is the same build with one flag flipped: it
# writes to its own pair of localStorage keys and opens with sample progress
# already in them, so a first-time visitor lands on a worked-in app instead
# of an empty list. Two things are stripped rather than flagged, because the
# demo is a link to look at and not an app to install: the web app manifest
# and the service worker registration. Both live between <!--APP-ONLY-->
# markers in the template.
APP_ONLY = re.compile(r'<!--APP-ONLY-->.*?<!--/APP-ONLY-->', re.DOTALL)

out = APP_ONLY.sub(lambda m: m.group(0)
                   .replace('<!--APP-ONLY-->', '').replace('<!--/APP-ONLY-->', ''),
                   with_data).replace('__DEMO__', 'false')

with open(os.path.join(ROOT, 'index.html'), 'w', encoding='utf-8') as f:
    f.write(out)

print('wrote', len(out), 'bytes')

demo_out = APP_ONLY.sub('', with_data).replace('__DEMO__', 'true')
demo_dir = os.path.join(ROOT, 'demo')
os.makedirs(demo_dir, exist_ok=True)
with open(os.path.join(demo_dir, 'index.html'), 'w', encoding='utf-8') as f:
    f.write(demo_out)

print('wrote demo/index.html,', len(demo_out), 'bytes')

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
