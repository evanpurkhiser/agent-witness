import type {WorkerToPage} from 'app/worker-protocol';

// Dedicated worker that will own the vault and ssh-agent session. Command
// handling lands in a later slice; for now it just announces it is alive.

const ready: WorkerToPage = {type: 'ready'};
self.postMessage(ready);
