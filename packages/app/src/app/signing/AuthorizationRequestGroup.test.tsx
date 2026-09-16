import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';

import {AuthorizationRequestGroup} from './AuthorizationRequestGroup';
import type {
  RetainedAuthorizationRequest,
  RetainedAuthorizationRequestGroup,
} from './useRetainedAuthorizationRequestGroups';

const NOW = 1_800_000_000_000;

describe('AuthorizationRequestGroup', () => {
  it('shows shared context once above every signing request', () => {
    const html = renderToStaticMarkup(
      <AuthorizationRequestGroup
        group={group(
          {
            groupId: 'release-123',
            reason: 'Push the release',
            command: ['git', 'push', 'release candidate'],
          },
          [request('key-1', 'phone key'), request('key-2', 'backup key')],
        )}
        now={NOW}
      />,
    );

    expect(html.match(/<h2\b[^>]*>Push the release<\/h2>/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Requests for Push the release"');
    expect(html).toContain('git push &#x27;release candidate&#x27;');
    expect(html).toContain('phone key');
    expect(html).toContain('backup key');
  });

  it('renders a contextless request as a standalone group', () => {
    const html = renderToStaticMarkup(
      <AuthorizationRequestGroup
        group={group(undefined, [request('key-1', 'phone key')])}
        now={NOW}
      />,
    );

    expect(html).toContain('Signing with <code');
    expect(html).toContain('phone key');
    expect(html).not.toContain('View full command');
  });
});

function group(
  context: RetainedAuthorizationRequestGroup['context'],
  requests: RetainedAuthorizationRequest[],
): RetainedAuthorizationRequestGroup {
  return {key: context ? `context:${context.groupId}` : 'request:one', context, requests};
}

function request(keyId: string, comment: string): RetainedAuthorizationRequest {
  return {
    id: keyId,
    attempt: 1,
    requestedAt: NOW - 1_000,
    deadline: NOW + 30_000,
    key: {id: keyId, comment},
    status: 'active',
  };
}
