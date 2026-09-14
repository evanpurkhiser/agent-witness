import {AnimatePresence, motion} from 'framer-motion';

import {AuthorizationRequestRow} from './AuthorizationRequestRow';
import {RequestCommand} from './RequestCommand';
import type {RetainedAuthorizationRequestGroup} from './useRetainedAuthorizationRequestGroups';

interface AuthorizationRequestGroupProps {
  group: RetainedAuthorizationRequestGroup;
  now: number;
}

export function AuthorizationRequestGroup({group, now}: AuthorizationRequestGroupProps) {
  return (
    <article className="border-border bg-surface overflow-hidden rounded-lg border shadow-xs">
      {group.context && (
        <header className="px-4 py-3.5">
          <h2 className="text-foreground text-xs leading-5 font-medium">
            {group.context.reason}
          </h2>
          <RequestCommand command={group.context.command} />
        </header>
      )}
      <ol
        aria-label={group.context ? `Requests for ${group.context.reason}` : 'Request'}
        className={group.context ? 'border-border border-t' : undefined}
      >
        <AnimatePresence initial={false}>
          {group.requests.map((request, index) => (
            <motion.li
              key={`${request.id}:${request.attempt}`}
              layout="position"
              initial={{opacity: 0, height: 0}}
              animate={{opacity: 1, height: 'auto'}}
              exit={{opacity: 0, height: 0}}
              transition={{duration: 0.18, ease: 'easeOut'}}
              className={`list-none ${index === 0 ? '' : 'border-border border-t'}`}
            >
              <AuthorizationRequestRow request={request} now={now} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </article>
  );
}
