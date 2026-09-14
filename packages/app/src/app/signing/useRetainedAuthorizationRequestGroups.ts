import {useEffect, useMemo, useRef, useState} from 'react';

import type {RequestContext} from 'app/remote/protocol';
import type {AuthorizationRequestView, SettledAuthorizationView} from 'app/worker/api';

const SETTLED_RETENTION_MS = 10_000;

export type RetainedAuthorizationRequest = AuthorizationRequestView &
  ({status: 'active'} | Pick<SettledAuthorizationView, 'status' | 'settledAt'>);

export interface RetainedAuthorizationRequestGroup {
  key: string;
  context?: RequestContext;
  requests: RetainedAuthorizationRequest[];
}

export function useRetainedAuthorizationRequestGroups(
  requests: AuthorizationRequestView[],
  settled: SettledAuthorizationView[],
): RetainedAuthorizationRequestGroup[] {
  const [retained, setRetained] = useState<RetainedAuthorizationRequest[]>(() =>
    requests.map(request => ({...request, status: 'active'})),
  );
  const removalTimers = useRef(new Map<string, number>());
  const groups = useMemo(() => groupAuthorizationRequests(retained), [retained]);

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
    const settledGroups = new Map(
      groups.flatMap(group => {
        if (group.requests.some(request => request.status === 'active')) {
          return [];
        }

        const settledAt = Math.max(
          ...group.requests.map(request =>
            request.status === 'active' ? 0 : request.settledAt,
          ),
        );
        return [[group.key, settledAt] as const];
      }),
    );

    for (const [key, timer] of removalTimers.current) {
      if (!settledGroups.has(key)) {
        window.clearTimeout(timer);
        removalTimers.current.delete(key);
      }
    }

    for (const [key, settledAt] of settledGroups) {
      if (removalTimers.current.has(key)) {
        continue;
      }

      const remaining = Math.max(0, settledAt + SETTLED_RETENTION_MS - Date.now());
      const timer = window.setTimeout(() => {
        removalTimers.current.delete(key);
        setRetained(current =>
          current.filter(candidate => requestGroupKey(candidate) !== key),
        );
      }, remaining);
      removalTimers.current.set(key, timer);
    }
  }, [groups]);

  useEffect(
    () => () => {
      for (const timer of removalTimers.current.values()) {
        window.clearTimeout(timer);
      }
    },
    [],
  );

  return groups;
}

export function groupAuthorizationRequests(
  requests: RetainedAuthorizationRequest[],
): RetainedAuthorizationRequestGroup[] {
  const groups = new Map<string, RetainedAuthorizationRequestGroup>();

  for (const request of requests) {
    const key = requestGroupKey(request);
    const group = groups.get(key);
    if (group) {
      group.requests.push(request);
      continue;
    }

    groups.set(key, {
      key,
      context: request.context,
      requests: [request],
    });
  }

  return [...groups.values()];
}

function requestGroupKey(request: AuthorizationRequestView): string {
  return request.context
    ? `context:${request.context.groupId}`
    : `request:${requestKey(request)}`;
}

function requestKey(request: {id: string; attempt: number}): string {
  return `${request.id}:${request.attempt}`;
}
