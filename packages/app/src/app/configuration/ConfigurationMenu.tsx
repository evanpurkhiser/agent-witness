import {useRef, useState} from 'react';

import {Dialog} from '@base-ui/react/dialog';
import {Menu} from '@base-ui/react/menu';
import {motion} from 'framer-motion';

import {useNotifications} from '../NotificationsProvider';
import type {ThemeMode} from '../theme';
import {useThemeMode} from '../useThemeMode';
import {useWorker} from '../WorkerProvider';

import {KeyList} from './KeyList';

export function ConfigurationMenu() {
  const [sshKeysOpen, setSshKeysOpen] = useState(false);
  const [deleteVaultOpen, setDeleteVaultOpen] = useState(false);
  const [themeMode, selectThemeMode] = useThemeMode();
  const {snapshot, working, error, destroy} = useWorker();
  const {
    state: notificationState,
    canEnable: canEnableNotifications,
    enable: enableNotifications,
  } = useNotifications();
  const dialogRef = useRef<HTMLDivElement>(null);
  const vaultExists = snapshot !== null && snapshot.vault.status !== 'no-vault';

  async function deleteVault(): Promise<void> {
    if (await destroy()) {
      setDeleteVaultOpen(false);
    }
  }

  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground -my-2 flex min-h-11 items-center gap-1.5 rounded-md px-2 text-[10px] font-semibold tracking-[0.1em] uppercase transition-colors">
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M2.5 4.5h3m3 0h5m-8-2v4m-3 5h5m3 0h3m-3-2v4" />
          </svg>
          Configure
        </Menu.Trigger>

        <Menu.Portal>
          <Menu.Positioner
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={16}
            positionMethod="fixed"
            className="z-30"
          >
            <Menu.Popup
              finalFocus={false}
              render={
                <motion.div
                  initial={{opacity: 0, scale: 0.95}}
                  animate={{opacity: 1, scale: 1}}
                  transition={{duration: 0.15, ease: 'easeOut'}}
                  style={{transformOrigin: 'bottom right'}}
                />
              }
              className="border-border bg-surface min-w-48 rounded-lg border p-1.5 font-mono shadow-xl outline-none"
            >
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger className="text-foreground data-[highlighted]:bg-surface-hover data-[popup-open]:bg-surface-hover flex min-h-10 cursor-default items-center justify-between gap-6 rounded-md px-3 text-xs outline-none">
                  Theme
                  <Chevron />
                </Menu.SubmenuTrigger>

                <Menu.Portal>
                  <Menu.Positioner
                    side="left"
                    align="end"
                    sideOffset={4}
                    collisionPadding={16}
                    positionMethod="fixed"
                    className="z-30"
                  >
                    <Menu.Popup
                      finalFocus={false}
                      render={
                        <motion.div
                          initial={{opacity: 0, scale: 0.95}}
                          animate={{opacity: 1, scale: 1}}
                          transition={{duration: 0.15, ease: 'easeOut'}}
                          style={{transformOrigin: 'bottom right'}}
                        />
                      }
                      className="border-border bg-surface min-w-40 rounded-lg border p-1.5 font-mono shadow-xl outline-none"
                    >
                      <Menu.RadioGroup
                        value={themeMode}
                        onValueChange={value => selectThemeMode(value as ThemeMode)}
                      >
                        {(['system', 'light', 'dark'] as const).map(mode => (
                          <Menu.RadioItem
                            key={mode}
                            value={mode}
                            className="text-foreground data-[highlighted]:bg-surface-hover grid min-h-10 cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-md px-3 text-xs capitalize outline-none"
                          >
                            <Menu.RadioItemIndicator className="text-foreground grid size-4 place-items-center">
                              <Check />
                            </Menu.RadioItemIndicator>
                            <span className="col-start-2">{mode}</span>
                          </Menu.RadioItem>
                        ))}
                      </Menu.RadioGroup>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.SubmenuRoot>

              <Menu.Item
                className="text-foreground data-[highlighted]:bg-surface-hover data-[disabled]:text-foreground-disabled flex min-h-10 cursor-default items-center justify-between gap-6 rounded-md px-3 text-xs outline-none"
                onClick={() => setSshKeysOpen(true)}
                disabled={!vaultExists}
              >
                SSH keys
                <Chevron />
              </Menu.Item>

              <Menu.Item
                className="text-foreground data-[highlighted]:bg-surface-hover data-[disabled]:text-foreground-disabled flex min-h-10 cursor-default items-center justify-between gap-6 rounded-md px-3 text-xs outline-none"
                disabled={!canEnableNotifications || working}
                onClick={() => void enableNotifications()}
              >
                {notificationLabel(notificationState)}
                <NotificationIcon enabled={notificationState === 'enabled'} />
              </Menu.Item>

              {vaultExists && (
                <>
                  <Menu.Separator className="bg-border my-1 h-px" />
                  <Menu.Item
                    className="text-danger data-[highlighted]:bg-surface-hover flex min-h-10 cursor-default items-center justify-between gap-6 rounded-md px-3 text-xs outline-none"
                    disabled={working}
                    onClick={() => setDeleteVaultOpen(true)}
                  >
                    Delete vault
                    <TrashIcon />
                  </Menu.Item>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <Dialog.Root open={sshKeysOpen} onOpenChange={setSshKeysOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="bg-overlay fixed inset-0 z-40" />
          <Dialog.Viewport className="fixed inset-0 z-50 grid items-end p-3">
            <Dialog.Popup
              ref={dialogRef}
              initialFocus={dialogRef}
              render={
                <motion.div
                  initial={{opacity: 0, scale: 0.9}}
                  animate={{opacity: 1, scale: 1}}
                  transition={{duration: 0.2, ease: 'easeOut'}}
                  style={{transformOrigin: 'bottom center'}}
                />
              }
              className="border-border bg-canvas relative grid max-h-full w-full grid-rows-[minmax(0,1fr)] overflow-hidden rounded-xl border font-mono shadow-xl outline-none"
            >
              <Dialog.Title className="sr-only">SSH keys</Dialog.Title>
              <Dialog.Close
                aria-label="Close SSH keys"
                className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-md transition-colors"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="m3 3 10 10M13 3 3 13" />
                </svg>
              </Dialog.Close>

              <KeyList />
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={deleteVaultOpen} onOpenChange={setDeleteVaultOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="bg-overlay fixed inset-0 z-40" />
          <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-5">
            <Dialog.Popup
              render={
                <motion.div
                  initial={{opacity: 0, scale: 0.94}}
                  animate={{opacity: 1, scale: 1}}
                  transition={{duration: 0.18, ease: 'easeOut'}}
                />
              }
              className="border-border bg-surface w-full max-w-sm rounded-xl border p-5 font-mono shadow-xl outline-none"
            >
              <div className="bg-expired-surface text-danger grid size-10 place-items-center rounded-full">
                <TrashIcon />
              </div>
              <Dialog.Title className="text-foreground mt-4 text-base font-semibold">
                Delete vault?
              </Dialog.Title>
              <Dialog.Description className="text-foreground-muted mt-2 text-xs leading-5">
                This permanently deletes every private key and the passkey-protected vault
                from this device. This action cannot be undone.
              </Dialog.Description>

              {error && (
                <p role="alert" className="text-danger mt-3 text-xs">
                  {error}
                </p>
              )}

              <div className="mt-6 grid grid-cols-2 gap-3">
                <Dialog.Close
                  disabled={working}
                  className="border-border-strong bg-surface text-foreground-muted hover:bg-surface-hover h-11 rounded-lg border px-4 text-xs font-semibold disabled:opacity-40"
                >
                  Cancel
                </Dialog.Close>
                <button
                  type="button"
                  disabled={working}
                  className="border-danger bg-danger h-11 rounded-lg border px-4 text-xs font-semibold text-white disabled:opacity-40"
                  onClick={() => void deleteVault()}
                >
                  {working ? 'Deleting…' : 'Delete vault'}
                </button>
              </div>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function notificationLabel(state: ReturnType<typeof useNotifications>['state']): string {
  if (state === 'enabled') {
    return 'Notifications enabled';
  }
  if (state === 'enabling') {
    return 'Enabling notifications…';
  }
  if (state === 'denied') {
    return 'Notifications blocked';
  }
  if (state === 'unavailable' || state === 'error') {
    return 'Notifications unavailable';
  }
  if (state === 'initializing') {
    return 'Checking notifications…';
  }

  return 'Enable notifications';
}

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="text-foreground-faint size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="m3 8 3 3 7-7" />
    </svg>
  );
}

function NotificationIcon({enabled}: {enabled: boolean}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={enabled ? 'text-foreground size-3.5' : 'text-foreground-faint size-3.5'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 11.5h10l-1.5-2V6.8A3.5 3.5 0 0 0 8 3.3a3.5 3.5 0 0 0-3.5 3.5v2.7l-1.5 2ZM6.5 13.5h3" />
      {enabled && <path d="m10.5 4 1 1 2-2" />}
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M2.5 4.5h11M6 2.5h4l.5 2h-5l.5-2ZM4 4.5l.75 9h6.5l.75-9M6.5 7v4M9.5 7v4" />
    </svg>
  );
}
