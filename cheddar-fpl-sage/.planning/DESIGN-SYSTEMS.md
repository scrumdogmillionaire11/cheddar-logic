## Part 2: Standalone Design System Document

**Save this as `docs/design-system.md`:**

---

# FPL Sage Design System

**Version:** 1.0  
**Date:** January 19, 2026  
**Philosophy:** Clinical intelligence, not hype. Decision console for serious FPL managers.

---

## Table of Contents

1. Design Principles
2. Color Palette
3. Typography
4. Spacing & Layout
5. Component Library
6. Interaction Patterns
7. Data Visualization
8. Voice & Tone
9. Implementation Notes

---

## Design Principles

### 1. Clinical Intelligence, Not Hype

**What this means:**
- Zero marketing language in the UI ("must-have", "smash", "lock")
- Information density over whitespace
- Muted, matte aesthetics (no neon, no gradients)
- User is operator, not consumer

**Visual test:**
> If someone opens the site and thinks "Oh… this expects me to think" → you nailed it.

### 2. Calm Authority

**Mood:**
- Serious, slightly intimidating (in a good way)
- Confident without arrogance
- Transparent about uncertainty

**Not:**
- Playful (Official FPL site)
- Loud (Fantasy content blogs)
- Gamified (Betting apps)
- Busy (TradingView clones)

### 3. Information First, Always

**Hierarchy:**
- Data > Context > Explanation > UI chrome
- Numbers carry more visual weight than words
- Labels are quiet; values are bold
- No "hero banners" wasting vertical space

### 4. Transparency as Design

**Every meaningful number should:**
- Reveal assumptions on hover
- Show deltas (change over time)
- Expose uncertainty/confidence levels
- Link to source data

**Example:**
```
Projected Points: 6.1
[Hover reveals:]
  Minutes assumption: 85'
  Role: Central Midfielder
  Opponent difficulty: +0.3
  Injury volatility: LOW
```

---

## Color Palette

### Dark Mode (Default)

**Foundation Colors:**

```css
--bg-primary: #0A0A0A;        /* Near-black background */
--bg-secondary: #1A1A1A;      /* Elevated surfaces (cards) */
--bg-tertiary: #2A2A2A;       /* Hover states */

--text-primary: #E5E5E5;      /* Off-white, primary text */
--text-secondary: #A1A1A1;    /* Slate, secondary text */
--text-tertiary: #6B6B6B;     /* Muted labels */

--border-primary: #2A2A2A;    /* Subtle borders */
--border-secondary: #3A3A3A;  /* Emphasized borders */
```

**Accent Colors (Use Sparingly):**

```css
--accent-green: #4A7C59;      /* Approval, edge, positive signal */
--accent-amber: #B8860B;      /* Caution, uncertainty */
--accent-red: #A24040;        /* Risk, downgrade, negative signal */

--accent-blue: #4A6B7C;       /* Informational (rare use) */
```

**Usage Rules:**
- Accents are **signals**, not decoration
- Green: Player upgrade, edge detected, model confidence HIGH
- Amber: Uncertainty flag, minutes risk, model confidence MEDIUM
- Red: Downgrade signal, injury risk, model confidence LOW
- Never use gradients, never animate colors

### Light Mode (Future, Optional)

**If light mode is added (Phase 2+):**
- Inverse foundation colors (white bg, dark text)
- Same muted accent palette (don't brighten)
- Maintain clinical aesthetic (avoid pastels)

---

## Typography

### Font Families

**Primary Font Stack:**

```css
--font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 
             'Roboto', 'Helvetica Neue', Arial, sans-serif;
```

**Why Inter:**
- Modern grotesk, humanist sans
- Excellent readability at small sizes
- **Tabular numerals** (all numbers align vertically)
- Variable font (1 file, multiple weights)
- Free, open-source

**Monospace Font Stack (For Projections, Deltas):**

```css
--font-mono: 'IBM Plex Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
```

**Why IBM Plex Mono:**
- Clear distinction between similar characters (0 vs O, 1 vs l)
- Tabular by design
- Consistent digit width
- Free, open-source

### Font Sizes (Mobile-First)

**Base size: 16px**

```css
--text-xs: 0.75rem;    /* 12px - Tiny labels */
--text-sm: 0.875rem;   /* 14px - Secondary text */
--text-base: 1rem;     /* 16px - Body text */
--text-lg: 1.125rem;   /* 18px - Emphasized text */
--text-xl: 1.25rem;    /* 20px - Card headings */
--text-2xl: 1.5rem;    /* 24px - Section headings */
--text-3xl: 1.875rem;  /* 30px - Page headings (MAX) */
```

**Rules:**
- No font size >30px (no hero headlines)
- Headlines are understated, not huge
- Numeric values often larger than labels

### Font Weights

```css
--font-normal: 400;
--font-medium: 500;   /* Use for emphasis */
--font-semibold: 600; /* Use for headings */
--font-bold: 700;     /* Use for critical data */
```

**Hierarchy Example:**

```
Projected Points     6.1     ← font-bold, text-2xl, mono
Market Avg           5.4     ← font-medium, text-base, mono
Delta               +0.7     ← font-semibold, text-lg, mono, accent-green
```

### Tabular Numerals (CRITICAL)

**Always enable tabular numerals for:**
- Projected points
- Deltas
- Rankings
- Prices
- Percentages

```css
font-variant-numeric: tabular-nums;
/* Or in Tailwind: */
.tabular-nums
```

**Why:** Numbers must align vertically for scanning efficiency.

---

## Spacing & Layout

### Spacing Scale

**Base unit: 4px (0.25rem)**

```css
--space-1: 0.25rem;   /* 4px */
--space-2: 0.5rem;    /* 8px */
--space-3: 0.75rem;   /* 12px */
--space-4: 1rem;      /* 16px */
--space-6: 1.5rem;    /* 24px */
--space-8: 2rem;      /* 32px */
--space-12: 3rem;     /* 48px */
--space-16: 4rem;     /* 64px */
```

**Usage:**
- Tight rhythm inside cards (space-2, space-3)
- Breathing room between cards (space-6, space-8)
- Never use space-16 (too much whitespace)

### Grid System

**12-column grid with breakpoints:**

```css
/* Mobile first */
--container-sm: 640px;   /* Small tablets */
--container-md: 768px;   /* Tablets */
--container-lg: 1024px;  /* Small desktop */
--container-xl: 1280px;  /* Desktop */
--container-2xl: 1536px; /* Large desktop (MAX) */
```

**Layout Philosophy:**
- Dense, but breathable
- No "hero sections" wasting vertical space
- Cards with tight vertical rhythm
- Grid-based alignment (everything aligns to baseline)

### Card Design

**Standard Card:**

```css
.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}

.card-dense {
  /* For high-density data displays */
  padding: var(--space-3);
  margin-bottom: var(--space-3);
}
```

**Rules:**
- Cards are **containers for decisions**, not decoration
- Minimal shadow (0px 1px 3px rgba(0,0,0,0.3))
- No card borders >1px
- No rounded corners >8px

---

## Component Library

### 1. Transfer Recommendation Card

**Visual Structure:**

```
┌─────────────────────────────────────────────┐
│ 🚨 PRIORITY 1: High Risk                   │
├─────────────────────────────────────────────┤
│                                             │
│ OUT: Bruno Fernandes (MUN)                 │
│ ├─ Status: ⚠️ Injured                      │
│ ├─ Next GW: 0.0 pts                        │
│ └─ Price: £8.3m → £8.2m                   │
│                                             │
│ IN: Kevin De Bruyne (MCI)                  │
│ ├─ Fixture: vs Brighton (Easy)             │
│ ├─ Next GW: 8.3 pts                        │
│ └─ Price: £9.5m                            │
│                                             │
│ Expected Gain: +8.3 pts                    │
│ Cost: Free Transfer                         │
│                                             │
│ [Accept] [Save] [Dismiss]                  │
└─────────────────────────────────────────────┘
```

**CSS Specs:**

```css
.transfer-card {
  background: var(--bg-secondary);
  border-left: 4px solid var(--accent-red); /* Priority color */
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}

.player-out {
  color: var(--text-secondary);
  text-decoration: line-through;
}

.player-in {
  color: var(--text-primary);
  font-weight: var(--font-semibold);
}

.expected-gain {
  font-family: var(--font-mono);
  font-size: var(--text-xl);
  font-weight: var(--font-bold);
  color: var(--accent-green);
}
```

### 2. Captain Recommendation Card

**Visual Structure:**

```
┌─────────────────────────────────────────────┐
│ CAPTAIN: Mohamed Salah                     │
│ Expected Points: 9.4                       │
├─────────────────────────────────────────────┤
│ Fixture: LIV vs NFO (H)                    │
│ Difficulty: Easy (2/5)                     │
│ Ownership: 45%                             │
│                                             │
│ [Hover for reasoning]                      │
└─────────────────────────────────────────────┘
```

**Hover State Reveals:**

```
┌─────────────────────────────────────────────┐
│ Why Salah?                                 │
├─────────────────────────────────────────────┤
│ • Form: 8.2 avg last 3 GWs                 │
│ • Opponent xG conceded: 1.8/game           │
│ • Minutes certainty: HIGH (90'+)           │
│ • Home advantage: +0.4 pts                 │
│ • Model confidence: HIGH                   │
└─────────────────────────────────────────────┘
```

### 3. Chip Timing Card

**Visual Structure:**

```
┌─────────────────────────────────────────────┐
│ 🎯 BENCH BOOST                             │
├─────────────────────────────────────────────┤
│ Current GW (18): 6.2 pts potential         │
│ Best Window: GW21 (11.8 pts)              │
│                                             │
│ 💡 RECOMMENDATION: WAIT                    │
│ Gain if delayed: +5.6 pts                 │
│                                             │
│ [Remind Me GW21] [View DGW Details]       │
└─────────────────────────────────────────────┘
```

**Color Coding:**
- WAIT: Amber border
- USE NOW: Green border
- UNCERTAIN: No border, just text

### 4. Data Table (Compact)

**For player comparisons, fixture analysis:**

```
┌──────────────┬─────────┬──────────┬──────────┐
│ Player       │ Next GW │ Next 6   │ Price    │
├──────────────┼─────────┼──────────┼──────────┤
│ Salah        │   9.4   │   52.1   │  £13.5m  │
│ Haaland      │   8.9   │   48.3   │  £14.2m  │
│ Saka         │   7.2   │   41.7   │  £9.8m   │
└──────────────┴─────────┴──────────┴──────────┘
```

**CSS Specs:**

```css
.data-table {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  border-collapse: collapse;
}

.data-table th {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  text-align: right;
  padding: var(--space-2);
  border-bottom: 1px solid var(--border-primary);
}

.data-table td {
  font-size: var(--text-sm);
  color: var(--text-primary);
  text-align: right;
  padding: var(--space-2);
}
```

### 5. Progress Bar (Real-Time Analysis)

**Visual Structure:**

```
┌─────────────────────────────────────────────┐
│ Running Analysis...                        │
│                                             │
│ ████████████░░░░░░░░ 60%                   │
│                                             │
│ Fetching 615 players...                    │
│ Estimated: 4 seconds remaining             │
└─────────────────────────────────────────────┘
```

**CSS Specs:**

```css
.progress-bar {
  height: 4px;
  background: var(--border-primary);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent-green);
  transition: width 0.3s ease;
}
```

### 6. Button Styles

**Primary Button (Call to Action):**

```css
.btn-primary {
  background: var(--accent-green);
  color: var(--bg-primary);
  padding: var(--space-3) var(--space-6);
  font-weight: var(--font-semibold);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-primary:hover {
  background: #5A8C69; /* Lighter green */
}
```

**Secondary Button:**

```css
.btn-secondary {
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border-secondary);
  padding: var(--space-3) var(--space-6);
  border-radius: 6px;
  cursor: pointer;
}

.btn-secondary:hover {
  background: var(--bg-tertiary);
}
```

**Destructive Button:**

```css
.btn-destructive {
  background: transparent;
  color: var(--accent-red);
  border: 1px solid var(--accent-red);
  padding: var(--space-3) var(--space-6);
  border-radius: 6px;
}
```

---

## Interaction Patterns

### 1. Hover States (Critical for Transparency)

**Every meaningful number should have a hover tooltip:**

```html
<span class="tooltip-trigger" data-tooltip="Minutes assumption: 85', Role: CM">
  Projected: 6.1 pts
</span>
```

**Tooltip Design:**

```css
.tooltip {
  background: var(--bg-primary);
  border: 1px solid var(--border-secondary);
  padding: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  max-width: 200px;
  border-radius: 4px;
  box-shadow: 0 4px 6px rgba(0,0,0,0.5);
}
```

**What tooltips should reveal:**
- Assumptions (minutes, role, opponent)
- Confidence level (LOW/MEDIUM/HIGH)
- Data source (FPL API, injury news)
- Last updated timestamp

### 2. Loading States

**Analysis in progress:**
- Show progress bar (not spinner)
- Display current phase ("Fetching players...", "Analyzing fixtures...")
- Estimated time remaining
- Never block UI (allow background browsing)

**Skeleton Screens (Page Load):**
- Use subtle animated pulse
- Match layout of final content
- No colorful loading indicators

### 3. Error States

**Error Message Design:**

```
┌─────────────────────────────────────────────┐
│ Analysis Failed                            │
├─────────────────────────────────────────────┤
│ FPL API is temporarily unavailable.        │
│                                             │
│ Try again in 2 minutes.                    │
│                                             │
│ [Retry Analysis]                           │
└─────────────────────────────────────────────┘
```

**Tone:**
- Calm, not panicked
- Specific, not vague ("API unavailable" not "Something went wrong")
- Actionable ("Retry" button, "Try in 2 minutes")

### 4. Form Inputs

**Text Input:**

```css
.input {
  background: var(--bg-primary);
  border: 1px solid var(--border-primary);
  color: var(--text-primary);
  padding: var(--space-3);
  border-radius: 6px;
  font-size: var(--text-base);
}

.input:focus {
  outline: none;
  border-color: var(--accent-green);
  box-shadow: 0 0 0 3px rgba(74, 124, 89, 0.1);
}
```

### 5. Mobile Touch Targets

**Minimum touch target: 44px × 44px**

```css
.btn, .card, .link {
  min-height: 44px;
  min-width: 44px;
}
```

**Why:** iOS Human Interface Guidelines, accessibility

---

## Data Visualization

### 1. Chip Timing Calendar

**Visual Example:**

```
GW18   GW19   GW20   GW21   GW22   GW23
 │      │      │   ┌──────────┐    │
 │      │      │   │  🎯 BEST │    │
 │      │      │   │  WINDOW  │    │
 │      │      │   │  11.8pts │    │
 │      │      │   └──────────┘    │
6.2pts 5.4pts 8.1pts            7.9pts
```

**Design:**
- Horizontal timeline (mobile: scrollable)
- Bar chart for potential points
- Highlight best window (green border)
- Muted colors (no bright bars)

### 2. Expected Points Bar Chart

**Compact, inline visualizations:**

```
Salah    ████████░░ 8.9 pts
Haaland  ███████░░░ 7.2 pts
Saka     █████░░░░░ 5.4 pts
```

**CSS:**

```css
.bar-chart {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.bar {
  height: 4px;
  background: var(--accent-green);
  border-radius: 2px;
}
```

### 3. Confidence Indicators

**Not colored badges, but structured signals:**

```
Model Confidence: HIGH
├─ Data quality: 95%
├─ Historical accuracy: 72%
└─ Uncertainty range: ±1.2 pts
```

**Visual:**
- Text-based, not icons
- Hierarchy through indentation
- Hover reveals detail

---

## Voice & Tone

### Language Principles

**1. No Marketing Language**

❌ **Never say:**
- "Smash"
- "Must-have"
- "Lock"
- "Don't miss"
- "Hot pick"
- "Differential gem"

✅ **Instead say:**
- "Edge detected"
- "Role volatility"
- "Minutes risk"
- "Model confidence: LOW / MEDIUM / HIGH"
- "Upgrade opportunity"
- "Low ownership, high potential"

**2. Precision Over Personality**

❌ **Avoid:**
- "Salah is on fire!" 🔥
- "This is a no-brainer!"
- "You NEED this player!"

✅ **Use:**
- "Salah: 8.2 avg last 3 GWs"
- "Expected points advantage: +2.1"
- "Recommend upgrade based on fixture run"

**3. Transparent Uncertainty**

**When model is uncertain:**
- Don't hide it with confident language
- Explicitly flag uncertainty

❌ **Bad:**
> "Saka will score big this week!"

✅ **Good:**
> "Saka: 6.1 projected pts (model confidence: MEDIUM - minutes risk due to UCL fixture)"

**4. Explanatory, Not Prescriptive**

**The UI never commands. It explains.**

❌ **Bad:**
> "Transfer out Bruno NOW!"

✅ **Good:**
> "Bruno: Injured, no return date. Expected points next 6 GWs: 0.0. Recommend downgrade to fund midfield upgrade."

### Microcopy Examples

**Empty States:**

```
No analyses run yet.

Enter your FPL Team ID to get started.

[Run First Analysis]
```

**Success States:**

```
Analysis complete.

3 transfer opportunities identified.
```

**Upgrade Prompts (Freemium → Paid):**

```
You've used 2/2 free analyses this gameweek.

Upgrade for unlimited analyses + advanced chip calendar.

[View Plans]
```

---

## Implementation Notes

### Tech Stack Alignment

**Frontend:**
- **Framework:** React + TypeScript
- **Styling:** Tailwind CSS (custom config with design tokens)
- **UI Components:** shadcn/ui (customize to match aesthetic)
- **Icons:** Lucide React (simple, geometric icons)

**Tailwind Config Example:**

```js
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#0A0A0A',
          secondary: '#1A1A1A',
          tertiary: '#2A2A2A',
        },
        text: {
          primary: '#E5E5E5',
          secondary: '#A1A1A1',
          tertiary: '#6B6B6B',
        },
        accent: {
          green: '#4A7C59',
          amber: '#B8860B',
          red: '#A24040',
          blue: '#4A6B7C',
        },
        border: {
          primary: '#2A2A2A',
          secondary: '#3A3A3A',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
      },
      spacing: {
        // Custom spacing scale if needed
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
  ],
}
```

### Component Library

**Use shadcn/ui as base, customize:**

```bash
npx shadcn-ui@latest init
npx shadcn-ui@latest add button card
```

**Then override styles:**

```css
/* components.css */
.btn {
  /* Override shadcn defaults to match FPL Sage aesthetic */
}
```

### Accessibility

**WCAG 2.1 AA Compliance:**

✅ **Color Contrast:**
- Text primary on bg primary: 15:1 (exceeds 4.5:1 requirement)
- Text secondary on bg primary: 8:1 (exceeds 4.5:1 requirement)
- Accent green on bg primary: 4.8:1 (meets 4.5:1 for large text)

✅ **Keyboard Navigation:**
- All interactive elements focusable
- Focus visible (green outline)
- Logical tab order

✅ **Screen Readers:**
- Semantic HTML (`<nav>`, `<main>`, `<article>`)
- ARIA labels for icons
- Alt text for images (if any)

### Performance

**Design for Speed:**

- No custom fonts >2 files (Inter variable + IBM Plex Mono)
- Minimal shadows (box-shadow is expensive)
- No animations >300ms
- Lazy load images (if any)
- Critical CSS inline

**Lighthouse Score Targets:**
- Performance: 90+
- Accessibility: 100
- Best Practices: 100
- SEO: 100

---

## Design System Governance

### When to Update This Document

**Update when:**
- New components are created
- Color palette changes (rare)
- Typography adjustments (rare)
- New interaction patterns emerge
- Voice/tone evolves

**Version Control:**
- Increment version number (1.0 → 1.1)
- Document changes in changelog
- Review quarterly (or after major feature releases)

### How to Propose Changes

**Design changes should:**
1. Align with core principles (clinical intelligence, not hype)
2. Be validated with user testing (5-10 target users)
3. Consider accessibility impact
4. Not break existing component library

**Process:**
1. Propose change in design doc
2. Create prototype/mockup
3. Test with users
4. Update design system
5. Implement in codebase

---

## Quick Reference

### Color Variables (Copy/Paste)

```css
:root {
  --bg-primary: #0A0A0A;
  --bg-secondary: #1A1A1A;
  --bg-tertiary: #2A2A2A;
  
  --text-primary: #E5E5E5;
  --text-secondary: #A1A1A1;
  --text-tertiary: #6B6B6B;
  
  --accent-green: #4A7C59;
  --accent-amber: #B8860B;
  --accent-red: #A24040;
  --accent-blue: #4A6B7C;
  
  --border-primary: #2A2A2A;
  --border-secondary: #3A3A3A;
}
```

### Typography (Copy/Paste)

```css
body {
  font-family: 'Inter', -apple-system, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--bg-primary);
}

.mono {
  font-family: 'IBM Plex Mono', monospace;
  font-variant-numeric: tabular-nums;
}
```

### Component Classes (Copy/Paste)

```html
<!-- Card -->
<div class="bg-bg-secondary border border-border-primary rounded-lg p-4">
  Card content
</div>

<!-- Button Primary -->
<button class="bg-accent-green text-bg-primary px-6 py-3 rounded-md font-semibold">
  Accept
</button>

<!-- Data Row -->
<div class="flex justify-between items-center py-2 border-b border-border-primary">
  <span class="text-text-secondary text-sm">Projected Points</span>
  <span class="font-mono font-bold text-xl">6.1</span>
</div>
```

---

**Design System Version:** 1.0  
**Last Updated:** January 19, 2026  
**Maintained by:** FPL Sage Design Team  
**Questions?** Reference this document. If unclear, default to: "Clinical intelligence, not hype."

---

Perfect! Now you have:

1. **Appendix D for Project Brief** - Strategic summary of design philosophy
2. **Full Design System Document** - Tactical implementation specs (colors, typography, components, everything a developer needs)

These documents together ensure:
- ✅ PM/designers understand the "why" (positioning, differentiation)
- ✅ Developers have exact specs (hex codes, CSS, component patterns)
- ✅ Consistent aesthetic across all features
- ✅ Design as competitive moat (competitors can't easily copy a vibe)

