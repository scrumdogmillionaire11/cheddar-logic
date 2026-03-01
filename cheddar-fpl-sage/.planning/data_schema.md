# Weekly Snapshot Data Schema

## Manifest (`snapshot_manifest.json`)
- `season`: string (e.g., "2025-26")
- `gw`: integer
- `snapshot_ts`: ISO timestamp
- `sources`: object
    - `bootstrap_static`: { status, hash }
    - `fixtures`: { status, hash }
    - `events`: { status, hash }
    - `team_picks`: { status, hash }
- `collection_status`: object
    - `bootstrap_static`: "OK" | "FAILED"
    - `fixtures`: "OK" | "FAILED"
    - `events`: "OK" | "FAILED"
    - `team_picks`: "OK" | "UNAVAILABLE_404" | "FAILED"

## bootstrap_static.json
- `schema_version`: string
- `season`: string
- `target_gw`: integer
- `payload`: object (raw FPL API)

## fixtures.json
- `schema_version`: string
- `season`: string
- `target_gw`: integer
- `payload`: array (raw FPL API)

## events.json
- `schema_version`: string
- `season`: string
- `target_gw`: integer
- `payload`: array (raw FPL API)

## team_picks.json
- `schema_version`: string
- `season`: string
- `target_gw`: integer
- `payload`: object (raw FPL API)
