import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Script } from 'node:vm';

let fixture: string;
let source: string;
let html: string;
const origin = 'https://moonda.test';
const payloads = new Map<string, string>();
beforeAll(() => {
  const cacheRoot = path.resolve('node_modules/.cache');
  mkdirSync(cacheRoot, { recursive: true });
  fixture = mkdtempSync(path.join(cacheRoot, 'offline-test-'));
  mkdirSync(path.join(fixture, 'dist/assets'), { recursive: true });
  writeFileSync(path.join(fixture, 'dist/index.html'), '<html><head></head><body>MOONDA</body></html>');
  for (let i = 0; i < 12; i++) writeFileSync(path.join(fixture, `dist/assets/tile-${i}.glb`), `terrain-${i}`);
  execFileSync(process.execPath, [path.resolve('scripts/build-offline.mjs')], { cwd: fixture });
  source = readFileSync(path.join(fixture, 'dist/sw.js'), 'utf8');
  html = readFileSync(path.join(fixture, 'dist/index.html'), 'utf8');
  payloads.set(`${origin}/index.html`, html);
  for (let i = 0; i < 12; i++) payloads.set(`${origin}/assets/tile-${i}.glb`, `terrain-${i}`);
});
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function harness() {
  const handlers: Record<string, (event: any) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const messages: any[] = [];
  let online = true, activeFetches = 0, peakFetches = 0, skipped = false, failPath = '';
  let storageFailure: 'open' | 'marker' | undefined;
  const key = (input: any) => new URL(typeof input === 'string' ? input : input.url, `${origin}/sw.js`).href;
  const open = async (name: string) => {
    if (storageFailure === 'open') throw new Error('Cache storage denied');
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      put: async (input: any, response: Response) => {
        if (storageFailure === 'marker' && key(input).endsWith('/.__moonda_complete__')) throw new Error('Completion marker quota exceeded');
        store.set(key(input), response.clone());
      },
      match: async (input: any, options?: { ignoreVary?: boolean }) => {
        const response = store.get(key(input));
        // Model the actual preview-server failure: module Origin headers differ
        // from precache fetches while the public file itself is identical.
        if (response?.headers.get('Vary') === 'Origin' && !options?.ignoreVary) return undefined;
        return response?.clone();
      },
    };
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (input: any, options: any) => {
      for (const name of stores.keys()) {
        const hit = await (await open(name)).match(input, options);
        if (hit) return hit;
      }
    },
  };
  const fetch = async (input: any) => {
    if (!online) throw new Error('Network is unavailable');
    activeFetches++; peakFetches = Math.max(peakFetches, activeFetches);
    await new Promise(resolve => setTimeout(resolve, 1));
    activeFetches--;
    const url = key(input), body = payloads.get(url);
    return new Response(body ?? 'missing', { status: !body || url.endsWith(failPath || '/never-fail') ? 404 : 200, headers: { Vary: 'Origin' } });
  };
  const self = {
    location: { href: `${origin}/sw.js`, origin },
    addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler; },
    clients: { matchAll: async () => [{ postMessage: (message: any) => messages.push(message) }], claim: async () => {} },
    skipWaiting: async () => { skipped = true; },
  };
  new Script(source).runInNewContext({ self, caches, fetch, Request, Response, URL, Promise });
  async function lifecycle(type: string, data?: any) {
    let pending: Promise<unknown> | undefined;
    handlers[type]({ data, source: { postMessage: (message: any) => messages.push(message) }, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
  }
  async function request(url: string, mode = 'cors') {
    let pending: Promise<Response> | undefined;
    handlers.fetch({ request: { url: `${origin}${url}`, method: 'GET', mode }, respondWith: (promise: Promise<Response>) => { pending = promise; } });
    return pending;
  }
  return { lifecycle, request, stores, messages, open, setOnline: (value: boolean) => { online = value; }, fail: (value: string) => { failPath = value; }, failStorage: (value: 'open' | 'marker') => { storageFailure = value; }, get peak() { return peakFetches; }, get skipped() { return skipped; } };
}

describe('complete offline visual package', () => {
  it('installs with bounded concurrency and reports the matching HTML revision', async () => {
    const h = harness();
    await h.lifecycle('install'); await h.lifecycle('activate');
    expect(h.peak).toBeLessThanOrEqual(6);
    expect(h.peak).toBeGreaterThan(1);
    expect(h.skipped).toBe(true);
    const ready = h.messages.at(-1);
    expect(ready.status).toBe('ready');
    expect(ready.completed).toBe(13);
    expect(ready.bytes).toBe(ready.totalBytes);
    expect(html).toContain(`content="${ready.revision}"`);
  });
  it('reloads HTML and serves Origin-varying terrain files with no server', async () => {
    const h = harness(); await h.lifecycle('install'); await h.lifecycle('activate');
    h.setOnline(false);
    expect(await (await h.request('/', 'navigate'))?.text()).toContain('MOONDA');
    expect(await (await h.request('/assets/tile-11.glb'))?.text()).toBe('terrain-11');
    await h.lifecycle('message', { type: 'MOONDA_OFFLINE_STATUS' });
    expect(h.messages.at(-1).status).toBe('ready');
  });
  it('retains the last complete bundle despite a newer failed partial install', async () => {
    const h = harness();
    await (await h.open('moonda-obsolete')).put(`${origin}/oldest.js`, new Response('obsolete'));
    await (await h.open('moonda-obsolete')).put(`${origin}/.__moonda_complete__`, new Response('obsolete'));
    await (await h.open('moonda-previous')).put(`${origin}/previous.js`, new Response('previous chunk'));
    await (await h.open('moonda-previous')).put(`${origin}/.__moonda_complete__`, new Response('previous'));
    await (await h.open('moonda-failed')).put(`${origin}/partial.js`, new Response('partial chunk'));
    await h.lifecycle('install'); await h.lifecycle('activate'); h.setOnline(false);
    expect(h.stores.has('moonda-obsolete')).toBe(false);
    expect(h.stores.has('moonda-failed')).toBe(false);
    expect(h.stores.has('moonda-previous')).toBe(true);
    expect(await (await h.request('/previous.js'))?.text()).toBe('previous chunk');
  });
  it('does not activate or report ready after any terrain download fails', async () => {
    const h = harness(); h.fail('/tile-3.glb');
    await expect(h.lifecycle('install')).rejects.toThrow('complete offline package');
    expect(h.skipped).toBe(false);
    expect(h.messages.at(-1).status).toBe('error');
    await h.lifecycle('message', { type: 'MOONDA_OFFLINE_STATUS' });
    expect(h.messages.at(-1).status).toBe('error');
  });
  it.each(['open', 'marker'] as const)('reports an installation error when %s storage fails', async stage => {
    const h = harness(); h.failStorage(stage);
    await expect(h.lifecycle('install')).rejects.toThrow(stage === 'open' ? 'Cache storage denied' : 'Completion marker quota exceeded');
    expect(h.skipped).toBe(false);
    expect(h.messages.at(-1).status).toBe('error');
    expect(h.messages.some(message => message.status === 'ready')).toBe(false);
  });
  it('changes the revision when an asset path changes without changing its contents', () => {
    const directory = path.join(fixture, 'path-identity');
    mkdirSync(path.join(directory, 'dist/assets'), { recursive: true });
    writeFileSync(path.join(directory, 'dist/index.html'), '<html><head>\n</head><body>MOONDA</body></html>');
    writeFileSync(path.join(directory, 'dist/assets/old-name.glb'), 'same terrain');
    const build = () => {
      execFileSync(process.execPath, [path.resolve('scripts/build-offline.mjs')], { cwd: directory });
      return readFileSync(path.join(directory, 'dist/sw.js'), 'utf8').match(/const REVISION="([^"]+)";/)?.[1];
    };
    const before = build();
    expect(build()).toBe(before);
    renameSync(path.join(directory, 'dist/assets/old-name.glb'), path.join(directory, 'dist/assets/new-name.glb'));
    const after = build();
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });
});
