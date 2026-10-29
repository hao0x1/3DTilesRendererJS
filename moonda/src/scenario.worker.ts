import { ScenarioDataError, ScenarioEngine, type PreparedScenario, type ScenarioProgress, type ScenarioRequest } from './scenarioData';

export type ScenarioWorkerRequest =
  | { type: 'prepare'; jobId: string | number; request: ScenarioRequest; manifestUrl?: string }
  | { type: 'cancel'; jobId: string | number };
export type ScenarioWorkerResponse =
  | { type: 'progress'; jobId: string | number; progress: ScenarioProgress }
  | { type: 'result'; jobId: string | number; result: PreparedScenario }
  | { type: 'cancelled'; jobId: string | number }
  | { type: 'error'; jobId: string | number; error: { code: string; message: string } };

const scope = self as unknown as { onmessage: ((event: MessageEvent<ScenarioWorkerRequest>) => void) | null; postMessage: (message: ScenarioWorkerResponse) => void };
const engines = new Map<string, ScenarioEngine>();
let active: { jobId: string | number; controller: AbortController } | undefined;

scope.onmessage = event => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (active?.jobId === message.jobId) active.controller.abort();
    return;
  }
  if (message.type !== 'prepare') return;
  active?.controller.abort();
  const controller = new AbortController(), jobId = message.jobId;
  active = { jobId, controller };
  const url = message.manifestUrl ?? new URL('../scenarios/manifest.json', self.location.href).href;
  let engine = engines.get(url);
  if (!engine) { engine = new ScenarioEngine(url); engines.set(url, engine); }
  void engine.prepare(message.request, {
    signal: controller.signal,
    onProgress: progress => { if (!controller.signal.aborted) scope.postMessage({ type: 'progress', jobId, progress }); },
  }).then(result => {
    if (!controller.signal.aborted && active?.controller === controller) scope.postMessage({ type: 'result', jobId, result });
  }).catch(error => {
    if (controller.signal.aborted || (error instanceof ScenarioDataError && error.code === 'CANCELLED')) scope.postMessage({ type: 'cancelled', jobId });
    else scope.postMessage({ type: 'error', jobId, error: { code: error instanceof ScenarioDataError ? error.code : 'UNKNOWN', message: error instanceof Error ? error.message : 'Scenario preparation failed.' } });
  }).finally(() => { if (active?.controller === controller) active = undefined; });
};
