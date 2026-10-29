import { useEffect, useRef, useState } from 'react';
import type { EnergyModel } from './energy';
import type { PreparedScenario, ScenarioAnalysis, ScenarioDefinition } from './scenarios';
import type { AnalysisResponse } from './analysis.worker';

interface AnalysisJob { key: string; status: 'idle' | 'loading' | 'ready' | 'error'; data: ScenarioAnalysis | null; error?: string }

export default function useScenarioAnalysis(prepared: PreparedScenario | null, geometryKey: string, scenario: ScenarioDefinition, energyModel: EnergyModel) {
  const key = prepared ? `${geometryKey}:${JSON.stringify(scenario)}:${JSON.stringify(energyModel)}` : '';
  const [job, setJob] = useState<AnalysisJob>({ key: '', status: 'idle', data: null });
  const cache = useRef(new Map<string, ScenarioAnalysis>());
  useEffect(() => {
    if (!prepared || !key) { setJob({ key, status: 'idle', data: null }); return; }
    const cached = cache.current.get(key);
    if (cached) { setJob({ key, status: 'ready', data: cached }); return; }
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    setJob({ key, status: 'loading', data: null });
    worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
      const message = event.data;
      if (message.key !== key) return;
      if ('result' in message) {
        cache.current.set(key, message.result);
        while (cache.current.size > 12) cache.current.delete(cache.current.keys().next().value!);
        setJob({ key, status: 'ready', data: message.result });
      } else setJob({ key, status: 'error', data: null, error: message.error });
    };
    worker.onerror = () => setJob({ key, status: 'error', data: null, error: 'The energy calculation stopped. Change an assumption to retry.' });
    worker.postMessage({ key, prepared, scenario, energyModel });
    // A newer edit terminates old quadrature instead of queueing stale answers.
    return () => worker.terminate();
  }, [key, prepared]);
  return job.key === key ? job : { key, status: key ? 'loading' as const : 'idle' as const, data: null };
}
