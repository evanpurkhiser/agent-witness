import type {VaultSnapshot} from 'app/worker/api';

interface AuthorizeButtonProps {
  pendingRequests: number;
  vaultStatus: Exclude<VaultSnapshot, {status: 'no-vault'}>['status'];
  working: boolean;
  onAuthorize(): void;
}

export function AuthorizeButton({
  pendingRequests,
  vaultStatus,
  working,
  onAuthorize,
}: AuthorizeButtonProps) {
  const canAuthorize = pendingRequests > 0 && vaultStatus === 'locked' && !working;

  return (
    <button
      type="button"
      aria-busy={working}
      className="border-border-primary bg-primary text-primary-foreground disabled:border-border disabled:bg-surface-disabled disabled:text-foreground-disabled h-16 w-full rounded-lg border px-6 text-sm font-semibold tracking-[0.08em] uppercase shadow-sm transition active:scale-[0.99] disabled:shadow-none disabled:active:scale-100"
      disabled={!canAuthorize}
      onClick={onAuthorize}
    >
      {buttonLabel(pendingRequests, vaultStatus, working)}
    </button>
  );
}

function buttonLabel(
  pendingRequests: number,
  vaultStatus: AuthorizeButtonProps['vaultStatus'],
  working: boolean,
): string {
  if (working) {
    return 'Unlocking…';
  }
  if (pendingRequests > 0 && vaultStatus === 'unlocked') {
    return 'Authorizing…';
  }
  return 'Authorize';
}
