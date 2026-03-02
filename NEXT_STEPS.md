# 🎯 Multi-Sport Fix Complete - Three Decisions Needed

**Branch:** `fix/multi-sport-settlement`  
**Status:** ✅ Dev multi-sport FIXED | 🚧 Settlement & Prod pending  
**Date:** 2026-03-02

---

## ✅ WHAT WAS FIXED

### Root Cause: Database Path Mismatch
- `.env.local` pointed DATABASE_PATH to `/data/cheddar.db` (doesn't exist)
- Seed scripts wrote to `packages/data/cheddar.db` 
- API fell back to `/tmp/cheddar-logic/cheddar.db` (old data with no NBA)
- **Result:** API and seed scripts used different databases! 🤦

### The Fix Applied
Updated `web/.env.local`:
```
DATABASE_PATH: /data → /packages/data ✅
CHEDDAR_DATA_DIR: /data → /packages/data ✅
```

### Verification
```bash
curl http://localhost:3000/api/games | jq '.data | map(.sport) | unique'
# Returns: ["NBA", "NCAAM", "NHL", "SOCCER"] ✅
```

---

## 🚧 THREE CRITICAL DECISIONS NEEDED FROM YOU

### Decision 1️⃣: What is "Top Level Play"?

**Your requirement:** "Only the top level play suggested gets recorded"

**The problem:** Currently if game has 3 cards, we settle all 3. You want only 1.

**Which definition matches your intent?**

| Option | Definition | Example |
|--------|-----------|---------|
| **A: Highest Confidence** | Play with highest confidence % | 92% confidence play |
| **B: First in Array** | First card created | Card #1 (ordering matters) |
| **C: Best Tier** | Play marked tier='SUPER' or 'BEST' | High confidence tier |
| **D: EV-Passed** | Play where mathematically positive | ev_passed=true |
| **E: Other** | You define it | [Describe] |

**What to reply:** "Option A" or "Option E: [your definition]"

---

### Decision 2️⃣: Production Database Strategy

**The problem:** Vercel deletes `/tmp/cheddar.db` after build → Production shows 0 games

**Three options - Pick ONE:**

| | Cost | How It Works | Effort |
|------|------|------------|--------|
| **Bundle DB** | $0 | Include `cheddar.db` in deployment | Low ⭐ |
| **Vercel KV** | $0.20-2/mo | Store serialized DB in KV | Medium |
| **Turso** | Free-$30/mo | Hosted serverless SQLite | Medium |

**Budget:** Do you have cost constraints?  
**Scale:** Expect 1000s of games or just hundreds?  
**Timeline:** Need production working this week?

**My recommendation:** Bundle DB (simplest, works like dev)

---

### Decision 3️⃣: Delete Old Database?

```
/tmp/cheddar-logic/cheddar.db (23 MB - ancient data)
packages/data/cheddar.db (368 KB - current)
```

**Should I delete `/tmp` version?** (Safe to delete once you confirm `packages/data/` has all your data)

---

## 📋 WHAT I'LL DO ONCE YOU DECIDE

### For Settlement (1-2 hours)
1. Add `selectTopLevelPlay()` function
2. Modify settlement to record only 1 card_result per game
3. Add deduplication test
4. Verify: `/results` shows 1 play per game ✅

### For Production (1-2 hours) 
**If Bundle DB:**
- Git-track `packages/data/cheddar.db`
- Create `.env.production`
- Deploy to preview → prod

**If Vercel KV/Turso:**
- Set up service
- Migrate seeding logic
- Deploy and verify

### Integration Testing (1 hour)
- Run `npm test` (expect 11/11 pass)
- QA checklist (dev + prod)
- User sign-off

---

## ✅ CURRENT STATUS

**Development:**
- ✅ Multi-sport showing (NBA, NCAAM, NHL, SOCCER)
- ✅ /cards page working
- ✅ /results page working
- ✅ No errors
- **🚧 Awaiting:** Settlement logic confirmation

**Production:**  
- 🔴 Shows 0 games
- **🚧 Awaiting:** Database persistence strategy

---

## 💬 YOUR TURN

**Please reply in one message with:**
```
1. Settlement - Option: A / B / C / D / E (or your description)
2. Production - Strategy: Bundle / KV / Turso  
3. Temp DB - Delete /tmp version? Yes / No
4. Timeline - Need working this week? Yes / No
5. Budget - Cost constraints? (for KV/Turso option)
```

---

## 🔗 Branch Info
```bash
# Current branch
git branch -v
# fix/multi-sport-settlement (ahead of origin/main)

# To see changes
git log --oneline -3
# Shows: docs: add comprehensive system requirements and fix checklist

# To merge when ready
git checkout main
git merge fix/multi-sport-settlement
git push origin main
```

---

## 📚 More Details
See these for comprehensive guides:
- [docs/SYSTEM_CHECKLIST_AND_FIXES.md](docs/SYSTEM_CHECKLIST_AND_FIXES.md)
- [docs/SYSTEM_REQUIREMENTS_CHECKLIST.md](docs/SYSTEM_REQUIREMENTS_CHECKLIST.md)

You should see:
```
🃏 Card Coverage Analysis
============================================================
🔮 Future games (after ...): 38
🎴 Future games WITH cards: 38
```

### Start Your Web Server

If your Next.js dev server isn't running, start it:

```bash
cd web && npm run dev
```

Then visit:
- **http://localhost:3000/cards** - Should show 38+ games with predictions
- **http://localhost:3000/results** - Should show summary stats (may be zeros if no settled games)

### If Pages Are Still Empty

1. **Refresh the browser** (Cmd+Shift+R or Ctrl+Shift+F5) to clear cache

2. **Check browser console** for errors:
   - Right-click → Inspect → Console tab
   - Look for any red errors

3. **Test the API directly:**
   ```bash
   # While dev server is running
   curl http://localhost:3000/api/games | jq '.'
   ```

   You should see:
   ```json
   {
     "success": true,
     "data": [
       {
         "id": "...",
         "gameId": "...",
         "sport": "NHL",
         "homeTeam": "Toronto Maple Leafs",
         ...
       }
     ]
   }
   ```

4. **If API returns empty data,** seed more games:
   ```bash
   cd packages/data
   npm run seed:test-odds  # Creates fresh games
   npm run seed:cards      # Creates cards for games
   npm run db:check-coverage  # Verify
   ```

## Need More Games?

If you want more variety:

```bash
cd packages/data

# This creates ~50 realistic games across NHL, NBA, NCAAM, SOCCER
npm run seed:test-odds

# This creates cards for all games without them
npm run seed:cards

# Verify it worked
npm run db:inspect
```

## Prevent This in the Future

I've added these safeguards:

1. **Integration Tests** - Run before deploying:
   ```bash
   cd packages/data && npm run test:integration
   ```

2. **Health Checks** - Run anytime:
   ```bash
   cd packages/data && npm run db:inspect
   ```

3. **Troubleshooting Guide** - See `docs/DATA_PIPELINE_TROUBLESHOOTING.md`

## What Changed in Your Code

Files modified:
- `web/src/app/results/page.tsx` - Fixed undefined errors
- `web/src/app/api/results/route.ts` - Fixed empty response
- `packages/data/src/seed-cards.js` - Improved seeding logic
- Added 8 new diagnostic/test tools

All changes are safe and backwards compatible.

## Still Having Issues?

Check the terminal where `npm run dev` is running for error messages, then:

1. Review `docs/DATA_PIPELINE_TROUBLESHOOTING.md`
2. Run `npm run db:inspect` to see database state
3. Run `npm run test:integration` to identify specific issues
