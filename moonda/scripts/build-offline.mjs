import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve('dist');
async function filesAt(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(entries.map(entry => entry.isDirectory() ? filesAt(path.join(directory, entry.name)) : path.join(directory, entry.name)));
  return results.flat();
}
const files = (await filesAt(root)).filter(file => !file.endsWith('sw.js')).sort();
const digest = createHash('sha256');
for (const file of files) digest.update(await readFile(file));
const revision = digest.digest('hex').slice(0, 12);
const urls = ['./', ...files.map(file => `./${path.relative(root, file).split(path.sep).join('/')}`)];
const worker = `const CACHE='moonda-${revision}';
const FILES=${JSON.stringify(urls)};
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>{
  // A page may still request its previous hashed chunks during activation.
  // Keep that complete cache until the next update, and search it on a miss.
  const previous=keys.filter(key=>key.startsWith('moonda-')&&key!==CACHE);
  return Promise.all(previous.slice(0,-1).map(key=>caches.delete(key)));
}).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith(caches.open(CACHE).then(async cache=>{
    // Prefer fresh HTML online; fall back to the fully installed local build.
    if(event.request.mode==='navigate'){
      try{const response=await fetch(event.request);if(response.ok)return response;}catch{}
      return cache.match('./index.html',{ignoreVary:true});
    }
    // Local preview varies on Origin; module requests and precache fetches
    // can send different Origin headers for the same public static file.
    const hit=await cache.match(event.request,{ignoreVary:true})||await caches.match(event.request,{ignoreVary:true});if(hit)return hit;
    try{return await fetch(event.request);}catch(error){if(event.request.mode==='navigate')return cache.match('./index.html',{ignoreVary:true});throw error;}
  }));
});
`;
await writeFile(path.join(root, 'sw.js'), worker);
process.stdout.write(`Offline cache: ${files.length} files, revision ${revision}\n`);
