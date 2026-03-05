'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type StickyBackButtonProps = {
  fallbackHref?: string;
  fallbackLabel?: string;
  showAfterPx?: number;
  className?: string;
};

export function StickyBackButton({
  fallbackHref = '/',
  fallbackLabel = 'Back',
  showAfterPx = 120,
  className = '',
}: StickyBackButtonProps) {
  const router = useRouter();
  const [isScrolled, setIsScrolled] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    const refreshState = () => {
      setIsScrolled(window.scrollY > showAfterPx);
      setCanGoBack(window.history.length > 1);
    };

    refreshState();
    window.addEventListener('scroll', refreshState, { passive: true });
    window.addEventListener('popstate', refreshState);

    return () => {
      window.removeEventListener('scroll', refreshState);
      window.removeEventListener('popstate', refreshState);
    };
  }, [showAfterPx]);

  const hasFallback = useMemo(
    () => fallbackHref.trim().length > 0,
    [fallbackHref],
  );
  const isVisible = isScrolled && (canGoBack || hasFallback);
  const label = canGoBack ? 'Back' : fallbackLabel;

  const handleBack = () => {
    if (window.history.length > 1) {
      router.back();
      return;
    }

    if (hasFallback) {
      router.push(fallbackHref);
    }
  };

  return (
    <button
      type="button"
      onClick={handleBack}
      aria-label={canGoBack ? 'Go back' : `Go to ${fallbackLabel}`}
      className={[
        'fixed left-[14px] top-[max(14px,env(safe-area-inset-top))] z-40 md:hidden',
        'h-10 rounded-full px-3',
        'flex items-center gap-2',
        'border border-[rgba(255,255,255,0.12)]',
        'bg-[rgba(10,16,28,0.72)]',
        'text-cloud',
        'backdrop-blur-sm',
        'shadow-[0_6px_18px_rgba(0,0,0,0.22)]',
        'transition-all duration-200 ease-out',
        isVisible
          ? 'translate-y-0 opacity-100'
          : 'pointer-events-none -translate-y-[6px] opacity-0',
        className,
      ].join(' ')}
    >
      <span className="text-base leading-none" aria-hidden="true">
        ←
      </span>
      <span className="text-sm font-medium leading-none">{label}</span>
    </button>
  );
}
