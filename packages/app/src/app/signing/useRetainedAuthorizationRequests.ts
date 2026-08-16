import {useEffect, useRef, useState} from 'react';

import type {AuthorizationRequestView, SettledAuthorizationView} from 'app/worker/api';

const SETTLED_RETENTION_MS = 10_000;

export type RetainedAuthorizationRequest = AuthorizationRequestView &
  ({status: 'active'} | Pick<SettledAuthorizationView, 'status' | 'settledAt'>);

export function useRetainedAuthorizationRequests(
  requests: AuthorizationRequestView[],
  settled: SettledAuthorizationView[],
): RetainedAuthorizationRequest[] {
  const [retained, setRetained] = useState<RetainedAuthorizationRequest[]>(() =>
    requests.map(request => ({...request, status: 'active'})),
  );
  const removalTimers = useRef(new Map<string, number>());

  useEffect(() => {
    const activeByKey = new Map(requests.map(request => [requestKey(request), request]));
    const settledByKey = new Map(settled.map(request => [requestKey(request), request]));

    setRetained(current => {
      const currentKeys = new Set(current.map(requestKey));
      const updated = current.reduce<RetainedAuthorizationRequest[]>((items, request) => {
        const active = activeByKey.get(requestKey(request));
        if (active) {
          items.push({...active, status: 'active'});
          return items;
        }
        if (request.status !== 'active') {
          items.push(request);
          return items;
        }

        const outcome = settledByKey.get(requestKey(request));
        if (outcome) {
          items.push({
            ...request,
            status: outcome.status,
            settledAt: outcome.settledAt,
          });
        }
        return items;
      }, []);

      const added: RetainedAuthorizationRequest[] = requests
        .filter(request => !currentKeys.has(requestKey(request)))
        .map(request => ({...request, status: 'active'}));

      return [...updated, ...added];
    });
  }, [requests, settled]);

  useEffect(() => {
    const settledKeys = new Set(
      retained.filter(request => request.status !== 'active').map(requestKey),
    );

    for (const [key, timer] of removalTimers.current) {
      if (!settledKeys.has(key)) {
        window.clearTimeout(timer);
        removalTimers.current.delete(key);
      }
    }

    for (const request of retained) {
      if (request.status === 'active') {
        continue;
      }

      const key = requestKey(request);
      if (removalTimers.current.has(key)) {
        continue;
      }

      const remaining = Math.max(
        0,
        request.settledAt + SETTLED_RETENTION_MS - Date.now(),
      );
      const timer = window.setTimeout(() => {
        removalTimers.current.delete(key);
        setRetained(current =>
          current.filter(candidate => requestKey(candidate) !== key),
        );
      }, remaining);
      removalTimers.current.set(key, timer);
    }
  }, [retained]);

  useEffect(
    () => () => {
      for (const timer of removalTimers.current.values()) {
        window.clearTimeout(timer);
      }
    },
    [],
  );

  return retained;
}

function requestKey(request: {id: string; attempt: number}): string {
  return `${request.id}:${request.attempt}`;
}
