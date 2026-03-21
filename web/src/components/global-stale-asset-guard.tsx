'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  buildStaleAssetErrorMessage,
  formatStaleAssetUserMessage,
  isStaleNextStaticAssetFailure,
  STALE_ASSET_RELOAD_GUARD_KEY,
  stringifyUnknownError,
} from '@/lib/stale-asset-recovery';

const GLOBAL_STALE_ASSET_LOG_CODE = 'GLOBAL_STATIC_ASSET_LOAD_FAILED';

export default function GlobalStaleAssetGuard() {
  const pathname = usePathname();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleStaticAssetFailure = (
      message: string,
      source: 'error' | 'unhandledrejection',
    ) => {
      if (!isStaleNextStaticAssetFailure(message)) return;

      const alreadyReloaded =
        window.sessionStorage.getItem(STALE_ASSET_RELOAD_GUARD_KEY) === '1';

      console.error(`[${GLOBAL_STALE_ASSET_LOG_CODE}]`, {
        source,
        message,
      });

      if (!alreadyReloaded) {
        window.sessionStorage.setItem(STALE_ASSET_RELOAD_GUARD_KEY, '1');
        window.location.reload();
        return;
      }

      setError(formatStaleAssetUserMessage(message));
    };

    const onError = (event: Event) => {
      const errorEvent = event as ErrorEvent;
      handleStaticAssetFailure(buildStaleAssetErrorMessage(errorEvent), 'error');
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      handleStaticAssetFailure(
        stringifyUnknownError(event.reason),
        'unhandledrejection',
      );
    };

    window.addEventListener('error', onError, true);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.removeEventListener('error', onError, true);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  if (!error || pathname?.startsWith('/cards')) {
    return null;
  }

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[200] border-b border-red-300 bg-red-50 px-4 py-3 text-center text-sm font-medium text-red-900"
    >
      {error}
    </div>
  );
}
