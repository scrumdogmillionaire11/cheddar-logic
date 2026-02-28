# Migration Tasks

## Phase 1 — Foundation

- [ ] Create `packages/data` with DB schema + migrations
- [ ] Create DB connection layer
- [ ] Implement `job_runs` table
- [x] Implement Phase 1 auth magic-link foundation (`users`, `subscriptions`, `auth_magic_links`, `sessions`, `/login`, `/api/auth/send-link`, `/auth/verify`)
- [ ] Create `packages/adapters` skeleton
- [ ] Create `apps/worker` skeleton
- [ ] Create `apps/web` skeleton

---

## Phase 2 — Ingestion

- [ ] Move odds scheduler into worker
- [ ] Normalize odds into canonical schema
- [ ] Persist odds snapshots
- [ ] Add ingestion tests
- [ ] Verify idempotent job behavior

---

## Phase 3 — First Sport Runner

Choose one sport:

- [ ] Move runner into worker
- [ ] Persist model_outputs
- [ ] Persist card_payloads
- [ ] Web renders stored card_payload
- [x] Add cross-market orchestration payload (expression_choice) for NHL drivers

---

## Phase 4 — FPL Integration

- [ ] Move FPL UI to `/fpl`
- [ ] Move compute to worker if needed
- [ ] Persist FPL card_payload

---

## Phase 5 — Cutover

- [ ] Deploy monorepo to server
- [ ] Switch systemd/cron to new worker
- [ ] Verify DB writes
- [ ] Monitor logs
- [ ] Freeze legacy repos

---

## Completion Criteria

Migration complete when:

- All ingestion + runners live in monorepo
- Web renders only from DB
- Legacy repos are read-only
