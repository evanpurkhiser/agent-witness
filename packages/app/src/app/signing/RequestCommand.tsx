import {Dialog} from '@base-ui/react/dialog';
import {motion} from 'framer-motion';

import {formatCommand} from './formatCommand';

interface RequestCommandProps {
  command: string[];
}

export function RequestCommand({command}: RequestCommandProps) {
  const formatted = formatCommand(command);

  return (
    <Dialog.Root>
      <Dialog.Trigger
        aria-label="View full command"
        className="border-border bg-canvas hover:border-border-strong mt-2 block w-full cursor-zoom-in overflow-hidden rounded-md border px-3 py-2 text-left transition-colors"
      >
        <code className="text-foreground-subtle line-clamp-2 block break-all font-mono text-[11px] leading-5">
          {formatted}
        </code>
      </Dialog.Trigger>
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
            className="border-border bg-surface grid max-h-full w-full max-w-lg grid-rows-[auto_minmax(0,1fr)_auto] rounded-xl border p-5 font-mono shadow-xl outline-none"
          >
            <Dialog.Title className="text-foreground text-sm font-semibold">
              Command
            </Dialog.Title>
            <pre className="border-border bg-canvas text-foreground mt-3 min-h-0 overflow-auto rounded-lg border p-4 text-xs leading-5 whitespace-pre-wrap break-all">
              <code>{formatted}</code>
            </pre>
            <Dialog.Close className="border-border-strong bg-surface text-foreground-muted hover:bg-surface-hover mt-4 h-10 rounded-lg border px-4 text-xs font-semibold">
              Close
            </Dialog.Close>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
