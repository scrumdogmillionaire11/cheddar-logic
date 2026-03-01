# 🚀 Quick Reference: Unlimited Access Management

## ⚡ Common Operations

### Add a Team
```bash
# Current teams: 711511,1930561
# Add team 9999999:
export FPL_SAGE_UNLIMITED_TEAMS="711511,1930561,9999999"
# Restart backend
```

### Remove a Team
```bash
# Remove 1930561, keep 711511:
export FPL_SAGE_UNLIMITED_TEAMS="711511"
# Restart backend
```

### Disable All Unlimited Access
```bash
# Method 1: Feature flag (RECOMMENDED)
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=false
# Restart backend

# Method 2: Empty team list
export FPL_SAGE_UNLIMITED_TEAMS=""
# Restart backend
```

### Enable Unlimited Access
```bash
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true
export FPL_SAGE_UNLIMITED_TEAMS="711511,1930561"
# Restart backend
```

## 🧪 Testing

### Test Current Config
```bash
cd backend
python test_unlimited_config.py
```

### Test with Team ID
```bash
# Should return "analyses_remaining": 999
curl http://localhost:8000/api/v1/usage/711511

# Should return "analyses_remaining": 2
curl http://localhost:8000/api/v1/usage/9999999
```

### Check Health
```bash
curl http://localhost:8000/health
```

## 📋 Configuration Files

### .env (create in backend/)
```env
FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true
FPL_SAGE_UNLIMITED_TEAMS=711511,1930561
```

### Environment Variables
```bash
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true
export FPL_SAGE_UNLIMITED_TEAMS="711511,1930561"
```

## 🔍 Log Messages

### Success
```
INFO: Unlimited access enabled for teams: {711511, 1930561}
INFO: Rate limit exemptions for teams: {711511, 1930561}
INFO: Team 711511 has unlimited analysis access (via config)
```

### Disabled
```
INFO: Unlimited access enabled for teams: set()
```

### Error
```
WARNING: Invalid UNLIMITED_TEAMS config: <error>. Defaulting to empty set.
```

## 🚨 Emergency Rollback

### Production Issue? Disable immediately:
```bash
# Set environment variable
export FPL_SAGE_UNLIMITED_ACCESS_ENABLED=false

# Restart backend
# OR if using systemd/supervisor:
sudo systemctl restart fpl-sage-api

# Verify
curl http://localhost:8000/api/v1/usage/711511
# Should show normal limits
```

## 📚 Full Documentation

- **Admin Guide**: `backend/UNLIMITED_ACCESS_GUIDE.md`
- **Debug Report**: `backend/GSD_DEBUG_REPORT_UNLIMITED_ACCESS.md`
- **Example Config**: `backend/.env.example`
- **Test Script**: `backend/test_unlimited_config.py`

## 💡 Tips

1. **Always test** with `test_unlimited_config.py` after changes
2. **Start small** in production (one team at a time)
3. **Monitor logs** for unlimited access messages
4. **Keep .env secure** - don't commit to git
5. **Document changes** - know who has unlimited access

## ⚠️ Common Mistakes

❌ Adding spaces: `"711511, 1930561"` (works but avoid)  
✅ Correct: `"711511,1930561"`

❌ Forgetting to restart backend after config change  
✅ Always restart after environment variable changes

❌ Testing in wrong environment  
✅ Check `env | grep FPL_SAGE` to verify config

❌ Assuming changes apply immediately  
✅ Restart backend for config to take effect

## 🎯 Production Checklist

- [ ] Test config with `test_unlimited_config.py`
- [ ] Verify team IDs are correct
- [ ] Check logs show expected teams
- [ ] Test API calls for unlimited teams
- [ ] Test API calls for normal teams
- [ ] Document which teams have access
- [ ] Set up monitoring/alerting
- [ ] Know rollback procedure
