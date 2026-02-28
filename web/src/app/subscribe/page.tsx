import Link from 'next/link';

export default function SubscribePage() {
  return (
    <div className="min-h-screen bg-night px-6 py-12 text-cloud">
      <div className="mx-auto w-full max-w-xl space-y-6">
        <Link href="/" className="text-sm text-cloud/60 hover:text-cloud/80">
          ← Back to Home
        </Link>

        <div>
          <h1 className="mb-2 font-display text-4xl font-semibold">Subscription Required</h1>
          <p className="text-cloud/70">
            Your account is signed in but does not have access to this resource yet.
          </p>
        </div>

        <div className="rounded-xl border border-white/10 bg-surface/80 p-6 space-y-4">
          <p className="text-sm text-cloud/80">
            If you should already have access, sign out and sign in again from your approved email.
          </p>

          <div className="flex gap-3">
            <Link
              href="/login"
              className="rounded-lg bg-teal px-4 py-2 font-semibold text-night transition hover:opacity-90"
            >
              Sign in
            </Link>
            <Link
              href="/"
              className="rounded-lg border border-white/20 px-4 py-2 font-semibold text-cloud transition hover:border-white/40"
            >
              Back home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
