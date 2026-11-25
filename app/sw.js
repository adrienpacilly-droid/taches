// Garde l'application sur l'appareil pour l'ouvrir hors connexion. Les tâches n'y passent jamais.
const NOM = 'taches-2';
const FICHIERS = ['./', 'index.html', 'app.css', 'app.js', 'core.js', 'net.js', 'config.js', 'manifest.webmanifest', 'icone-180.png', 'icone-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(NOM).then(c => c.addAll(FICHIERS.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(l => Promise.all(l.filter(n => n.startsWith('taches-') && n !== NOM).map(n => caches.delete(n)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !u.href.startsWith(self.registration.scope)) return;
  e.respondWith((async () => {
    const c = await caches.open(NOM), known = await c.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
    if (!known) return fresh;
    fresh.catch(() => {});
    return Promise.race([fresh, new Promise(ok => setTimeout(() => ok(known), 2500))]).catch(() => known);
  })());
});
