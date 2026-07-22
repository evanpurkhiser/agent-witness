import {useEffect, useState} from 'react';

import type {WorkerToPage} from 'app/worker-protocol';

/**
 * Root UI. For now it just boots the worker and reflects its readiness; the
 * vault and key-management UI land in later slices.
 */
export function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<WorkerToPage>) => {
      if (event.data.type === 'ready') {
        setReady(true);
      }
    };

    return () => worker.terminate();
  }, []);

  return (
    <main>
      <h1>agent-witness</h1>
      <p>worker: {ready ? 'ready' : 'starting…'}</p>
    </main>
  );
}
