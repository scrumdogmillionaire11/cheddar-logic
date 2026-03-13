import json
import time
import urllib.request

base = 'http://localhost:3000/api/v1'
request_payload = {
    'team_id': 1930561,
    'risk_posture': 'balanced',
    'free_transfers': 1,
}

req = urllib.request.Request(
    base + '/analyze',
    data=json.dumps(request_payload).encode(),
    headers={'Content-Type': 'application/json'},
    method='POST',
)
analysis_id = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())['analysis_id']

payload = None
for _ in range(80):
    try:
        with urllib.request.urlopen(base + f'/analyze/{analysis_id}/projections', timeout=30) as response:
            payload = json.loads(response.read().decode())
            break
    except Exception:
        time.sleep(1.5)

if payload is None:
    raise SystemExit('analysis did not complete in time')

print('analysis_id:', analysis_id)
print('top keys:', sorted(payload.keys()))
lineup_decision = payload.get('lineup_decision')
print('lineup_decision present:', isinstance(lineup_decision, dict))

for bucket in ['projected_xi', 'projected_bench', 'starting_xi_projections', 'bench_projections']:
    rows = payload.get(bucket) or []
    hit = [r for r in rows if str(r.get('name', '')).lower() == 'dewsbury-hall']
    if hit:
        print(f'found Dewsbury-Hall in {bucket}:', json.dumps(hit[0], indent=2))

mid_xi = [
    (r.get('name'), r.get('expected_pts'), r.get('position'))
    for r in (payload.get('projected_xi') or [])
    if str(r.get('position', '')).upper() == 'MID'
]
mid_bench = [
    (r.get('name'), r.get('expected_pts'), r.get('position'))
    for r in (payload.get('projected_bench') or [])
    if str(r.get('position', '')).upper() == 'MID'
]
print('projected_xi mids:', mid_xi)
print('projected_bench mids:', mid_bench)
