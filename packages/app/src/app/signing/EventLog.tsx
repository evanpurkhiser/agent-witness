import {useLayoutEffect, useRef} from 'react';

import type {AgentEvent} from 'app/worker/events';

import {EventRow} from './EventRow';

interface EventLogProps {
  events: AgentEvent[];
  error: string | null;
}

export function EventLog({events, error}: EventLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll) {
      scroll.scrollTop = scroll.scrollHeight;
    }
  }, [events.length, error]);

  return (
    <section
      aria-labelledby="event-log-heading"
      className="border-border bg-surface flex min-h-0 flex-col overflow-hidden rounded-lg border shadow-xs"
    >
      <header className="border-border flex h-11 shrink-0 items-center justify-between border-b px-3.5">
        <h1
          id="event-log-heading"
          className="text-foreground-muted text-[11px] font-semibold tracking-[0.16em] uppercase"
        >
          Event log
        </h1>
        <span
          aria-label={`${events.length} ${events.length === 1 ? 'event' : 'events'}`}
          className="text-[10px] tabular-nums text-zinc-400"
        >
          {String(events.length).padStart(3, '0')}
        </span>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
      >
        <div className="flex min-h-full flex-col justify-end">
          {events.length === 0 ? (
            <p className="text-foreground-faint px-3.5 py-3 text-xs">
              No events recorded.
            </p>
          ) : (
            <ol aria-label="Agent events" aria-live="polite" aria-relevant="additions">
              {events.map(event => (
                <EventRow key={event.id} event={event} />
              ))}
            </ol>
          )}
          {error && (
            <p
              role="alert"
              className="grid grid-cols-[3.25rem_minmax(0,1fr)] px-3.5 py-2 text-xs"
            >
              <span className="text-danger-subtle">error</span>
              <span className="text-danger">{error}</span>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
