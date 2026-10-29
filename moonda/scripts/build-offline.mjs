import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve('dist');
async function filesAt(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(entries.map(entry => entry.isDirectory() ? filesAt(path.join(directory, entry.name)) : path.join(directory, entry.name)));
  return results.flat();
}
const indexPath = path.join(root, 'index.html');
const cleanIndex = (await readFile(indexPath, 'utf8')).replace(/\s*<meta name="moonda-cache-revision" content="[^"]*">/g, '');
await writeFile(indexPath, cleanIndex);
const files = (await filesAt(root)).filter(file => !file.endsWith('sw.js')).sort();
const relativeFile = file => path.relative(root, file).split(path.sep).join('/');
const digest = createHash('sha256');
for (const file of files) {
  const content = await readFile(file);
  digest.update(`${relativeFile(file)}\0${content.length}\0`);
  digest.update(content);
}
const revision = digest.digest('hex').slice(0, 12);
await writeFile(indexPath, cleanIndex.replace('</head>', `  <meta name="moonda-cache-revision" content="${revision}">\n</head>`));
const entries = await Promise.all(files.map(async file => ({ url: `./${relativeFile(file)}`, bytes: (await stat(file)).size })));
const worker = `const REVISION=${JSON.stringify(revision)};
const CACHE='moonda-'+REVISION;
const FILES=${JSON.stringify(entries)};
const TOTAL_BYTES=FILES.reduce((sum,file)=>sum+file.bytes,0);
const COMPLETE=new URL('./.__moonda_complete__',self.location.href).href;
let completed=0,downloadedBytes=0;
function status(value){return {type:'MOONDA_OFFLINE_STATUS',revision:REVISION,status:value,completed,total:FILES.length,bytes:downloadedBytes,totalBytes:TOTAL_BYTES};}
async function broadcast(value){
  const clients=await self.clients.matchAll({includeUncontrolled:true,type:'window'});
  clients.forEach(client=>client.postMessage(status(value)));
}
self.addEventListener('install',event=>{event.waitUntil((async()=>{
  try{
    const cache=await caches.open(CACHE);
    await broadcast('installing');
    let cursor=0,failed=false;
    // Large terrain packages install in a bounded queue, without flooding the
    // browser with hundreds of simultaneous file requests.
    const results=await Promise.allSettled(Array.from({length:Math.min(6,FILES.length)},async()=>{
      while(!failed&&cursor<FILES.length){
        const file=FILES[cursor++];
        try{
          const response=await fetch(new Request(new URL(file.url,self.location.href),{cache:'reload'}));
          if(!response.ok)throw new Error('Offline download failed: '+file.url+' ('+response.status+')');
          await cache.put(new URL(file.url,self.location.href).href,response);
          completed++;downloadedBytes+=file.bytes;
          if(completed%5===0||completed===FILES.length)await broadcast('installing');
        }catch(error){failed=true;throw error;}
      }
    }));
    if(results.some(result=>result.status==='rejected')){
      throw new Error('The complete offline package could not be cached.');
    }
    await cache.put(COMPLETE,new Response(REVISION));
    await self.skipWaiting();
  }catch(error){
    try{await broadcast('error');}catch{}
    throw error;
  }
})());});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{
  const keys=await caches.keys();
  const previous=keys.filter(key=>key.startsWith('moonda-')&&key!==CACHE);
  let retainedPrevious;
  for(const key of [...previous].reverse()){
    const marker=await (await caches.open(key)).match(COMPLETE);
    if(marker&&await marker.text()===key.slice('moonda-'.length)){
      retainedPrevious=key;break;
    }
  }
  await Promise.all(previous.filter(key=>key!==retainedPrevious).map(key=>caches.delete(key)));
  await self.clients.claim();
  completed=FILES.length;downloadedBytes=TOTAL_BYTES;
  await broadcast('ready');
})());});
self.addEventListener('message',event=>{
  if(event.data?.type!=='MOONDA_OFFLINE_STATUS')return;
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    const ready=await cache.match(COMPLETE);
    if(ready){completed=FILES.length;downloadedBytes=TOTAL_BYTES;}
    event.source?.postMessage(status(ready?'ready':'error'));
  })());
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith(caches.open(CACHE).then(async cache=>{
    if(event.request.mode==='navigate'){
      try{const response=await fetch(event.request);if(response.ok)return response;}catch{}
      return cache.match(new URL('./index.html',self.location.href).href,{ignoreVary:true});
    }
    // Preview CORS headers vary on Origin; module and installation requests can
    // carry different headers for the same public static asset.
    const hit=await cache.match(event.request,{ignoreVary:true})||await caches.match(event.request,{ignoreVary:true});
    if(hit)return hit;
    return fetch(event.request);
  }));
});
`;
await writeFile(path.join(root, 'sw.js'), worker);
process.stdout.write(`Offline cache: ${files.length} files, ${(entries.reduce((sum, file) => sum + file.bytes, 0) / 1e6).toFixed(1)} MB, revision ${revision}\n`);
