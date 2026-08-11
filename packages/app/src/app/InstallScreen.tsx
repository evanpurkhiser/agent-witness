interface InstallScreenProps {
  onContinue(): void;
}

export function InstallScreen({onContinue}: InstallScreenProps) {
  return (
    <main className="grid min-h-full place-items-center px-5 py-8 font-mono text-zinc-950">
      <section
        aria-labelledby="install-heading"
        className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
      >
        <h1 id="install-heading" className="text-lg font-semibold">
          Add to Home Screen
        </h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Agent Witness works best as an app. Open the share menu, then choose{' '}
          <strong className="font-semibold text-zinc-800">Add to Home Screen</strong>.
        </p>

        <button
          type="button"
          className="mt-6 min-h-12 w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm font-semibold text-zinc-800 transition-colors hover:bg-zinc-50 active:bg-zinc-100"
          onClick={onContinue}
        >
          I’ll use it in the browser
        </button>
      </section>
    </main>
  );
}
