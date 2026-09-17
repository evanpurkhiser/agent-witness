import {useState} from 'react';

import type {AuthorizationRequestView, SettledAuthorizationView} from 'app/worker/api';

import {SigningScreen} from './signing/SigningScreen';

function createRequests(): AuthorizationRequestView[] {
  const now = Date.now();
  const groups = [
    {
      groupId: 'preview-release',
      reason: 'Push the release',
      command: ['git', 'push', 'origin', 'main'],
      keys: ['personal', 'backup'],
    },
    {
      groupId: 'preview-deploy',
      reason: 'Deploy the nginx configuration',
      command: [
        'ansible-playbook',
        '-i',
        'inventory',
        'play-server.yml',
        '--tags',
        'nginx',
      ],
      keys: ['server'],
    },
    {
      groupId: 'preview-fetch',
      reason: 'Fetch the latest changes',
      command: ['git', 'fetch', '--all', '--prune'],
      keys: ['work'],
    },
  ];

  return groups.flatMap(({keys, ...context}, index) =>
    keys.map((comment, keyIndex) => ({
      id: `${context.groupId}-${comment}`,
      attempt: 1,
      requestedAt: now - (index * 7 + keyIndex * 2 + 3) * 1000,
      deadline: now + (90 - index * 15) * 1000,
      context,
      key: {id: comment, comment},
    })),
  );
}

export default function PreviewApp() {
  const [requests, setRequests] = useState(createRequests);
  const [settled, setSettled] = useState<SettledAuthorizationView[]>([]);

  function reset() {
    setSettled([]);
    setRequests(createRequests());
  }

  function authorize() {
    setSettled(
      requests.map(({id, attempt}) => ({
        id,
        attempt,
        status: 'signed',
        settledAt: Date.now(),
      })),
    );
    setRequests([]);
  }

  return (
    <SigningScreen
      connection={{
        status: 'connected',
        serverId: 'preview',
        sessionId: 'preview',
        vapidPublicKey: null,
        pendingRequests: requests.length,
        error: null,
      }}
      authorizationRequests={requests}
      settledAuthorizations={settled}
      vault={{
        status: 'locked',
        vault: {id: 'preview', createdAt: 0, passkeys: [], keys: []},
      }}
      working={false}
      error={null}
      onCreateVault={reset}
      onForgetPairing={reset}
      onAuthorize={authorize}
      configuration={
        <button
          type="button"
          className="text-foreground-subtle min-h-11 px-2 text-[10px] uppercase"
          onClick={reset}
        >
          Preview · Reset
        </button>
      }
    />
  );
}
