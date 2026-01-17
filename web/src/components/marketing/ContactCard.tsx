const inquiryTypes = [
  "General research question",
  "Custom web development",
  "Partnership exploration",
];

export function ContactCard() {
  return (
    <section className="rounded-[2rem] border border-white/10 bg-surface/90 p-8 shadow-panel">
      <div className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-cloud/70">
          Contact
        </p>
        <h3 className="font-display text-3xl font-semibold text-cloud">
          Structured inquiry keeps the signal clean
        </h3>
        <p className="text-sm text-cloud/80">
          Submit educational or custom build requests with the context we need to route them. Messages are
          retained for 90 days and never used for marketing without consent.
        </p>
      </div>
      <form className="mt-8 grid gap-6" data-testid="contact-form">
        <div className="grid gap-2">
          <label htmlFor="name" className="text-sm font-semibold text-cloud/80">
            Full name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            placeholder="Casey Analyst"
            className="rounded-xl border border-white/15 bg-night/50 px-4 py-3 text-cloud outline-none focus:ring-2 focus:ring-teal"
          />
        </div>
        <div className="grid gap-2">
          <label htmlFor="email" className="text-sm font-semibold text-cloud/80">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            placeholder="you@example.com"
            className="rounded-xl border border-white/15 bg-night/50 px-4 py-3 text-cloud outline-none focus:ring-2 focus:ring-teal"
          />
        </div>
        <div className="grid gap-2">
          <label htmlFor="inquiry" className="text-sm font-semibold text-cloud/80">
            Inquiry type
          </label>
          <select
            id="inquiry"
            name="inquiry"
            required
            className="rounded-xl border border-white/15 bg-night/50 px-4 py-3 text-cloud outline-none focus:ring-2 focus:ring-teal"
            defaultValue=""
          >
            <option value="" disabled>
              Select an option
            </option>
            {inquiryTypes.map((type) => (
              <option key={type} value={type} className="bg-night text-cloud">
                {type}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <label htmlFor="message" className="text-sm font-semibold text-cloud/80">
            Message
          </label>
          <textarea
            id="message"
            name="message"
            rows={5}
            required
            placeholder="Share the analytical context, desired outcomes, and any compliance requirements."
            className="rounded-2xl border border-white/15 bg-night/50 px-4 py-3 text-cloud outline-none focus:ring-2 focus:ring-teal"
          />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-cloud/70">
            Message routing is automated via secure webhook. CAPTCHA added at integration time to prevent spam.
          </p>
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-full bg-amber px-6 py-3 text-sm font-semibold text-night transition hover:opacity-90"
          >
            Submit inquiry
          </button>
        </div>
      </form>
    </section>
  );
}
