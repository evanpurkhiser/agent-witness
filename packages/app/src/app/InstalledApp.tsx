import {NotificationsProvider} from './NotificationsProvider';
import {ServiceWorkerProvider} from './ServiceWorkerProvider';
import {SigningScreen} from './signing/SigningScreen';
import {useWorker, WorkerProvider} from './WorkerProvider';

export function InstalledApp() {
  return (
    <WorkerProvider>
      <ServiceWorkerProvider>
        <NotificationsProvider>
          <InstalledAppContent />
        </NotificationsProvider>
      </ServiceWorkerProvider>
    </WorkerProvider>
  );
}

function InstalledAppContent() {
  const {snapshot, error, working, createVault, unlock, forgetPairing} = useWorker();

  if (!snapshot) {
    return <LoadingScreen error={error} />;
  }

  return (
    <SigningScreen
      connection={snapshot.connection}
      authorizationRequests={snapshot.authorizationRequests}
      settledAuthorizations={snapshot.settledAuthorizations}
      vault={snapshot.vault}
      working={working}
      error={error}
      onCreateVault={() => void createVault()}
      onForgetPairing={() => void forgetPairing()}
      onAuthorize={() => {
        if (snapshot.vault.status === 'locked') {
          void unlock(snapshot.vault.vault);
        }
      }}
    />
  );
}

function LoadingScreen({error}: {error: string | null}) {
  return (
    <main className="bg-canvas text-foreground grid min-h-full place-items-center px-5 font-mono">
      <div className="grid justify-items-center gap-4 text-center">
        <span
          aria-hidden="true"
          className="border-border-strong border-t-foreground size-8 animate-spin rounded-full border-2"
        />
        <div>
          <h1 className="text-sm font-semibold tracking-[0.12em] uppercase">
            Agent Witness
          </h1>
          <p
            role={error ? 'alert' : 'status'}
            className={
              error ? 'text-danger mt-2 text-xs' : 'text-foreground-faint mt-2 text-xs'
            }
          >
            {error ?? 'Opening your vault…'}
          </p>
        </div>
      </div>
    </main>
  );
}
