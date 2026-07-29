import {lazy, Suspense} from 'react';

import {InstallScreen} from './InstallScreen';

const InstalledApp = lazy(() =>
  import('./InstalledApp').then(module => ({default: module.InstalledApp})),
);

function isInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches;
}

export function App() {
  if (!isInstalled()) {
    return <InstallScreen />;
  }

  return (
    <Suspense fallback={<p>Loading…</p>}>
      <InstalledApp />
    </Suspense>
  );
}
