'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, useMemo, useState } from 'react';

type SendLinkResponse = {
  success: boolean;
  message?: string;
  error?: string;
  magicLink?: string;
  expiresAt?: string;
};

export default function LoginPage() {
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') || '/cards';
  const errorCode = searchParams.get('error');

  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SendLinkResponse | null>(null);

  const errorMessage = useMemo(() => {
    if (errorCode === 'expired_or_used') return 'This sign-in link is expired or has already been used.';
    if (errorCode === 'invalid_link') return 'That sign-in link is invalid.';
    return null;
  }, [errorCode]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setResult(null);

    try {
      const response = await fetch('/api/auth/send-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, next: nextPath }),
      });

      const payload = (await response.json()) as SendLinkResponse;
      setResult(payload);
    } catch {
      setResult({ success: false, error: 'Unable to send link. Please try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-night px-6 py-12 text-cloud">
      <div className="mx-auto w-full max-w-xl space-y-6">
        <Link href="/" className="text-sm text-cloud/60 hover:text-cloud/80">
          ← Back to Home
        </Link>

        {process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_DEV_BYPASS_ENABLED && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-200">
            <p className="font-semibold mb-1">🚀 Dev Mode Active</p>
            <p>Auth bypass is enabled. You can skip login and <Link href="/cards" className="underline font-semibold">go directly to /cards</Link>.</p>
          </div>
        )}

        <div>
          <h1 className="mb-2 font-display text-4xl font-semibold">Sign in</h1>
          <p className="text-cloud/70">Sign in to view your cards.</p>
        </div>

        {errorMessage && (
          <div className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-white/10 bg-surface/80 p-6">
          <div>
            <label htmlFor="email" className="mb-2 block text-sm font-semibold text-cloud/70">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-white/20 bg-surface px-4 py-3 text-cloud outline-none transition focus:border-teal"
              placeholder="you@example.com"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-teal px-6 py-3 font-semibold text-night transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Sending link...' : 'Send magic link'}
          </button>
        </form>

        {result && (
          <div
            className={`rounded-lg p-3 text-sm ${
              result.success
                ? 'border border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                : 'border border-red-400/30 bg-red-500/10 text-red-200'
            }`}
          >
            <p>{result.success ? result.message : result.error}</p>
            {result.success && result.magicLink && (
              <p className="mt-2 break-all">
                Dev link: <a href={result.magicLink} className="underline">{result.magicLink}</a>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
