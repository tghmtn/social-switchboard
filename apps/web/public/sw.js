// Social Switchboard's service worker. It only shows notifications: it doesn't cache or intercept
// anything, so the app always loads fresh from the server.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  // Every push shows a notification (iPhones stop delivering to apps that don't). One per
  // conversation: a newer one replaces the last.
  event.waitUntil(
    self.registration.showNotification(data.title || 'Social Switchboard', {
      body: data.body || '',
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: '/icon-192.png',
      data: { url: data.url || '/inbox' },
    }),
  );
});

// Tapping one opens its conversation: in the app if it's open (without reloading it), or a new
// window.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/inbox', self.location.origin);
  const path = url.origin === self.location.origin ? url.pathname + url.search : '/inbox';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: 'open', path });
        return;
      }
      await self.clients.openWindow(path);
    })(),
  );
});
