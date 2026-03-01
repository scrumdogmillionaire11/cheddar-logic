# GSD-BMAD Integration Guide

## Overview

This document describes how the **Get Shit Done (GSD)** methodology integrates with the **BMAD-METHOD** framework to create a powerful, action-oriented development environment.

## What is GSD?

**Get Shit Done (GSD)** is an action-oriented AI agent methodology focused on:
- **Rapid execution** over extensive planning
- **Bias toward action** with quick iteration
- **Task decomposition** into immediately executable steps
- **Progress tracking** with visible momentum
- **Error recovery** through quick pivots
- **Outcome focus** rather than process perfection

## Why Integrate GSD with BMAD?

### BMAD Strengths
- ✅ Structured agent personas with clear roles
- ✅ Template-driven documentation
- ✅ Quality gates and validation
- ✅ Comprehensive planning frameworks
- ✅ Multi-agent orchestration

### GSD Strengths
- ✅ Speed and momentum
- ✅ Action bias (build > theorize)
- ✅ Rapid prototyping
- ✅ Quick iteration cycles
- ✅ Practical problem solving

### Combined Power
**BMAD + GSD = Structured Execution**

Use BMAD when you need:
- Comprehensive planning (PRDs, Architecture)
- Multi-stakeholder alignment
- Quality assurance gates
- Long-term maintainability

Use GSD when you need:
- Rapid prototyping
- Quick bug fixes
- Experimental features
- Immediate problem solving

## Integration Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    BMAD Orchestrator                        │
│              (Strategic Planning Layer)                     │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
┌───────▼────────┐       ┌───────▼────────┐
│  BMAD Agents   │       │   GSD Agents   │
│  (Planning)    │       │   (Execution)  │
│                │       │                │
│ • PM           │       │ • Builder      │
│ • Architect    │       │ • Fixer        │
│ • PO           │       │ • Prototyper   │
│ • QA           │       │ • Debugger     │
└────────────────┘       └────────────────┘
```

## GSD Agent Roles

### 1. Builder Agent (ID: `gsd-builder`)
**When to use**: Need to build something quickly without extensive planning

**Capabilities**:
- Rapid feature implementation
- Quick script creation
- Tool integration
- Proof of concept development

**Workflow**:
```bash
As gsd-builder, create a transfer optimization script that:
1. Fetches current team
2. Identifies best transfer
3. Outputs recommendation
Target: Working script in < 30 minutes
```

### 2. Fixer Agent (ID: `gsd-fixer`)
**When to use**: Bug needs fixing NOW

**Capabilities**:
- Root cause analysis
- Quick patches
- Hotfix deployment
- Regression prevention

**Workflow**:
```bash
As gsd-fixer, the injury data isn't loading.
Find and fix it. Budget: 15 minutes.
```

### 3. Prototyper Agent (ID: `gsd-prototyper`)
**When to use**: Need to test an idea quickly

**Capabilities**:
- Throwaway code
- Quick experiments
- A/B comparisons
- Feasibility tests

**Workflow**:
```bash
As gsd-prototyper, test if we can scrape injury data
from premierinjuries.com. Show me working code.
```

### 4. Debugger Agent (ID: `gsd-debugger`)
**When to use**: Complex issue needs investigation

**Capabilities**:
- Deep debugging
- Performance profiling
- State inspection
- Log analysis

**Workflow**:
```bash
As gsd-debugger, why is the captain selection
returning None? Trace execution and fix.
```

### 5. Optimizer Agent (ID: `gsd-optimizer`)
**When to use**: Code works but needs improvement

**Capabilities**:
- Performance tuning
- Code refactoring
- Algorithm optimization
- Resource efficiency

**Workflow**:
```bash
As gsd-optimizer, the transfer calculation takes
3 seconds. Make it under 500ms.
```

### 6. Integrator Agent (ID: `gsd-integrator`)
**When to use**: Need to connect systems quickly

**Capabilities**:
- API integration
- Service connection
- Data pipeline setup
- Third-party tool hookup

**Workflow**:
```bash
As gsd-integrator, connect our injury feed to
the FPL API data. Make it seamless.
```

### 7. Validator Agent (ID: `gsd-validator`)
**When to use**: Need quick quality checks

**Capabilities**:
- Sanity testing
- Output verification
- Data validation
- Quick QA passes

**Workflow**:
```bash
As gsd-validator, verify all 615 players have
valid team_ids and no null values in critical fields.
```

### 8. Documenter Agent (ID: `gsd-documenter`)
**When to use**: Need docs fast, not perfect

**Capabilities**:
- README creation
- API documentation
- Quick reference guides
- Inline comments

**Workflow**:
```bash
As gsd-documenter, create a README for the
injury enrichment system. Focus on usage, not theory.
```

### 9. Migrator Agent (ID: `gsd-migrator`)
**When to use**: Need to move/upgrade code quickly

**Capabilities**:
- Version upgrades
- Framework migrations
- Data migrations
- Legacy code updates

**Workflow**:
```bash
As gsd-migrator, upgrade all Python 3.8 code
to 3.11 syntax. Start with type hints.
```

### 10. Scripter Agent (ID: `gsd-scripter`)
**When to use**: Need automation scripts fast

**Capabilities**:
- CLI tools
- Automation scripts
- Data processing
- Batch operations

**Workflow**:
```bash
As gsd-scripter, create a script to prune old
snapshots, keeping only the latest 10 per season.
```

### 11. Tester Agent (ID: `gsd-tester`)
**When to use**: Need test coverage quickly

**Capabilities**:
- Unit test generation
- Integration tests
- Regression tests
- Test automation

**Workflow**:
```bash
As gsd-tester, create tests for the injury
resolution logic. Cover the main 3 scenarios.
```

## GSD Task Framework

### Core GSD Tasks

#### 1. **quick-build** (ID: `gsd-quick-build`)
Build a working feature in < 1 hour

**Process**:
1. Understand requirement (5 min)
2. Write minimal code (30 min)
3. Test manually (10 min)
4. Document basics (10 min)
5. Deploy/commit (5 min)

#### 2. **rapid-fix** (ID: `gsd-rapid-fix`)
Fix a bug in < 30 minutes

**Process**:
1. Reproduce issue (5 min)
2. Identify root cause (10 min)
3. Implement fix (10 min)
4. Verify fix (5 min)

#### 3. **fast-prototype** (ID: `gsd-fast-prototype`)
Validate an idea in < 2 hours

**Process**:
1. Define success criteria (10 min)
2. Build throwaway code (60 min)
3. Test hypothesis (30 min)
4. Document findings (20 min)

#### 4. **speed-optimize** (ID: `gsd-speed-optimize`)
Improve performance significantly in < 1 hour

**Process**:
1. Profile current state (15 min)
2. Identify bottleneck (15 min)
3. Implement optimization (20 min)
4. Verify improvement (10 min)

#### 5. **emergency-debug** (ID: `gsd-emergency-debug`)
Debug critical issue in < 45 minutes

**Process**:
1. Gather symptoms (5 min)
2. Add logging/traces (10 min)
3. Reproduce with visibility (15 min)
4. Fix and verify (15 min)

## Decision Framework: BMAD vs GSD

### Use BMAD When:
- ❓ Multiple stakeholders need alignment
- ❓ Long-term architecture is critical
- ❓ Quality gates are required
- ❓ Comprehensive documentation needed
- ❓ Multi-sprint epic planning
- ❓ New features affecting core systems

**Example**: "We need to redesign the transfer recommendation engine"
→ Use PM + Architect + PO workflow

### Use GSD When:
- ⚡ Need results in minutes/hours
- ⚡ Experimenting or prototyping
- ⚡ Bug needs immediate fix
- ⚡ Quick script/tool needed
- ⚡ Validating feasibility
- ⚡ Isolated improvement

**Example**: "Fix the injury data loader breaking on null values"
→ Use gsd-fixer

### Use Both When:
- 🔄 BMAD for planning, GSD for execution
- 🔄 BMAD for architecture, GSD for components
- 🔄 BMAD for epic, GSD for stories
- 🔄 Prototype with GSD, productionize with BMAD

**Example**: "Add injury prediction feature"
→ PM creates PRD (BMAD)
→ gsd-prototyper tests ML models (GSD)
→ Architect designs integration (BMAD)
→ gsd-builder implements MVP (GSD)
→ QA validates (BMAD)

## Integration Patterns

### Pattern 1: Rapid Prototype → Structured Implementation

```bash
# Phase 1: GSD Prototype (2 hours)
As gsd-prototyper, test injury prediction using:
1. scikit-learn RandomForest
2. Simple feature engineering
3. Show accuracy on test data

# Phase 2: BMAD Planning (if prototype succeeds)
As architect, design production injury prediction:
- Integration points
- Model versioning
- API contracts
- Monitoring strategy

# Phase 3: GSD Build
As gsd-builder, implement production version
following architecture doc

# Phase 4: BMAD Quality
As qa, validate against requirements
```

### Pattern 2: BMAD Epic → GSD Stories

```bash
# Epic: PM/PO creates detailed epic with stories

# Story 1: gsd-builder implements
As gsd-builder, implement story 1.1
Target: 4 hours, working code

# Story 2: gsd-integrator connects
As gsd-integrator, integrate 1.1 with API
Target: 2 hours, end-to-end flow

# Story 3: gsd-tester validates
As gsd-tester, create test suite for epic
Target: 3 hours, 80% coverage
```

### Pattern 3: Emergency → Learning → Prevention

```bash
# Emergency: GSD fixes immediately
As gsd-fixer, production is down - injury feed failing
Fix NOW. Budget: 15 minutes.

# Learning: BMAD analyzes root cause
As architect, why did this fail?
Document failure mode and prevention strategy.

# Prevention: GSD implements safeguards
As gsd-builder, implement circuit breaker for
injury feed. Budget: 1 hour.
```

## GSD Commands & Workflows

### Quick Reference

```bash
# Build something fast
As gsd-builder, create [feature]

# Fix something broken
As gsd-fixer, fix [issue]

# Test an idea
As gsd-prototyper, validate [hypothesis]

# Debug an issue
As gsd-debugger, investigate [problem]

# Optimize performance
As gsd-optimizer, improve [bottleneck]

# Connect systems
As gsd-integrator, connect [system A] to [system B]

# Validate output
As gsd-validator, verify [data/output]

# Document quickly
As gsd-documenter, document [feature/system]

# Migrate code
As gsd-migrator, upgrade [component]

# Create scripts
As gsd-scripter, automate [task]

# Add tests
As gsd-tester, test [component]
```

### Time Budgets

GSD operates with strict time constraints:

- **Quick Fix**: 15-30 minutes
- **Feature Build**: 1-4 hours
- **Prototype**: 2-4 hours
- **Integration**: 2-6 hours
- **Optimization**: 1-2 hours
- **Documentation**: 30-90 minutes

**Rule**: If it takes longer, escalate to BMAD for proper planning.

## Best Practices

### GSD Principles

1. **Start Fast**: Begin coding within 5 minutes
2. **Iterate Quickly**: Working > perfect
3. **Time-box Everything**: Set hard limits
4. **Fail Fast**: If stuck, pivot or escalate
5. **Document Last**: Code first, docs second
6. **Test Enough**: Not every edge case
7. **Ship Often**: Commit early and often

### Integration Guidelines

1. **Know Your Mode**: BMAD or GSD, not both simultaneously
2. **Switch Consciously**: Declare mode changes
3. **Track Context**: Which agent did what
4. **Preserve Quality**: GSD fast ≠ GSD sloppy
5. **Escalate Wisely**: Recognize when GSD isn't appropriate

### Anti-Patterns to Avoid

❌ **Over-planning in GSD mode**
- Don't create PRDs for 1-hour tasks

❌ **Under-planning in BMAD mode**
- Don't skip architecture for core features

❌ **Mode confusion**
- Mixing GSD speed with BMAD rigor

❌ **Prototype lock-in**
- GSD prototypes shouldn't reach production

❌ **Quality bypass**
- GSD fast doesn't mean skip tests entirely

## Real-World Examples

### Example 1: Injury Feed Integration

**Scenario**: Need to add secondary injury data source

**BMAD Approach** (if building from scratch):
- PM creates PRD (2 hours)
- Architect designs integration (3 hours)
- Dev implements with full testing (8 hours)
- QA validates (2 hours)
- **Total: 15 hours**

**GSD Approach** (for quick addition):
- gsd-prototyper tests API (1 hour)
- gsd-integrator adds to pipeline (2 hours)
- gsd-validator verifies data quality (1 hour)
- **Total: 4 hours**

**Best Approach**: GSD for MVP, BMAD for production hardening

### Example 2: Transfer Recommendation Bug

**Scenario**: Captain selection returning None

**Pure BMAD**: Too slow for production issue
**Pure GSD**: 
```bash
As gsd-debugger, captain selection bug
1. Add logging to captain_selector.py
2. Reproduce with test data
3. Found: null check missing in line 47
4. Fix + verify
Time: 20 minutes
```

### Example 3: New Feature - Chip Predictor

**Scenario**: Predict best GW for each chip

**Hybrid Approach**:
```bash
# Week 1: GSD Prototype
As gsd-prototyper, build chip predictor prototype
- Load fixture data
- Calculate bench boost potential
- Show top 3 GWs
Time: 3 hours

# Week 2: BMAD Planning (if prototype valuable)
As pm, create PRD for chip prediction feature
As architect, design production implementation

# Week 3: GSD Build
As gsd-builder, implement production version
As gsd-tester, create test suite

# Week 4: BMAD Quality
As qa, validate against acceptance criteria
```

## Migration Path

### Phase 1: Add GSD Agents (Week 1)
- Create `.bmad-core/agents/gsd-*.md` files
- Update AGENTS.md with GSD section
- Train team on GSD vs BMAD usage

### Phase 2: Integrate Workflows (Week 2)
- Create GSD task templates
- Document decision framework
- Create quick reference guide

### Phase 3: Pilot Projects (Week 3-4)
- Use GSD for small features
- Collect feedback
- Refine integration

### Phase 4: Full Integration (Week 5+)
- GSD default for quick tasks
- BMAD default for planning
- Hybrid approach for complex work

## Conclusion

**GSD + BMAD = Balanced Development**

- Use **BMAD** for strategic planning and quality
- Use **GSD** for tactical execution and speed
- Use **both** for complex initiatives

The integration creates a development environment that can:
- Plan comprehensively when needed (BMAD)
- Execute rapidly when possible (GSD)
- Maintain quality throughout (both)
- Adapt to changing requirements (hybrid)

**Remember**: The best methodology is the one that ships working software. Choose based on context, not dogma.
