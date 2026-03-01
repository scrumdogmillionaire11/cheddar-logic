# Phase 3: Frontend Core - GSD Execution Plan

**Status:** Ready to Execute
**Created:** 2026-01-29
**Approach:** GSD (Get Shit Done) - Working software in hours, not days

## Decisions Locked

✅ **Framework:** Vite + React + TypeScript  
✅ **Deployment:** Separate dev server (port 5173), FastAPI serves static build in prod  
✅ **State Management:** React Query for server state, local state for UI  
✅ **Real-time:** WebSocket for progress updates  
✅ **Scope:** Core flow first (Entry → Progress → Results), reasoning drawer later  

## Time Budget: 16-21 Hours (Split into 4 GSD Sprints)

---

## Sprint 1: Foundation (4-6 hours)

**Goal:** Vite project running with routing and API client ready

**Time Budget:** 4-6 hours  
**Success:** Can navigate between 3 routes, API client configured

### Tasks

**1.1 Project Setup (60 min)**
- [ ] Create `/frontend` directory
- [ ] Initialize Vite with React + TypeScript template
- [ ] Install dependencies:
  - `react-router-dom` (routing)
  - `@tanstack/react-query` (server state)
  - `tailwindcss` + `postcss` + `autoprefixer`
  - `@radix-ui/react-*` primitives (via shadcn/ui)
- [ ] Configure Tailwind (dark mode class strategy)
- [ ] Setup tsconfig.json with path aliases (`@/components`, `@/lib`)

**1.2 shadcn/ui Setup (30 min)**
- [ ] Install shadcn/ui CLI
- [ ] Initialize components directory structure
- [ ] Add base components:
  - Button
  - Input
  - Card
  - Progress
  - Tabs
- [ ] Configure theme with clinical/dark aesthetic

**1.3 Routing Setup (45 min)**
- [ ] Create route structure:
  ```
  /               → Landing/Team Entry
  /analyze/:id    → Progress Screen
  /results/:id    → Results Dashboard
  ```
- [ ] Add 404 page
- [ ] Add basic layout wrapper (header optional for MVP)

**1.4 API Client Foundation (90 min)**
- [ ] Create `lib/api.ts` with fetch wrapper
- [ ] Add error handling (network, 4xx, 5xx)
- [ ] Add types for API responses:
  ```ts
  interface AnalysisJob {
    analysis_id: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    progress: number;
    phase: string;
    results?: AnalysisResults;
    error?: string;
  }
  ```
- [ ] Setup React Query client with defaults
- [ ] Add dev proxy in vite.config.ts (`/api` → `http://localhost:8000`)

**1.5 Basic Smoke Test (30 min)**
- [ ] Verify all routes render
- [ ] Test API client with mock data
- [ ] Verify Tailwind classes work
- [ ] Check dark mode toggle works

**Deliverable:** Empty routes exist, can start building screens

---

## Sprint 2: Team Entry Flow (3-4 hours)

**Goal:** User can enter team ID and trigger analysis

**Time Budget:** 3-4 hours  
**Success:** Clicking "Analyze" creates job and navigates to /analyze/:id

### Tasks

**2.1 Landing Page UI (90 min)**
- [ ] Create `pages/Landing.tsx`
- [ ] Add hero section with value prop text
- [ ] Add team ID input field (shadcn Input)
- [ ] Add validation:
  - Required field
  - Number only
  - Range 1-20,000,000
- [ ] Add "Analyze Team" button (disabled when invalid)
- [ ] Add loading state while POST in flight

**2.2 Team Entry Logic (60 min)**
- [ ] Create mutation hook `useCreateAnalysis()`
- [ ] POST to `/api/v1/analyze` with team_id
- [ ] Handle success: navigate to `/analyze/{analysis_id}`
- [ ] Handle errors:
  - Network failure → show retry button
  - Validation error → show field error
  - Rate limit → show message with retry-after time

**2.3 Polish & Accessibility (45 min)**
- [ ] Add keyboard shortcuts (Enter to submit)
- [ ] Add focus states on input
- [ ] Ensure 44px touch targets on mobile
- [ ] Add aria-labels for screen readers
- [ ] Test on mobile viewport (320px)

**Deliverable:** Working team entry that creates analysis jobs

---

## Sprint 3: Progress Screen (4-5 hours)

**Goal:** Real-time progress display with WebSocket updates

**Time Budget:** 4-5 hours  
**Success:** Progress bar updates live, auto-navigates when complete

### Tasks

**3.1 Progress Page Structure (60 min)**
- [ ] Create `pages/Progress.tsx`
- [ ] Get `analysis_id` from route params
- [ ] Add progress bar component (shadcn Progress)
- [ ] Add current phase display
- [ ] Add ETA estimate (optional - can hardcode "~30 seconds" for MVP)

**3.2 WebSocket Integration (120 min)**
- [ ] Create `lib/websocket.ts` helper
- [ ] Connect to `ws://localhost:8000/api/v1/analyze/{id}/stream`
- [ ] Handle WebSocket messages:
  ```ts
  type WSMessage = 
    | { type: 'progress', progress: number, phase: string }
    | { type: 'complete', results: AnalysisResults }
    | { type: 'error', error: string }
  ```
- [ ] Update progress state on messages
- [ ] Auto-reconnect on disconnect (3 retries)
- [ ] Close connection when component unmounts

**3.3 Navigation Logic (45 min)**
- [ ] Navigate to `/results/{id}` when type='complete'
- [ ] Show error modal when type='error'
- [ ] Add "View Results" button that appears on completion
- [ ] Add polling fallback if WebSocket fails (GET /analyze/{id} every 2s)

**3.4 Error Handling (45 min)**
- [ ] Handle invalid analysis_id (404)
- [ ] Handle WebSocket connection failures
- [ ] Show user-friendly error messages
- [ ] Add "Back to Home" button on errors

**Deliverable:** Live progress tracking with auto-navigation

---

## Sprint 4: Results Dashboard (5-6 hours)

**Goal:** Display analysis results in readable, mobile-friendly format

**Time Budget:** 5-6 hours  
**Success:** All recommendation types visible and understandable

### Tasks

**4.1 Results Page Structure (60 min)**
- [ ] Create `pages/Results.tsx`
- [ ] Fetch results via React Query (GET /analyze/{id})
- [ ] Add loading state while fetching
- [ ] Create tabbed layout (shadcn Tabs):
  - Transfers
  - Captain
  - Chips
  - Optimized XI

**4.2 Transfers Tab (90 min)**
- [ ] Display transfer recommendations:
  - Priority transfers (OUT → IN)
  - Optional transfers
  - Player names, positions, prices
  - Expected points
- [ ] Add "no transfers recommended" state
- [ ] Show reasoning bullets for each transfer
- [ ] Mobile-friendly cards (stack on small screens)

**4.3 Captain Tab (60 min)**
- [ ] Display captain recommendation
- [ ] Show vice-captain
- [ ] List comparison pool (top 5 candidates)
- [ ] Show expected points + ownership %
- [ ] Add differential highlight if < 20% owned

**4.4 Chips Tab (45 min)**
- [ ] Display chip recommendation (use/save)
- [ ] Show current vs future GW potential
- [ ] List available chips
- [ ] Show "no chips available" state

**4.5 Optimized XI Tab (60 min)**
- [ ] Display formation (e.g., 3-5-2)
- [ ] Show starting 11 + bench (4 players)
- [ ] Use football pitch layout or simple list for MVP
- [ ] Highlight captain with (C) marker

**4.6 Polish & Actions (45 min)**
- [ ] Add "Analyze Another Team" button
- [ ] Add share button (copy link)
- [ ] Ensure responsive on 320px → 1920px
- [ ] Test all tabs switch smoothly

**Deliverable:** Complete results display with all recommendation types

---

## Sprint 5: Production Readiness (2-3 hours)

**Goal:** Build works in production, FastAPI serves it

**Time Budget:** 2-3 hours  
**Success:** Can build and serve frontend via FastAPI

### Tasks

**5.1 Build Configuration (60 min)**
- [ ] Configure Vite build output to `/frontend/dist`
- [ ] Update base path for production
- [ ] Add environment variables:
  ```
  VITE_API_URL=http://localhost:8000 (dev)
  VITE_API_URL=/api (prod)
  ```
- [ ] Test production build locally

**5.2 FastAPI Static Files (45 min)**
- [ ] Add static file mounting in `backend/main.py`:
  ```python
  app.mount("/", StaticFiles(directory="frontend/dist", html=True), name="static")
  ```
- [ ] Ensure API routes take precedence (`/api/*`)
- [ ] Add catch-all route for SPA routing
- [ ] Test serving build from FastAPI

**5.3 Deployment Documentation (45 min)**
- [ ] Add frontend setup to README
- [ ] Document build commands
- [ ] Add production env vars to .env.example
- [ ] Create deployment checklist

**Deliverable:** Production-ready frontend build

---

## Total Sprint Breakdown

| Sprint | Focus | Time | Status |
|--------|-------|------|--------|
| 1 | Foundation | 4-6h | Not Started |
| 2 | Team Entry | 3-4h | Not Started |
| 3 | Progress | 4-5h | Not Started |
| 4 | Results | 5-6h | Not Started |
| 5 | Production | 2-3h | Not Started |

**Total:** 18-24 hours (split across 1-2 weeks)

---

## Success Criteria (from ROADMAP)

- [ ] Lighthouse score 90+ (performance, accessibility)
- [ ] Works on iOS Safari 14+, Chrome Android
- [ ] <2 second initial load
- [ ] Touch-friendly (44px minimum tap targets)
- [ ] Mobile-responsive (320px → 1920px)
- [ ] Dark mode by default

---

## Files to Create

```
frontend/
├── src/
│   ├── main.tsx                 # React entry point
│   ├── App.tsx                  # Router setup
│   ├── pages/
│   │   ├── Landing.tsx          # Team entry
│   │   ├── Progress.tsx         # Analysis progress
│   │   ├── Results.tsx          # Results dashboard
│   │   └── NotFound.tsx         # 404 page
│   ├── components/
│   │   ├── ui/                  # shadcn components
│   │   ├── TransfersTab.tsx
│   │   ├── CaptainTab.tsx
│   │   ├── ChipsTab.tsx
│   │   └── OptimizedXI.tsx
│   ├── lib/
│   │   ├── api.ts               # API client
│   │   ├── websocket.ts         # WebSocket helper
│   │   ├── types.ts             # TypeScript types
│   │   └── utils.ts             # Utilities
│   └── styles/
│       └── globals.css          # Tailwind + custom styles
├── public/
├── index.html
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
└── package.json
```

**Est. Files:** ~25-30 files
**Est. Components:** ~15-20 components
**Est. LOC:** ~2,000-2,500 lines

---

## Dependencies

### Required Before Starting
- ✅ Backend API running (`python -m uvicorn backend.main:app --reload`)
- ✅ Redis running (for rate limiting - optional for dev)
- ✅ Node.js 18+ installed

### Required Packages
```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.21.0",
    "@tanstack/react-query": "^5.17.0",
    "@radix-ui/react-progress": "^1.0.3",
    "@radix-ui/react-tabs": "^1.0.4",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.48",
    "@types/react-dom": "^18.2.18",
    "@vitejs/plugin-react": "^4.2.1",
    "autoprefixer": "^10.4.16",
    "postcss": "^8.4.33",
    "tailwindcss": "^3.4.1",
    "typescript": "^5.3.3",
    "vite": "^5.0.11"
  }
}
```

---

## GSD Principles Applied

✅ **Start coding within 5 min** → Sprint 1 setup takes 60 min, then immediate coding  
✅ **Time-box everything** → Each sprint has hard time limits  
✅ **Working > Perfect** → MVP features first, polish later  
✅ **Simple solutions** → No complex state management, no over-engineering  
✅ **Fail fast** → If stuck > 10 min, pivot or ask  
✅ **Commit early** → After each task completion  

---

## Next Steps

**To start Sprint 1:**
```bash
# Create frontend directory
mkdir -p frontend
cd frontend

# Initialize Vite project
npm create vite@latest . -- --template react-ts

# Install dependencies
npm install

# Start dev server
npm run dev
```

**Ready to begin?** Type `/gsd:execute sprint-1` to start!
