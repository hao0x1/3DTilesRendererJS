import { useEffect, useRef, useState } from 'react';
import type { PreparedScenario, ScenarioProgress, ScenarioRequest } from './scenarioData';
import type { ScenarioWorkerResponse } from './scenario.worker';

export interface PreparedJob {
  key: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: PreparedScenario | null;
  progress?: ScenarioProgress;
  error?: string;
}

/** Independent A/B workers keep point edits responsive and never mix request generations. */
export default function usePreparedScenario(request: ScenarioRequest | null) {
  const key = request ? JSON.stringify(request) : '';
  const currentKey = useRef(key);
  currentKey.current = key;
  const worker = useRef<Worker | null>(null);
  const sequence = useRef(0);
  const activeJob = useRef('');
  const activeKey = useRef('');
  const cache = useRef(new Map<string, PreparedScenario>());
  const [attempt, setAttempt] = useState(0);
  const [job, setJob] = useState<PreparedJob>({ key: '', status: 'idle', data: null });

  useEffect(() => {
    const ownWorker = new Worker(new URL('./scenario.worker.ts', import.meta.url), { type: 'module' });
    worker.current = ownWorker;
    ownWorker.onmessage = (event: MessageEvent<ScenarioWorkerResponse>) => {
      const message = event.data;
      if (message.jobId !== activeJob.current || activeKey.current !== currentKey.current) return;
      const requestedKey = activeKey.current;
      if (message.type === 'progress') setJob(previous => previous.key === requestedKey ? { ...previous, progress: message.progress } : previous);
      else if (message.type === 'result') {
        cache.current.set(requestedKey, message.result);
        while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
        setJob({ key: requestedKey, status: 'ready', data: message.result });
      } else if (message.type === 'error') setJob({ key: requestedKey, status: 'error', data: null, error: message.error.message });
    };
    ownWorker.onerror = () => { if (activeKey.current === currentKey.current) setJob({ key: activeKey.current, status: 'error', data: null, error: 'The local science worker stopped. Retry the calculation.' }); };
    return () => { ownWorker.terminate(); if (worker.current === ownWorker) worker.current = null; };
  }, [attempt]);

  useEffect(() => {
    if (!key || !worker.current) { setJob({ key, status: 'idle', data: null }); return; }
    const cached = cache.current.get(key);
    if (cached) { activeJob.current = ''; setJob({ key, status: 'ready', data: cached }); return; }
    const jobId = `${request!.scenarioId ?? 'point'}-${++sequence.current}`;
    activeJob.current = jobId;
    activeKey.current = key;
    setJob({ key, status: 'loading', data: null, progress: { stage: 'data', fraction: 0, message: 'Loading the local NASA science package…' } });
    const ownWorker = worker.current;
    ownWorker.postMessage({ type: 'prepare', jobId, request, manifestUrl: new URL(`${import.meta.env.BASE_URL}scenarios/manifest.json`, document.baseURI).href });
    return () => { ownWorker.postMessage({ type: 'cancel', jobId }); if (activeJob.current === jobId) activeJob.current = ''; };
  }, [key, attempt]);

  // The render immediately after an edit is already pending, before effects run.
  const current = job.key === key ? job : { key, status: key ? 'loading' as const : 'idle' as const, data: null };
  return { ...current, retry: () => { cache.current.delete(key); setAttempt(value => value + 1); } };
}
