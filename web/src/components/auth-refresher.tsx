'use client';

import { useEffect, useRef } from 'react';

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // Refresh every 12 hours (access token TTL is 24 hours)
// AUTH DISABLED: MAX_RETRIES and RETRY_DELAY_MS unused while redirect is suppressed
// const MAX_RETRIES = 3;
// const RETRY_DELAY_MS = 5000;

export function AuthRefresher() {
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  // AUTH DISABLED: retryCountRef unused while redirect is suppressed
  // const retryCountRef = useRef(0);

  useEffect(() => {
    async function refreshToken() {
      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
        });
        
        if (!response.ok) {
          // Only redirect to login if we get 401 (unauthorized) and have exhausted retries
          if (response.status === 401) {
            // AUTH DISABLED: redirect suppressed while auth is open to all users
            // Re-enable when auth is restored:
            // retryCountRef.current++;
            // if (retryCountRef.current >= MAX_RETRIES) {
            //   console.warn('[AuthRefresher] Token refresh failed after retries, redirecting to login');
            //   window.location.href = '/login';
            // } else {
            //   console.warn(`[AuthRefresher] Token refresh failed, retrying (${retryCountRef.current}/${MAX_RETRIES})`);
            //   setTimeout(refreshToken, RETRY_DELAY_MS);
            // }
          } else {
            // Network error or server error - don't redirect, just log
            console.warn('[AuthRefresher] Token refresh encountered error:', response.status);
          }
        } else {
          // Success
        }
      } catch (error) {
        console.error('[AuthRefresher] Error refreshing token:', error);
        // Don't redirect on network errors - user might just be offline temporarily
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
