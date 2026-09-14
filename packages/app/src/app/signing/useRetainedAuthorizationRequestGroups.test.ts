import {describe, expect, it} from 'vitest';

import {
  groupAuthorizationRequests,
  type RetainedAuthorizationRequest,
} from './useRetainedAuthorizationRequestGroups';

describe('groupAuthorizationRequests', () => {
  it('groups requests by context group ID and keeps the first context', () => {
    const first = request('one', {
      groupId: 'release-123',
      reason: 'Push the release',
      command: ['git', 'push'],
    });
    const second = request('two', {
      groupId: 'release-123',
      reason: 'Ignored because the group context is canonical',
      command: ['false'],
    });

    expect(groupAuthorizationRequests([first, second])).toEqual([
      {
        key: 'context:release-123',
        context: first.context,
        requests: [first, second],
      },
    ]);
  });

  it('places contextless requests in independent groups', () => {
    const first = request('one');
    const second = request('two');

    expect(groupAuthorizationRequests([first, second])).toEqual([
      {key: 'request:one:1', context: undefined, requests: [first]},
      {key: 'request:two:1', context: undefined, requests: [second]},
    ]);
  });
});

function request(
  id: string,
  context?: RetainedAuthorizationRequest['context'],
): RetainedAuthorizationRequest {
  return {
    id,
    attempt: 1,
    requestedAt: 1_800_000_000_000,
    deadline: 1_800_000_030_000,
    context,
    key: {id: `key-${id}`, comment: `${id} key`},
    status: 'active',
  };
}
