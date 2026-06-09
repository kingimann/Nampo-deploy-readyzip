/* Self-destroying service worker.
 *
 * The old installable-PWA build registered a service worker that cached the app
 * shell. This neutralizer is shipped at that worker's path; the browser
 * revalidates the worker script on navigation, picks up THIS version, and it
 * then deletes all caches and unregisters itself. The next plain navigation is
 * served fresh from the network (the current app ships no worker), so the
 * stale shell is gone for good.
 *
 * IMPORTANT: it does NOT reload/navigate clients. An earlier version called
 * clients.navigate() here, which created an infinite reload loop — the old
 * cached shell would re-register this worker, which reloaded, which served the
 * cached shell again, and so on. Clearing caches + unregistering (with no
 * forced reload) breaks that cycle.
 */
self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      // Drop every Cache Storage entry the old worker left behind, so nothing
      // can keep serving the stale app shell.
      try {
        if (self.caches && caches.keys) {
          var keys = await caches.keys();
          await Promise.all(
            keys.map(function (k) {
              return caches.delete(k);
            })
          );
        }
      } catch (e) {}
      // Remove this worker's registration entirely. No navigate() — see note.
      try {
        await self.registration.unregister();
      } catch (e) {}
    })()
  );
});

// No "fetch" handler: a worker without one does not intercept requests, so
// navigations go straight to the network.
