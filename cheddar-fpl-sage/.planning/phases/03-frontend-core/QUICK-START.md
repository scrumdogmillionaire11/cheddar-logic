# Phase 3: Quick Start Guide

**Status:** Ready to execute  
**Time Budget:** 18-24 hours (5 sprints)  
**Current Sprint:** Not started

---

## 🚀 Start Sprint 1 (Foundation) - 4-6 hours

### Prerequisites
- [x] Backend API running
- [x] Node.js 18+ installed
- [ ] Terminal ready

### Step 1: Create Project (15 min)

```bash
# Navigate to project root
cd /Users/ajcolubiale/projects/cheddar-fpl-sage

# Create frontend directory
mkdir frontend
cd frontend

# Initialize Vite + React + TypeScript
npm create vite@latest . -- --template react-ts

# Answer prompts:
# ✔ Current directory is not empty. Remove existing files and continue? … yes
# ✔ Select a framework: › React
# ✔ Select a variant: › TypeScript
```

### Step 2: Install Dependencies (10 min)

```bash
# Install base dependencies
npm install

# Install routing
npm install react-router-dom

# Install React Query
npm install @tanstack/react-query

# Install Tailwind
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p

# Install shadcn/ui dependencies
npm install class-variance-authority clsx tailwind-merge
npm install @radix-ui/react-progress @radix-ui/react-tabs
```

### Step 3: Configure Tailwind (10 min)

Edit `tailwind.config.js`:
```js
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

Edit `src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
  }
  
  body {
    @apply bg-background text-foreground;
  }
}
```

### Step 4: Setup Routing (20 min)

Create `src/App.tsx`:
```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom'

function Landing() {
  return <div>Landing Page</div>
}

function Progress() {
  return <div>Progress Page</div>
}

function Results() {
  return <div>Results Page</div>
}

function NotFound() {
  return <div>404 - Not Found</div>
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/analyze/:id" element={<Progress />} />
        <Route path="/results/:id" element={<Results />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
```

### Step 5: Configure Vite (15 min)

Edit `vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      }
    }
  }
})
```

Edit `tsconfig.json` - add to `compilerOptions`:
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

### Step 6: Create API Client (30 min)

Create `src/lib/api.ts`:
```ts
interface AnalysisRequest {
  team_id: number;
  gameweek?: number;
}

interface AnalysisJob {
  analysis_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  phase: string;
  results?: any;
  error?: string;
}

const API_BASE = import.meta.env.DEV 
  ? '/api/v1'  // Proxied to :8000 in dev
  : '/api/v1'  // Same origin in prod

export async function createAnalysis(request: AnalysisRequest): Promise<AnalysisJob> {
  const response = await fetch(`${API_BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail?.error || 'Analysis failed');
  }
  
  return response.json();
}

export async function getAnalysis(analysisId: string): Promise<AnalysisJob> {
  const response = await fetch(`${API_BASE}/analyze/${analysisId}`);
  
  if (!response.ok) {
    throw new Error('Failed to fetch analysis');
  }
  
  return response.json();
}
```

### Step 7: Setup React Query (20 min)

Edit `src/main.tsx`:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
)
```

### Step 8: Test Everything (20 min)

```bash
# Start backend (in separate terminal)
cd /Users/ajcolubiale/projects/cheddar-fpl-sage
python -m uvicorn backend.main:app --reload

# Start frontend
cd frontend
npm run dev
```

Open http://localhost:5173 and verify:
- [x] Dark theme loads
- [x] Routes work (/, /analyze/test, /results/test)
- [x] No console errors

---

## ✅ Sprint 1 Complete When:
- Frontend dev server running on :5173
- Backend proxy working (/api routes)
- 3 routes rendering basic content
- Tailwind dark mode working
- React Query provider configured

---

## 📝 Next Sprint

After Sprint 1 complete, move to **Sprint 2: Team Entry Flow** (3-4 hours)
- Build landing page
- Add team ID input with validation
- Hook up POST /api/v1/analyze
- Navigate to progress screen

---

## 🆘 Troubleshooting

**"Cannot find module '@/*'"**
- Restart TypeScript server in VS Code
- Check tsconfig.json paths are correct

**"Proxy error"**
- Ensure backend is running on :8000
- Check vite.config.ts proxy settings

**"Module not found: react-router-dom"**
- Run `npm install` again
- Delete node_modules and reinstall

---

**Ready?** Start Sprint 1 and report back when complete!
