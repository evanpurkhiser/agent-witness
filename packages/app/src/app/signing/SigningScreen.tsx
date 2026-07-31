import type {ConnectionSnapshot} from 'app/remote/session';
import type {VaultSnapshot} from 'app/worker/api';
import type {AgentEvent} from 'app/worker/events';

import {AuthorizeButton} from './AuthorizeButton';
import {ConnectionStatus} from './ConnectionStatus';
import {EventLog} from './EventLog';

interface SigningScreenProps {
  connection: ConnectionSnapshot;
  events: AgentEvent[];
  vault: Exclude<VaultSnapshot, {status: 'no-vault'}>;
  working: boolean;
  error: string | null;
  onAuthorize(): void;
}

export function SigningScreen({
  connection,
  events,
  vault,
  working,
  error,
  onAuthorize,
}: SigningScreenProps) {
  return (
    <main className="fixed inset-0 grid grid-rows-[minmax(0,1fr)_auto] gap-3 bg-zinc-50 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] font-mono text-zinc-950">
      <EventLog events={events} error={error ?? connection.error} />

      <footer className="grid gap-3">
        <AuthorizeButton
          pendingRequests={connection.pendingRequests}
          vaultStatus={vault.status}
          working={working}
          onAuthorize={onAuthorize}
        />
        <ConnectionStatus status={connection.status} />
      </footer>
    </main>
  );
}
