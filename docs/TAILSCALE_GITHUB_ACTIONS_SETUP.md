# Tailscale GitHub Actions Setup for Production Deploy

**Status**: Complete setup guide for secure GitHub runner + Raspberry Pi SSH deploy  
**Last Updated**: 2026-03-06  
**Scope**: Deploy to production Raspberry Pi via Tailscale VPN

---

## Root Cause Analysis: Why Deploy Failed

### Failure Sequence

1. **First Attempt: Tailscale OAuth failed with "OAuth identity empty"**
   - **Root Cause**: The GitHub Actions workflow used OAuth client credentials but **did not include the required `tags` parameter** in the `tailscale/github-action` step.
   - **Details**:
     - Tailscale OAuth requires a node to advertise at least one tag when joining the network.
     - Without the `tags` field, the action tried to join without identity, triggering the error.
     - Additionally, the OAuth client may not have had the `auth_keys` (writable) scope enabled.
   - **Lesson**: OAuth + Tailscale requires three things: client ID, client secret, AND tags.

2. **Second Attempt: Removed Tailscale, SSH timed out**
   - **Root Cause**: The GitHub Actions runner (hosted on GitHub's infrastructure, public internet) cannot reach a private Raspberry Pi on a home LAN on port 22.
   - **Details**:
     - `PI_HOST` was pointing to a private IP or hostname not reachable from the public internet.
     - Removed Tailscale = removed the only path for the runner to reach the Pi.
     - SSH action dies with `dial tcp ***:22: i/o timeout` because the connection never leaves GitHub's data center.
   - **Lesson**: Private infrastructure + GitHub runners require a VPN (Tailscale) or public port forwarding.

### Why Tailscale Is the Right Solution

- **Secure**: Encrypted WireGuard-based VPN; no port forwarding to the internet.
- **Works with private IPs**: GitHub runner can reach 100.x.y.z (Tailscale IP) because both are on the same tailnet.
- **Fine-grained access control**: ACLs allow only `tag:ci` (GitHub runner nodes) to reach `tag:servers` (your Pi).
- **Ephemeral nodes**: Each runner joins temporarily and is auto-cleaned up after the job finishes.

---

## Setup Instructions (Step by Step)

### Phase 1: Tailscale Org Setup (One-Time)

#### Step 1: Create/Verify `tag:ci` in ACL policy

1. Go to [Tailscale ACL admin console](https://login.tailscale.com/admin/acls)
2. In the `acls` section, ensure the following policy exists:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["tag:ci"],
      "dst": ["tag:servers:*"]
    }
  ]
}
```

**Explanation**: This policy allows any node tagged `tag:ci` (GitHub Actions runners) to initiate connections to any node tagged `tag:servers` (your production Raspberry Pi).

If you don't have a `tag:servers` on your Pi yet, add it in Step 3.

#### Step 2: Create OAuth Client in Tailscale Admin Console

1. Go to [Tailscale OAuth credentials](https://login.tailscale.com/admin/settings/trust-credentials)
2. Click **Credential** → **OAuth**
3. **Select Scope**: Choose **`auth_keys`** (must be **writable**)
4. **Select Tags**: Check `tag:ci` (this OAuth client is only allowed to issue keys with this tag)
5. Click **Generate credential**
6. **IMPORTANT**: Copy both the **Client ID** and **Client Secret** immediately—you won't see the secret again
7. Store them safely (we'll add to GitHub secrets next)

**Expected output**:

```text
Client ID:     tskey-client-abc123...
Client Secret: tskey-secret-xyz789...
```

#### Step 3: Tag Your Raspberry Pi

1. Go to [Tailscale machines](https://login.tailscale.com/admin/machines)
2. Find your Raspberry Pi device (e.g., "CheddarPi")
3. Click the device, scroll to **Tags**, add: `tag:servers`
4. Save

**Verification**: The Pi should now show `tag:servers` in the admin console.

---

### Phase 2: GitHub Repository Secrets

#### Step 4: Add Repo Secrets

Go to **GitHub repository → Settings → Secrets and variables → Actions**, and create these **encrypted repository secrets**:

| Secret Name | Value | Source |
| --- | --- | --- |
| `TS_OAUTH_CLIENT_ID` | From Phase 1, Step 2 | Tailscale admin console |
| `TS_OAUTH_SECRET` | From Phase 1, Step 2 | Tailscale admin console |
| `PI_HOST` | Your Pi's **tailnet hostname** or **tailnet IP** | Tailscale admin machines page |
| `PI_USER` | SSH username (e.g., `babycheeses11`) | Your Pi SSH config |
| `PI_SSH_KEY` | SSH private key (unchanged) | Your existing deploy key |

**Finding `PI_HOST`**:

- Go to [Tailscale machines](https://login.tailscale.com/admin/machines) and find your Pi
- Look for the **Tailscale IP** (format: `100.x.y.z`) or **DNS name** (format: `cheddarpi.your-tailnet.ts.net`)
- Use either the IP or hostname; both are reachable from the GitHub runner once Tailscale is connected

**Example**:

```text
TS_OAUTH_CLIENT_ID:  tskey-client-abc123...
TS_OAUTH_SECRET:     tskey-secret-xyz789...
PI_HOST:             cheddarpi.your-tailnet.ts.net  (or 100.123.45.67)
PI_USER:             babycheeses11
PI_SSH_KEY:          -----BEGIN OPENSSH PRIVATE KEY-----
                     ... (your existing SSH key)
                     -----END OPENSSH PRIVATE KEY-----
```

---

### Phase 3: Update GitHub Actions Workflow

The production deploy workflow now includes a Tailscale connection step before SSH.

**File**: `.github/workflows/deploy-production.yml`

**Key Steps**:

1. **Checkout code** (standard)
2. **Connect to Tailscale** (new)
   - Uses OAuth client ID/secret from secrets
   - Joins the tailnet with tag `tag:ci`
   - Creates an ephemeral node that auto-cleans on job finish
3. **SSH deploy to Pi** (existing, now works via Tailscale)
   - Connects to `PI_HOST` on the tailnet
   - Runs full deploy script (migrations, builds, restarts)

**Current workflow state**: [.github/workflows/deploy-production.yml](.github/workflows/deploy-production.yml#L72-L120)

---

## How It Works (Deployment Flow)

```text
[GitHub Push to main]
         ↓
[Lint & Test Job] ← (CI checks)
         ↓
[Deploy Worker Job]
 ├─ Checkout repo code
 ├─ Connect to Tailscale
 │ ├─ Use TS_OAUTH_CLIENT_ID + TS_OAUTH_SECRET
 │ ├─ Join tailnet as tag:ci (ephemeral)
 │ └─ GitHub runner now has 100.x.y.z IP
 ├─ SSH to PI_HOST (now reachable via Tailscale)
 │ └─ Git pull origin main
 │ └─ npm install packages
 │ └─ Database migrations
 │ └─ ✅ Fail if card_payloads missing (WI-0319)
 │ └─ npm run build (web)
 │ └─ systemctl restart services
 │ └─ API smoke test
 └─ Tailscale node auto-cleans up (ephemeral)
         ↓
[Deploy Complete]
```

---

## Troubleshooting

### Error: "OAuth identity empty"

**Cause**: Missing or misconfigured OAuth client or tags.

**Checklist**:

- [ ] `TS_OAUTH_CLIENT_ID` secret exists and is not empty
- [ ] `TS_OAUTH_SECRET` secret exists and is not empty
- [ ] OAuth client has **writable** `auth_keys` scope
- [ ] OAuth client includes `tag:ci` in permitted tags
- [ ] Workflow includes `tags: tag:ci` in Tailscale action (if using `v4`)

**Fix**:

1. Regenerate OAuth client in Tailscale admin
2. Update both secrets in GitHub
3. Re-run deploy workflow

### Error: "SSH connection timed out"

**Cause**: GitHub runner can't reach Pi host.

**Checklist**:

- [ ] `PI_HOST` secret is set to a **tailnet IP** or tailnet hostname (not LAN cheddar-pi.home)
- [ ] Tailscale step completed successfully (check action logs)
- [ ] Pi is online and connected to tailnet
- [ ] ACL allows `tag:ci` → `tag:servers` (check `/admin/acls`)

**Fix**:

1. Verify `PI_HOST` in GitHub secrets matches Tailscale admin machines page
2. Check Tailscale action logs: look for "Tailscale connected" message
3. Test locally: `tailscale ping 100.x.y.z` from your terminal

### Error: "Permission denied (publickey)"

**Cause**: Wrong SSH key or user.

**Checklist**:

- [ ] `PI_USER` matches the user that owns `~/.ssh/authorized_keys` on the Pi
- [ ] `PI_SSH_KEY` is the **private key** (not public), in OpenSSH format
- [ ] Public key is in Pi's `~/.ssh/authorized_keys`

**Fix**:

1. Verify SSH locally from your Mac:

   ```bash
   ssh -i <PI_SSH_KEY> babycheeses11@<PI_HOST>
   ```

2. If that works, the issue is in the GitHub workflow secrets format
3. Re-upload the SSH key to GitHub secrets (ensure no extra whitespace)

---

## Post-Deploy Validation

After successful deploy, the workflow automatically runs these checks:

1. **Schema validation** (WI-0319):
   - `card_payloads` table exists in `/opt/data/cheddar-prod.db`
   - Deploy fails if table is missing

2. **Web build validation**:
   - `.next/BUILD_ID` file exists

3. **Service health check**:
   - API smoke test hits `/api/games`, `/api/cards`, `/api/results`
   - Logs JSON response (status, data counts, summary)

---

## Security Considerations

### OAuth Client Scope

- The OAuth client is restricted to **`auth_keys` scope only**
- It **cannot** modify tailnet policy, create tags, or manage users
- It can only issue new auth keys with the tags it owns (`tag:ci`)

### Ephemeral Nodes

- GitHub runner node is marked as **ephemeral**
- Auto-deleted 10 minutes after job finishes
- No persistent access; each deploy creates a fresh node

### ACL Policy

- Restricts `tag:ci` to only reach `tag:servers`
- Other devices (personal machines, etc.) are not exposed to CI runners
- Change ACL at any time to revoke access (existing nodes are kicked off)

---

## Maintenance & Updates

### Rotating Secrets

If you suspect the OAuth or SSH key is compromised:

1. **OAuth**:
   - Regenerate new OAuth client in Tailscale admin
   - Update `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET` in GitHub
   - Old credentials stop working immediately

2. **SSH Key**:
   - Generate new key: `ssh-keygen -t ed25519 -f cheddar-deploy`
   - Add public key to Pi: `~/.ssh/authorized_keys`
   - Update `PI_SSH_KEY` in GitHub
   - Delete old key from Pi if needed

### Tailscale Client Updates

- The workflow uses `tailscale/github-action@v4` (pinned major version)
- Updates are automatic (within v4.x releases)
- To pin an exact version: change to `@v4.1.1` (or specific release)

---

## Reference

- **Tailscale OAuth clients**: [https://tailscale.com/kb/1215/oauth-clients](https://tailscale.com/kb/1215/oauth-clients)
- **Tailscale GitHub Action**: [https://github.com/tailscale/github-action](https://github.com/tailscale/github-action)
- **Tailscale ACLs**: [https://login.tailscale.com/admin/acls](https://login.tailscale.com/admin/acls)
- **This repo's deployment workflow**: [.github/workflows/deploy-production.yml](.github/workflows/deploy-production.yml)

