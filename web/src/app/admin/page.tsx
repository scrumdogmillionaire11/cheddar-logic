import Link from "next/link";

export default function AdminPage() {
  return (
    <div className="min-h-screen bg-night px-6 py-12 text-cloud">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8">
          <Link href="/" className="text-sm text-cloud/60 hover:text-cloud/80">
            ← Back to Home
          </Link>
        </div>

        <div className="space-y-8">
          <div>
            <h1 className="mb-2 font-display text-4xl font-semibold">Admin Dashboard</h1>
            <p className="text-lg text-cloud/70">Manage site content and analytics</p>
          </div>

          <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
            <div className="mb-6">
              <h2 className="mb-2 text-xl font-semibold">Authentication Required</h2>
              <p className="text-sm text-cloud/70">Please sign in to access admin features</p>
            </div>

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="username"
                  className="mb-2 block text-sm font-semibold text-cloud/70"
                >
                  Username
                </label>
                <input
                  type="text"
                  id="username"
                  className="w-full rounded-lg border border-white/20 bg-surface px-4 py-3 text-cloud outline-none transition focus:border-teal"
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="mb-2 block text-sm font-semibold text-cloud/70"
                >
                  Password
                </label>
                <input
                  type="password"
                  id="password"
                  className="w-full rounded-lg border border-white/20 bg-surface px-4 py-3 text-cloud outline-none transition focus:border-teal"
                />
              </div>

              <button
                type="button"
                className="w-full rounded-lg bg-teal px-6 py-3 font-semibold text-night transition hover:opacity-90"
              >
                Sign In
              </button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-surface/80 p-6 opacity-50">
              <h3 className="mb-2 font-semibold">Content Management</h3>
              <p className="text-sm text-cloud/70">
                Manage educational content, articles, and resources
              </p>
            </div>

            <div className="rounded-xl border border-white/10 bg-surface/80 p-6 opacity-50">
              <h3 className="mb-2 font-semibold">Analytics Dashboard</h3>
              <p className="text-sm text-cloud/70">View site analytics and user engagement metrics</p>
            </div>

            <div className="rounded-xl border border-white/10 bg-surface/80 p-6 opacity-50">
              <h3 className="mb-2 font-semibold">User Management</h3>
              <p className="text-sm text-cloud/70">Manage user accounts and permissions</p>
            </div>

            <div className="rounded-xl border border-white/10 bg-surface/80 p-6 opacity-50">
              <h3 className="mb-2 font-semibold">Discord Integration</h3>
              <p className="text-sm text-cloud/70">Manage Discord community settings and webhooks</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
