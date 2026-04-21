# web

Next.js web app for cheddarlogic.com.

## DB Contract (Read This First)

This app is read-only with respect to the shared SQLite/sql.js database.

- The worker is the only DB writer and migration owner.
- Web routes must not run migrations or DB writes.
- Web DB teardown must use read-only close paths.

Canonical contract: [`../docs/decisions/ADR-0002-single-writer-db-contract.md`](../docs/decisions/ADR-0002-single-writer-db-contract.md).

Production DB path contract used by the runtime:

- `CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db`

## Getting Started

Install dependencies and run the dev server:

```bash
npm --prefix web install
npm --prefix web run dev
```

Open <http://localhost:3000>.

## Tests

UI smoke tests (dev server required):

```bash
npm --prefix web run test:ui:cards
npm --prefix web run test:ui:results
```

## Build Constraints

- This repository must build in restricted/offline environments.
- Do not use `next/font/google` or any runtime/build-time remote font fetch.
- Use local font stacks in CSS (or vendored local font files) only.
