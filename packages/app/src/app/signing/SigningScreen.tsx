import type {ReactNode} from 'react';

import type {ConnectionSnapshot} from 'app/remote/session';
import type {
  AuthorizationRequestView,
  SettledAuthorizationView,
  VaultSnapshot,
} from 'app/worker/api';

import {ConfigurationMenu} from '../configuration/ConfigurationMenu';

import {AuthorizationGroupList} from './AuthorizationGroupList';
import {AuthorizeButton} from './AuthorizeButton';
import {ConnectionStatus} from './ConnectionStatus';

interface SigningScreenProps {
  connection: ConnectionSnapshot;
  authorizationRequests: AuthorizationRequestView[];
  settledAuthorizations: SettledAuthorizationView[];
  vault: VaultSnapshot;
  working: boolean;
  error: string | null;
  configuration?: ReactNode;
  onCreateVault(): void;
  onForgetPairing(): void;
  onAuthorize(): void;
}

export function SigningScreen({
  connection,
  authorizationRequests,
  settledAuthorizations,
  vault,
  working,
  error,
  onCreateVault,
  onForgetPairing,
  onAuthorize,
  configuration = <ConfigurationMenu />,
}: SigningScreenProps) {
  return (
    <main className="bg-canvas text-foreground fixed inset-0 grid grid-rows-[minmax(0,1fr)_auto] gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] font-mono">
      <AuthorizationGroupList
        requests={authorizationRequests}
        settled={settledAuthorizations}
        error={error ?? connection.error}
        connectionStatus={connection.status}
        vault={vault}
        working={working}
        onCreateVault={onCreateVault}
        onForgetPairing={onForgetPairing}
      />

      <footer className="grid gap-3">
        <AuthorizeButton
          pendingRequests={authorizationRequests.length}
          vaultStatus={vault.status}
          working={working}
          onAuthorize={onAuthorize}
        />
        <div className="flex items-center justify-between">
          <ConnectionStatus status={connection.status} />
          {configuration}
        </div>
      </footer>
    </main>
  );
}
