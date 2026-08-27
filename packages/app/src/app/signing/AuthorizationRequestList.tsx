import {type ReactNode, useEffect, useState} from 'react';

import {AnimatePresence, motion} from 'framer-motion';
import type {Variants} from 'framer-motion';

import type {ConnectionSnapshot} from 'app/remote/session';
import type {
  AuthorizationRequestView,
  SettledAuthorizationView,
  VaultSnapshot,
} from 'app/worker/api';

import {AuthorizationRequestCard} from './AuthorizationRequestCard';
import {useRetainedAuthorizationRequests} from './useRetainedAuthorizationRequests';

const cardVariants: Variants = {
  hidden: {opacity: 0, scale: 0.9, y: 15},
  visible: (index = 0) => ({
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {delay: index * 0.07, duration: 0.24, ease: 'easeOut'},
  }),
  exit: (index = 0) => ({
    opacity: 0,
    transition: {delay: index * 0.07, duration: 0.18, ease: 'easeOut'},
  }),
};

interface AuthorizationRequestListProps {
  requests: AuthorizationRequestView[];
  settled: SettledAuthorizationView[];
  error: string | null;
  connectionStatus: ConnectionSnapshot['status'];
  vault: VaultSnapshot;
  working: boolean;
  onCreateVault(): void;
  onForgetPairing(): void;
}

export function AuthorizationRequestList({
  requests,
  settled,
  error,
  connectionStatus,
  vault,
  working,
  onCreateVault,
  onForgetPairing,
}: AuthorizationRequestListProps) {
  const retained = useRetainedAuthorizationRequests(requests, settled);
  const now = useCurrentTime(retained.length > 0);

  return (
    <section
      aria-labelledby="authorization-requests-heading"
      className="flex min-h-0 flex-col"
    >
      <header className="flex h-11 shrink-0 items-center justify-between px-1">
        <h1
          id="authorization-requests-heading"
          className="text-foreground-muted text-[11px] font-semibold tracking-[0.16em] uppercase"
        >
          Authorization requests
        </h1>
        <span
          aria-label={`${requests.length} active ${requests.length === 1 ? 'request' : 'requests'}`}
          className="text-foreground-faint text-[10px] tabular-nums"
        >
          {String(requests.length).padStart(2, '0')}
        </span>
      </header>

      <div className="grid min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {retained.length === 0 && (
          <motion.div
            className="col-start-1 row-start-1 flex min-h-48 items-center justify-center px-4"
            initial={{opacity: 0}}
            animate={{opacity: 1}}
            transition={{duration: 0.18, ease: 'easeOut'}}
          >
            <EmptyState
              connectionStatus={connectionStatus}
              vault={vault}
              working={working}
              onCreateVault={onCreateVault}
              onForgetPairing={onForgetPairing}
            />
          </motion.div>
        )}
        <motion.ol
          aria-label="Authorization requests"
          aria-live="polite"
          className={`col-start-1 row-start-1 grid content-start gap-2 ${retained.length === 0 ? 'pointer-events-none' : ''}`}
        >
          <AnimatePresence>
            {retained.map((request, index) => (
              <motion.li
                key={`${request.id}:${request.attempt}`}
                layout="position"
                custom={index}
                variants={cardVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="origin-top list-none"
              >
                <AuthorizationRequestCard request={request} now={now} />
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ol>
      </div>

      {error && (
        <p role="alert" className="text-danger mt-2 px-1 text-xs">
          {error}
        </p>
      )}
    </section>
  );
}

interface EmptyStateProps {
  connectionStatus: ConnectionSnapshot['status'];
  vault: VaultSnapshot;
  working: boolean;
  onCreateVault(): void;
  onForgetPairing(): void;
}

function EmptyState({
  connectionStatus,
  vault,
  working,
  onCreateVault,
  onForgetPairing,
}: EmptyStateProps) {
  if (connectionStatus === 'rejected') {
    return (
      <EmptyStateCard
        title="Pairing rejected"
        description="This device is no longer authorized by the server. Pair it again to receive requests."
        action={
          <EmptyStateButton disabled={working} onClick={onForgetPairing}>
            Pair again
          </EmptyStateButton>
        }
      />
    );
  }

  if (connectionStatus === 'error') {
    return (
      <EmptyStateCard
        title="Connection unavailable"
        description="Authorization requests will appear when the server connection is restored."
      />
    );
  }

  if (vault.status === 'no-vault') {
    return (
      <EmptyStateCard
        title="Create your vault"
        description="Protect your SSH keys with a passkey before approving authorization requests."
        action={
          <EmptyStateButton disabled={working} onClick={onCreateVault}>
            {working ? 'Creating vault…' : 'Create vault'}
          </EmptyStateButton>
        }
      />
    );
  }

  if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting') {
    return (
      <EmptyStateCard
        title={connectionStatus === 'connecting' ? 'Connecting' : 'Reconnecting'}
        description="Authorization requests will appear here once the server is connected."
      />
    );
  }

  if (vault.vault.keys.length === 0) {
    return (
      <EmptyStateCard
        title="No private keys"
        description="Add your first SSH key from the Configure menu to begin approving requests."
      />
    );
  }

  return (
    <EmptyStateCard
      title="No pending requests"
      description="New SSH authorization requests will appear here."
    />
  );
}

function EmptyStateCard({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-border bg-surface grid w-full max-w-sm justify-items-center rounded-xl border px-6 py-8 text-center shadow-xs">
      <h2 className="text-foreground-strong text-sm font-semibold">{title}</h2>
      <p className="text-foreground-subtle mt-2 max-w-64 text-xs leading-5">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

function EmptyStateButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="border-border-primary bg-primary text-primary-foreground disabled:border-border disabled:bg-surface-disabled disabled:text-foreground-disabled min-h-10 rounded-lg border px-4 text-[11px] font-semibold tracking-[0.08em] uppercase shadow-sm"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function useCurrentTime(active: boolean): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active) {
      return;
    }

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);

  return now;
}
