const serviceWorker = globalThis as unknown as ServiceWorkerGlobalScope;

interface PushPayload {
  request_id?: string;
  server?: string;
}

serviceWorker.addEventListener('push', event => {
  const payload = readPayload(event);
  const body = payload.server
    ? `${payload.server} is requesting SSH authentication.`
    : 'A server is requesting SSH authentication.';

  event.waitUntil(
    serviceWorker.registration.showNotification('SSH authentication requested', {
      body,
      data: {url: '/'},
      tag: payload.request_id,
    }),
  );
});

serviceWorker.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(openApp());
});

function readPayload(event: PushEvent): PushPayload {
  if (!event.data) {
    return {};
  }

  try {
    return event.data.json() as PushPayload;
  } catch {
    return {};
  }
}

async function openApp(): Promise<void> {
  const windows = await serviceWorker.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const existing = windows.find(
    client => new URL(client.url).origin === serviceWorker.location.origin,
  );
  if (existing) {
    await (existing as WindowClient).focus();
    return;
  }

  await serviceWorker.clients.openWindow('/');
}
