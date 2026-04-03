'use client';

import { useEffect, useState } from 'react';
import { useCardsPageActions, useCardsPageState } from './CardsPageContext';

const BASE = 'px-4 py-2 rounded-md border text-sm font-semibold transition';
const ACTIVE_LC = 'bg-blue-700/40 text-blue-100 border-blue-600/60';
const ACTIVE_VM = 'bg-emerald-700/50 text-emerald-100 border-emerald-600/60';
const INACTIVE = 'bg-white/5 text-cloud/70 border-white/10 hover:border-white/20';

export default function CardsModeTabs() {
  const { lifecycleMode, propsEnabled, viewMode } = useCardsPageState();
  const { onLifecycleModeChange, onModeChange } = useCardsPageActions();
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => { setHasMounted(true); }, []);

  if (!hasMounted) {
    return <div className="mb-6 flex flex-wrap items-center gap-2" />;
  }

  const pregameCls = `${BASE} ${lifecycleMode === 'pregame' ? ACTIVE_LC : INACTIVE}`;
  const activeCls = `${BASE} ${lifecycleMode === 'active' ? ACTIVE_LC : INACTIVE}`;
  const gameCls = `${BASE} ${viewMode === 'game' ? ACTIVE_VM : INACTIVE}`;
  const propsCls = `${BASE} ${viewMode === 'props' ? ACTIVE_VM : INACTIVE}`;
  const projectionsCls = `${BASE} ${viewMode === 'projections' ? ACTIVE_VM : INACTIVE}`;

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      <button onClick={() => onLifecycleModeChange('pregame')} className={pregameCls}>
        Pre-Game
      </button>
      <button onClick={() => onLifecycleModeChange('active')} className={activeCls}>
        Active
      </button>
      <span className="mx-1 h-6 w-px bg-white/15" aria-hidden="true" />
      <button onClick={() => onModeChange('game')} className={gameCls}>
        Game Lines
      </button>
      {propsEnabled && (
        <button onClick={() => onModeChange('props')} className={propsCls}>
          Player Props
        </button>
      )}
      <button onClick={() => onModeChange('projections')} className={projectionsCls}>
        Game Props
      </button>
    </div>
  );
}
