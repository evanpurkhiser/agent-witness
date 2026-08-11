interface InstallScreenProps {
  onContinue(): void;
}

export function InstallScreen({onContinue}: InstallScreenProps) {
  return (
    <main className="text-foreground grid min-h-full place-items-center px-5 py-8 font-mono">
      <section
        aria-labelledby="install-heading"
        className="border-border bg-surface w-full max-w-sm rounded-xl border p-6 shadow-sm"
      >
        <h1 id="install-heading" className="text-lg font-semibold">
          Add to Home Screen
        </h1>
        <p className="text-foreground-muted mt-3 text-sm leading-6">
          Agent Witness works best as an app. Open the share menu, then choose{' '}
          <strong className="text-foreground-strong font-semibold">
            Add to Home Screen
          </strong>
          .
        </p>

        <button
          type="button"
          className="border-border-strong bg-surface text-foreground-strong hover:bg-surface-hover active:bg-surface-active mt-6 min-h-12 w-full rounded-lg border px-4 py-3 text-sm font-semibold transition-colors"
          onClick={onContinue}
        >
          I’ll use it in the browser
        </button>
      </section>
    </main>
  );
}
