'use client';

import { useCardsPageActions, useCardsPageState } from './CardsPageContext';

export default function CardsModeTabs() {
  const { lifecycleMode, propsEnabled, viewMode } = useCardsPageState();
  const { onLifecycleModeChange, onModeChange } = useCardsPageActions();

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      <button
        onClick={() => onLifecycleModeChange('pregame')}
        className={`px-4 py-2 rounded-md border text-sm font-semibold transition ${
          lifecycleMode === 'pregame'
            ? 'bg-blue-700/40 text-blue-100 border-blue-600/60'
            : 'bg-white/5 text-cloud/70 border-white/10 hover:border-white/20'
        }`}
      >
        Pre-Game
      </button>
      <button
        onClick={() => onLifecycleModeChange('active')}
        className={`px-4 py-2 rounded-md border text-sm font-semibold transition ${
          lifecycleMode === 'active'
            ? 'bg-blue-700/40 text-blue-100 border-blue-600/60'
            : 'bg-white/5 text-cloud/70 border-white/10 hover:border-white/20'
        }`}
      >
        Active
      </button>
      <span className="mx-1 h-6 w-px bg-white/15" aria-hidden="true" />
      <button
        onClick={() => onModeChange('game')}
        className={`px-4 py-2 rounded-md border text-sm font-semibold transition ${
          viewMode === 'game'
            ? 'bg-emerald-700/50 text-emerald-100 border-emerald-600/60'
            : 'bg-white/5 text-cloud/70 border-white/10 hover:border-white/20'
        }`}
      >
        Game Lines
      </button>
      {propsEnabled && (
        <button
          onClick={() => onModeChange('props')}
          className={`px-4 py-2 rounded-md border text-sm font-semibold transition ${
            viewMode === 'props'
              ? 'bg-emerald-700/50 text-emerald-100 border-emerald-600/60'
              : 'bg-white/5 text-cloud/70 border-white/10 hover:border-white/20'
          }`}
        >
          Player Props
        </button>
      )}
    </div>
  );
}
