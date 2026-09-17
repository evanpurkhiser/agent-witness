import {lazy, Suspense, useState} from 'react';

import {InstallScreen} from './InstallScreen';

const InstalledApp = lazy(() =>
  import('./InstalledApp').then(module => ({default: module.InstalledApp})),
);

const PreviewApp = lazy(() => import('./PreviewApp'));

function isInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches;
}

export function App() {
  const [useInBrowser, setUseInBrowser] = useState(false);

  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('preview')) {
    return (
      <Suspense>
        <PreviewApp />
      </Suspense>
    );
  }

  if (!isInstalled() && !useInBrowser) {
    return <InstallScreen onContinue={() => setUseInBrowser(true)} />;
  }

  return (
    <Suspense
      fallback={
        <main className="text-foreground grid min-h-full place-items-center px-5 font-mono">
          <p role="status" className="text-foreground-muted text-sm">
            Initializing…
          </p>
        </main>
      }
    >
      <InstalledApp />
    </Suspense>
  );
}
