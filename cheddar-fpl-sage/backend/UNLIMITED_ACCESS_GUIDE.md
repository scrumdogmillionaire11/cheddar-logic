# 🔓 Unlimited Access Configuration Guide

## Overview

The unlimited access system allows specific FPL teams to bypass rate limits and usage quotas. This is controlled via environment variables with a **feature flag** for safe rollback.

## Feature Flag System

### Quick Toggle (Production Safety)

```bash
# DISABLE unlimited access entirely (safe for production testing)
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=false

# ENABLE unlimited access (default)
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true
```

**When disabled:**
- All teams follow normal rate limits (100 req/hour)
- All teams limited to 2 analyses per gameweek
- Existing unlimited team IDs are ignored
- **Safe rollback without code changes**

## Adding/Removing Teams

### Environment Variable Configuration

```bash
# Single team
export FPL_SAGE_UNLIMITED_TEAMS="711511"

# Multiple teams (comma-separated)
export FPL_SAGE_UNLIMITED_TEAMS="711511,1930561"

# Add more teams
export FPL_SAGE_UNLIMITED_TEAMS="711511,1930561,9999999,8888888"

# Remove all unlimited access
export FPL_SAGE_UNLIMITED_TEAMS=""
# OR
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=false
```

### .env File Configuration

Create or edit `backend/.env`:

```env
# Feature flag - set to false to disable unlimited access
FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true

# Team IDs with unlimited access (comma-separated)
FPL_SAGE_UNLIMITED_TEAMS=711511,1930561
```

### Docker/Production Configuration

**docker-compose.yml:**
```yaml
services:
  api:
    environment:
      - FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true
      - FPL_SAGE_UNLIMITED_TEAMS=711511,1930561
```

**Kubernetes:**
```yaml
env:
  - name: FPL_SAGE_UNLIMITED_ACCESS_ENABLED
    value: "true"
  - name: FPL_SAGE_UNLIMITED_TEAMS
    value: "711511,1930561"
```

## Validation & Safety

### Built-in Validation

The system validates team IDs automatically:
- Empty strings are ignored
- Non-numeric values are skipped with warning
- Negative numbers are rejected
- Invalid configs default to empty set (no unlimited teams)

### Testing Configuration

```bash
# 1. Set test configuration
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true
export FPL_SAGE_UNLIMITED_TEAMS="711511"

# 2. Restart backend
cd backend
python -m uvicorn backend.main:app --reload

# 3. Check logs for confirmation
# Should see: "Unlimited access enabled for teams: {711511}"
# Should see: "Rate limit exemptions for teams: {711511}"

# 4. Test with curl
curl http://localhost:8000/api/v1/usage/711511
# Should show: "analyses_remaining": 999
```

## Production Rollout Strategy

### Phase 1: Test with Feature Flag OFF
```bash
# Start with unlimited access disabled
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=false
export FPL_SAGE_UNLIMITED_TEAMS="711511,1930561"
```
- Deploy to production
- Verify normal rate limiting works
- No special treatment for any teams

### Phase 2: Enable for Test Accounts
```bash
# Enable with minimal team set
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true
export FPL_SAGE_UNLIMITED_TEAMS="711511"  # Single test account
```
- Monitor for issues
- Verify unlimited access works correctly
- Check logs for errors

### Phase 3: Gradual Expansion
```bash
# Add more teams incrementally
export FPL_SAGE_UNLIMITED_TEAMS="711511,1930561"
```
- Add one team at a time
- Monitor system performance
- Verify no side effects

### Emergency Rollback
```bash
# Instant disable without code deploy
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=false
# Restart service
```

## Monitoring & Logs

### Log Messages to Watch

**Startup:**
```
INFO: Unlimited access enabled for teams: {711511, 1930561}
INFO: Rate limit exemptions for teams: {711511, 1930561}
```

**Request Processing:**
```
INFO: Team 711511 has unlimited analysis access (via config)
INFO: Rate limit exemption: unlimited team 711511 (via config)
```

**Configuration Errors:**
```
WARNING: Invalid UNLIMITED_TEAMS config: <error>. Defaulting to empty set.
```

### Health Check

```bash
# Check current configuration
curl http://localhost:8000/health

# Test unlimited team
curl http://localhost:8000/api/v1/usage/711511
# Should show: "analyses_remaining": 999 (if enabled)
# Should show: "analyses_remaining": 2 (if disabled)

# Test normal team
curl http://localhost:8000/api/v1/usage/9999999
# Should always show: "analyses_remaining": 2 (or less)
```

## Troubleshooting

### Issue: Changes not taking effect

**Solution:**
1. Restart the backend service
2. Check environment variables are set: `env | grep FPL_SAGE`
3. Check logs for config loading messages

### Issue: Unlimited access not working

**Check:**
1. Feature flag enabled: `FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true`
2. Team ID in list: `FPL_SAGE_UNLIMITED_TEAMS` contains the ID
3. Format correct: Comma-separated, no spaces (except trimmed automatically)
4. Logs show team in unlimited set

### Issue: Want to test without unlimited access

**Solution:**
```bash
# Temporarily disable
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=false
# Restart service
```

## Best Practices

1. **Use Feature Flag First**: Always test with flag OFF before adding teams
2. **Start Small**: Add one team at a time in production
3. **Monitor Logs**: Watch for "unlimited access" log messages
4. **Document Changes**: Keep record of which teams were added when
5. **Regular Audits**: Periodically review unlimited team list
6. **Emergency Plan**: Know how to quickly disable via feature flag

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `FPL_SAGE_UNLIMITED_ACCESS_ENABLED` | `true` | Master on/off switch for unlimited access |
| `FPL_SAGE_UNLIMITED_TEAMS` | `"711511,1930561"` | Comma-separated team IDs |

## Security Considerations

- Keep team IDs confidential (don't commit .env files)
- Limit unlimited access to trusted accounts only
- Regularly audit the unlimited teams list
- Use feature flag to quickly disable if abuse detected
- Monitor Redis usage for unusual patterns

## Quick Reference Commands

```bash
# Add a team
export FPL_SAGE_UNLIMITED_TEAMS="711511,1930561,NEW_TEAM_ID"

# Remove a team (regenerate list without it)
export FPL_SAGE_UNLIMITED_TEAMS="711511,1930561"

# Disable all unlimited access
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=false

# Check current config
env | grep FPL_SAGE_UNLIMITED

# Restart backend
cd backend
python -m uvicorn backend.main:app --reload

# Verify in logs
# Look for: "Unlimited access enabled for teams: {...}"
```
