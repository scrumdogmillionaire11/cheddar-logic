# Identity + Naming Contract

This file defines canonical naming rules for the cheddar-logic monorepo.
Agents and contributors must not improvise names.

---

## Canonical Names

- GitHub repository: `cheddar-logic`
- Production domain: `cheddarlogic.com`
- Internal namespace / package name: `cheddarlogic`
- Database name: `cheddarlogic`

---

## Hyphen Policy

The hyphen is allowed **only** in the GitHub repository name.

Hyphen is NOT allowed in:
- internal imports
- Python/Node package names
- environment variables
- database names
- schema names
- table names
- service names
- Docker service names
- systemd unit names

---

## Correct Examples

Repo:
- cheddar-logic

Domain:
- https://cheddarlogic.com

Python:
```python
from cheddarlogic.data import db

Node:

{
  "name": "cheddarlogic"
}

Docker service:

web
worker
db

Database:

cheddarlogic
Incorrect Examples

❌ cheddar-logic.com
❌ import cheddar-logic
❌ DATABASE_URL=postgres://.../cheddar-logic
❌ docker service: cheddar-logic-web

Why This Exists

Agents will generate inconsistent naming unless constrained.
This document is the constraint.

Do not deviate.