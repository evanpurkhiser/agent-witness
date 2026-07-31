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
      className="h-16 w-full rounded-lg border border-zinc-950 bg-zinc-950 px-6 text-sm font-semibold tracking-[0.08em] text-white uppercase shadow-sm transition active:scale-[0.99] disabled:border-zinc-200 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none disabled:active:scale-100"
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
