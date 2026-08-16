import {useRef, useState} from 'react';

import {Dialog} from '@base-ui/react/dialog';
import {Menu} from '@base-ui/react/menu';
import {motion} from 'framer-motion';

import {KeyList} from './KeyList';

export function ConfigurationMenu() {
  const [sshKeysOpen, setSshKeysOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

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
              <Menu.Item
                className="text-foreground data-[highlighted]:bg-surface-hover flex min-h-10 cursor-default items-center justify-between gap-6 rounded-md px-3 text-xs outline-none"
                onClick={() => setSshKeysOpen(true)}
              >
                SSH keys
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
              </Menu.Item>
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
    </>
  );
}
