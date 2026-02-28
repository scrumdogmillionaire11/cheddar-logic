'use client';

import { useEffect, useRef } from 'react';

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // Refresh every 12 hours (access token TTL is 24 hours)

export function AuthRefresher() {
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    async function refreshToken() {
      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
        });
        
        if (!response.ok) {
          console.warn('[AuthRefresher] Token refresh failed, redirecting to login');
          // Token refresh failed, redirect to login
          window.location.href = '/login';
        }
      } catch (error) {
        console.error('[AuthRefresher] Error refreshing token:', error);
      }
    }

    // Refresh immediately on mount to recover from expired state
    refreshToken();

    // Set up periodic refresh
    intervalRef.current = setInterval(refreshToken, REFRESH_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  return null;
}
