export function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('service workers are not supported by this browser');
  }

  const script = import.meta.env.DEV ? '/service-worker.ts' : '/service-worker.js';
  return navigator.serviceWorker.register(script, {scope: '/'});
}
