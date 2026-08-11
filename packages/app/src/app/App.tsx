import {lazy, Suspense, useState} from 'react';

import {InstallScreen} from './InstallScreen';

const InstalledApp = lazy(() =>
  import('./InstalledApp').then(module => ({default: module.InstalledApp})),
);

function isInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches;
}

export function App() {
  const [useInBrowser, setUseInBrowser] = useState(false);

  if (!isInstalled() && !useInBrowser) {
    return <InstallScreen onContinue={() => setUseInBrowser(true)} />;
  }

  return (
    <Suspense fallback={<p>Loading…</p>}>
      <InstalledApp />
    </Suspense>
  );
}
