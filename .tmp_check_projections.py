import json
import time
import urllib.request

base = 'http://localhost:8001/api/v1/analyze'
req = urllib.request.Request(
    base,
    data=json.dumps({'team_id': 711511, 'risk_posture': 'balanced'}).encode(),
    headers={'Content-Type': 'application/json'},
    method='POST'
)
resp = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
aid = resp.get('analysis_id')

body = {}
for _ in range(90):
    body = json.loads(urllib.request.urlopen(f'{base}/{aid}', timeout=30).read().decode())
    if str(body.get('status', '')).lower() in {'complete', 'completed', 'failed'}:
        break
    time.sleep(1.2)

res = body.get('results') or {}
fx = res.get('fixture_planner') or {}
bgw = set(str(t).upper() for t in ((fx.get('gw_timeline') or [{}])[0].get('bgw_teams') or []))
projs = res.get('projections') or []

rows = []
for p in projs:
    team = str(p.get('team') or '').upper()
    if team in bgw:
        rows.append((p.get('name'), team, p.get('expected_pts'), p.get('form'), p.get('expected_minutes'), p.get('flags')))
rows = sorted(rows, key=lambda r: (r[1], str(r[0])))

print('bgw_teams', sorted(bgw))
print('bgw_projection_count', len(rows))
for row in rows[:30]:
    print(row)

xi = res.get('starting_xi') or []
print('--- starting_xi ---')
for p in xi:
    print(p.get('name'), p.get('team'), p.get('expected_pts'), p.get('expected_minutes'), p.get('flags'))
