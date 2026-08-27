// Send It - push notification service worker.
// Deploy this file at the REPO ROOT (same folder as index.html) - a service worker's scope is
// limited to the folder it's served from and everything below it, so it has to sit at the top
// level to cover the whole app.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Fired when the Edge Function sends a push via the Web Push protocol. The payload is whatever
// JSON the send-push-notification Edge Function put in the message body.
self.addEventListener('push', (event) => {
  let data = { title: 'Send It', body: 'Something happened in your training.' };
  try{
    if(event.data) data = event.data.json();
  }catch(e){
    // Not JSON - fall back to plain text so a malformed payload still shows something
    if(event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body || '',
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    data: { url: data.url || '/' },
    tag: data.tag || 'send-it-notification', // same tag replaces a previous unread notification instead of stacking endlessly
  };

  event.waitUntil(self.registration.showNotification(data.title || 'Send It', options));
});

// Clicking the notification focuses an existing tab if the app's already open, otherwise opens
// a new one - avoids piling up duplicate tabs every time someone taps a notification.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for(const client of clientList){
        if('focus' in client) return client.focus();
      }
      if(self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
