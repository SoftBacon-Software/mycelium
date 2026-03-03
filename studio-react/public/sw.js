// Mycelium Service Worker — Push Notifications

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  if (!event.data) return;

  var payload;
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { title: 'Mycelium', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Mycelium', {
      body: payload.body || '',
      icon: '/fungal_horror.png',
      badge: '/fungal_horror.png',
      tag: payload.tag || 'mycelium',
      data: payload.data || { url: '/m' },
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var url = (event.notification.data && event.notification.data.url) || '/m';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      // Focus existing window if available
      for (var i = 0; i < clients.length; i++) {
        if (clients[i].url.indexOf('/m') !== -1 && 'focus' in clients[i]) {
          return clients[i].focus();
        }
      }
      // Open new window
      return self.clients.openWindow(url);
    })
  );
});
