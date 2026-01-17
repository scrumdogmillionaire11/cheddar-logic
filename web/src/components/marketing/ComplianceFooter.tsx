type ComplianceFooterProps = {
  legalLinks: { label: string; href: string }[];
};

export function ComplianceFooter({ legalLinks }: ComplianceFooterProps) {
  return (
    <footer className="mt-20 border-t border-white/10 bg-night/80">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 text-sm text-cloud/70 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <p className="font-semibold text-cloud">Cheddar Logic LLC</p>
          <p>
            Informational and educational content only. No guarantees of outcomes. Users retain full
            decision-making responsibility.
          </p>
          <p className="text-xs">© {new Date().getFullYear()} Cheddar Logic LLC. All rights reserved.</p>
        </div>
        <nav className="flex flex-wrap gap-4 text-xs uppercase tracking-[0.3em]">
          {legalLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-cloud/70 transition hover:text-cloud"
              target="_blank"
              rel="noreferrer noopener"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
