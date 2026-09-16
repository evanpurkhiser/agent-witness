const serviceWorker = globalThis as unknown as ServiceWorkerGlobalScope;

interface PushPayload {
  title: string;
  body: string;
}

serviceWorker.addEventListener('push', event => {
  const payload = event.data!.json() as PushPayload;

  const options = {
    body: payload.body,
    data: {url: '/'},
    tag: 'signing-requests',
    renotify: true,
  };
  event.waitUntil(serviceWorker.registration.showNotification(payload.title, options));
});

serviceWorker.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(openApp());
});

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
