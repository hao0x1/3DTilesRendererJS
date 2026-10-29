import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ pending: [] as { resolve: (value: any) => void; reject: (reason: unknown) => void; signal: AbortSignal }[] }));
vi.mock('./scenarioData', async importOriginal => {
  const actual = await importOriginal<typeof import('./scenarioData')>();
  return { ...actual, ScenarioEngine: class {
    prepare(_request: unknown, options: { signal: AbortSignal }) {
      return new Promise((resolve, reject) => state.pending.push({ resolve, reject, signal: options.signal }));
    }
  } };
});

afterEach(() => { vi.unstubAllGlobals(); state.pending.length = 0; });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

describe('scenario worker request lifecycle', () => {
  it('keeps the replacement active when an older request used the same ID', async () => {
    vi.resetModules();
    const scope = { location: { href: 'http://localhost/demo/assets/scenario.worker.js' }, postMessage: vi.fn(), onmessage: null as null | ((event: any) => void) };
    vi.stubGlobal('self', scope);
    await import('./scenario.worker');
    const request = { type: 'prepare', jobId: 'A', request: {} };
    scope.onmessage!({ data: request });
    scope.onmessage!({ data: request });
    expect(state.pending[0].signal.aborted).toBe(true);
    state.pending[0].resolve({ scenarioId: 'old' });
    await flush();
    state.pending[1].resolve({ scenarioId: 'new' });
    await flush();
    expect(scope.postMessage.mock.calls.map(call => call[0])).toEqual([{ type: 'result', jobId: 'A', result: { scenarioId: 'new' } }]);
  });
  it('cancels only the current matching request and reports its cancellation', async () => {
    vi.resetModules();
    const scope = { location: { href: 'http://localhost/demo/assets/scenario.worker.js' }, postMessage: vi.fn(), onmessage: null as null | ((event: any) => void) };
    vi.stubGlobal('self', scope);
    await import('./scenario.worker');
    scope.onmessage!({ data: { type: 'prepare', jobId: 1, request: {} } });
    scope.onmessage!({ data: { type: 'cancel', jobId: 2 } });
    expect(state.pending[0].signal.aborted).toBe(false);
    scope.onmessage!({ data: { type: 'cancel', jobId: 1 } });
    expect(state.pending[0].signal.aborted).toBe(true);
    state.pending[0].reject(new Error('cancelled'));
    await flush();
    expect(scope.postMessage).toHaveBeenCalledWith({ type: 'cancelled', jobId: 1 });
  });
});
