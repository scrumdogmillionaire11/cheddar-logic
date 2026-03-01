# GSD Quick Start Guide

## 5-Minute Quick Reference

### What is GSD?
**Get Shit Done** - Action-oriented AI agents for rapid execution.

### When to Use
- ⚡ Need results in minutes/hours (not days)
- ⚡ Bug needs fixing NOW
- ⚡ Quick prototype or experiment
- ⚡ Simple script or tool
- ⚡ Emergency debugging

### When NOT to Use
- ❌ Comprehensive planning needed
- ❌ Multi-stakeholder alignment required
- ❌ Core architecture changes
- ❌ Long-term strategic decisions

## The 11 GSD Agents

```
gsd-builder      → Build features fast (1-4 hours)
gsd-fixer        → Fix bugs NOW (15-30 min)
gsd-prototyper   → Test ideas quickly (2-4 hours)
gsd-debugger     → Investigate issues (30-60 min)
gsd-optimizer    → Improve performance (1-2 hours)
gsd-integrator   → Connect systems (2-6 hours)
gsd-validator    → Quick quality checks (30 min)
gsd-documenter   → Fast docs (30-90 min)
gsd-migrator     → Upgrade code (2-4 hours)
gsd-scripter     → Automate tasks (1-2 hours)
gsd-tester       → Add tests quickly (1-3 hours)
```

## Common Commands

### Build Something
```bash
As gsd-builder, create a script that fetches injury data
and updates the cache. Target: 2 hours.
```

### Fix a Bug
```bash
As gsd-fixer, the captain selection is broken.
Find and fix it. Budget: 20 minutes.
```

### Prototype an Idea
```bash
As gsd-prototyper, test if we can predict injuries
using historical data. Show working proof of concept.
```

### Debug an Issue
```bash
As gsd-debugger, why is normalize-snapshot failing?
Trace execution and identify root cause.
```

### Optimize Performance
```bash
As gsd-optimizer, transfer calculation takes 3s.
Get it under 500ms.
```

### Integrate Systems
```bash
As gsd-integrator, connect the injury secondary feed
to our main data pipeline.
```

### Validate Output
```bash
As gsd-validator, verify all players have valid
injury statuses in the latest snapshot.
```

### Document Quickly
```bash
As gsd-documenter, create a README for the
injury enrichment system.
```

### Migrate Code
```bash
As gsd-migrator, upgrade the data pipeline
from Python 3.8 to 3.11.
```

### Create Automation
```bash
As gsd-scripter, create a script to prune old
snapshots, keeping latest 10 per season.
```

### Add Tests
```bash
As gsd-tester, create unit tests for the
injury resolution logic.
```

## GSD Core Principles

### 1. Time-Box Everything
Every task has a hard time limit. If you hit it, escalate.

### 2. Start Fast
Begin coding within 5 minutes. No extensive planning.

### 3. Working > Perfect
Ship something that works, iterate later.

### 4. Fail Fast
If stuck for > 10 minutes, pivot or ask for help.

### 5. Document Last
Get it working first, document second.

## Quick Decision Tree

```
Need to build something?
│
├─ Takes < 4 hours?
│  └─ ✅ Use GSD (gsd-builder, gsd-prototyper)
│
├─ Emergency fix?
│  └─ ✅ Use GSD (gsd-fixer, gsd-debugger)
│
├─ Quick integration?
│  └─ ✅ Use GSD (gsd-integrator)
│
├─ Multiple stakeholders involved?
│  └─ ❌ Use BMAD (PM, Architect, PO)
│
├─ Core architecture change?
│  └─ ❌ Use BMAD (Architect)
│
└─ Long-term strategic work?
   └─ ❌ Use BMAD (PM, Architect, PO, QA)
```

## Real Examples

### Example 1: Quick Bug Fix
```
Problem: Injury data loader crashes on null values
Solution: As gsd-fixer, add null checks and default values
Time: 15 minutes
```

### Example 2: Feature Prototype
```
Problem: Need to test chip prediction feasibility
Solution: As gsd-prototyper, build proof-of-concept
Time: 3 hours
Result: Works! Ready for BMAD planning.
```

### Example 3: Performance Issue
```
Problem: Snapshot collection takes 45 seconds
Solution: As gsd-optimizer, parallelize API calls
Time: 90 minutes
Result: Down to 8 seconds
```

### Example 4: Integration Task
```
Problem: Connect secondary injury feed
Solution: As gsd-integrator, add to data pipeline
Time: 4 hours
Result: Seamless integration with caching
```

## GSD Time Budgets

| Task Type | Time Budget | GSD Agent |
|-----------|-------------|-----------|
| Emergency fix | 15-30 min | gsd-fixer |
| Quick debug | 30-60 min | gsd-debugger |
| Small feature | 1-4 hours | gsd-builder |
| Prototype | 2-4 hours | gsd-prototyper |
| Integration | 2-6 hours | gsd-integrator |
| Optimization | 1-2 hours | gsd-optimizer |
| Quick tests | 1-3 hours | gsd-tester |
| Fast docs | 30-90 min | gsd-documenter |
| Script creation | 1-2 hours | gsd-scripter |
| Code migration | 2-4 hours | gsd-migrator |
| Validation | 30-60 min | gsd-validator |

## GSD + BMAD: Best of Both

### For Small Tasks (< 4 hours)
**Use GSD alone**
- Faster execution
- Less overhead
- Perfect for isolated work

### For Medium Tasks (4-16 hours)
**Use GSD with BMAD oversight**
- GSD for execution
- BMAD for validation
- Quick planning, fast build

### For Large Initiatives (> 16 hours)
**Use BMAD with GSD components**
- BMAD for planning
- GSD for individual stories
- Quality gates maintained

## Common Mistakes

### ❌ Using GSD for Architecture
Don't use gsd-builder for core system redesign.
→ Use BMAD Architect instead.

### ❌ Using BMAD for Quick Fixes
Don't create a PRD for a 15-minute bug fix.
→ Use gsd-fixer instead.

### ❌ Skipping Tests Entirely
GSD fast ≠ GSD broken.
→ Add basic tests, use gsd-tester.

### ❌ Prototype Lock-in
Don't ship GSD prototypes to production without review.
→ Use BMAD QA before deployment.

### ❌ Time Budget Creep
Don't let 1-hour tasks become 8-hour tasks.
→ Escalate to BMAD if scope grows.

## Getting Started Checklist

- [ ] Read GSD-BMAD-INTEGRATION.md
- [ ] Understand the 11 GSD agents
- [ ] Know when to use GSD vs BMAD
- [ ] Practice with a small task (< 1 hour)
- [ ] Set time budgets for your tasks
- [ ] Use the decision tree for task selection
- [ ] Track results and iterate

## Next Steps

1. **Start Small**: Pick a 30-minute task
2. **Choose GSD Agent**: Use the quick reference
3. **Set Time Budget**: Be realistic but aggressive
4. **Execute**: Start coding within 5 minutes
5. **Ship**: Commit working code
6. **Reflect**: What worked? What didn't?

## Resources

- Full integration guide: `docs/GSD-BMAD-INTEGRATION.md`
- BMAD agents: See `AGENTS.md` in project root
- GSD agent definitions: `.bmad-core/agents/gsd-*.md`
- Task templates: `.bmad-core/tasks/gsd-*.md`

## Quick Help

**I need to...**
- Fix a bug fast → `gsd-fixer`
- Build something quickly → `gsd-builder`
- Test an idea → `gsd-prototyper`
- Debug an issue → `gsd-debugger`
- Speed up code → `gsd-optimizer`
- Connect systems → `gsd-integrator`
- Validate data → `gsd-validator`
- Write docs fast → `gsd-documenter`
- Upgrade code → `gsd-migrator`
- Create a script → `gsd-scripter`
- Add tests → `gsd-tester`

**When stuck:**
1. Is this a GSD task? (< 4 hours, isolated)
2. Have I hit my time budget?
3. Should I escalate to BMAD?

**Remember**: GSD is about momentum. Start fast, iterate quickly, ship often.
