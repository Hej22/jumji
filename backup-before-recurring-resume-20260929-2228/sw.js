const C='jumji-v25';
self.addEventListener('install',event=>event.waitUntil(caches.open(C).then(cache=>cache.addAll(['./','./index.html','./style.css','./app.js','./manifest.json']))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('jumji-v')&&key!==C).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;event.respondWith(caches.open(C).then(cache=>cache.match(event.request).then(response=>response||fetch(event.request))));});
