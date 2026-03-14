# WI-####: <short title>

**ID**: WI-####
**Goal**: <one sentence>

**Scope**:
- `<file-or-glob-1>`
- `<file-or-glob-2>`

**Out of scope**:
- `<explicitly excluded file/area>`

**Acceptance**:
- <verifiable outcome 1>
- <verifiable outcome 2>

**Owner agent**: unassigned
**Time window**: <start ISO8601> -> <end ISO8601 or TBD>
**Coordination flag**: solo

**Tests to run**:
<!-- Use runnable npm --prefix web run <script> commands. -->
<!-- All scripts must exist in web/package.json scripts block. -->
<!-- Do NOT use `npm test`, `npm --prefix web test`, or bare `node` paths without verifying the script exists. -->
<!-- Canonical examples (copy-paste ready): -->
<!--   npm --prefix web run test:card-decision          -->
<!--   npm --prefix web run test:transform:market       -->
<!--   npm --prefix web run test:filters                -->
<!--   npm --prefix web run test:games-filter           -->
<!--   node web/src/__tests__/<test-file>.test.js       -->
- `npm --prefix web run <script-from-web-package.json>`

**Manual validation**:
- <manual check 1>

**Guard for WI closeout**:
- Before marking complete: confirm every test command in `Tests to run` is runnable from repo root (i.e., exists in web/package.json scripts or is a valid `node path/to/test.js` command).
- If a script is added to web/package.json as part of this WI, add it to this WI's Tests section with the full `npm --prefix web run <script>` form.

CLAIM: <agent> <ISO8601>
