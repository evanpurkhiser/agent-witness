import {useEffect, useState} from 'react';

import {AnimatePresence, motion} from 'framer-motion';
import type {Variants} from 'framer-motion';

import type {AuthorizationRequestView, SettledAuthorizationView} from 'app/worker/api';

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
}

export function AuthorizationRequestList({
  requests,
  settled,
  error,
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
        <motion.div
          aria-hidden={retained.length > 0}
          className="text-foreground-faint pointer-events-none col-start-1 row-start-1 flex min-h-32 items-center justify-center text-xs"
          initial={false}
          animate={{opacity: retained.length === 0 ? 1 : 0}}
          transition={{duration: 0.18, ease: 'easeOut'}}
        >
          No pending requests
        </motion.div>
        <motion.ol
          aria-label="Authorization requests"
          aria-live="polite"
          className="col-start-1 row-start-1 grid content-start gap-2"
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
