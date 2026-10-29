import { useEffect, useState } from 'react';

type CacheState = { status: 'local' | 'installing' | 'ready' | 'error' | 'unavailable'; completed: number; total: number; bytes: number; totalBytes: number };

/** Only the worker for this exact HTML build may declare its assets ready. */
export default function useOfflineStatus() {
  const [state, setState] = useState<CacheState>({ status: import.meta.env.PROD ? ('serviceWorker' in navigator ? 'installing' : 'unavailable') : 'local', completed: 0, total: 0, bytes: 0, totalBytes: 0 });
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    const revision = document.querySelector<HTMLMetaElement>('meta[name="moonda-cache-revision"]')?.content;
    let active = true;
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (!active || !revision || message?.type !== 'MOONDA_OFFLINE_STATUS' || message.revision !== revision) return;
      if (!['installing', 'ready', 'error'].includes(message.status)) return;
      setState({ status: message.status, completed: Number(message.completed) || 0, total: Number(message.total) || 0, bytes: Number(message.bytes) || 0, totalBytes: Number(message.totalBytes) || 0 });
    };
    const requestStatus = () => {
      navigator.serviceWorker.ready.then(registration => {
        if (active) (registration.active ?? navigator.serviceWorker.controller)?.postMessage({ type: 'MOONDA_OFFLINE_STATUS' });
      }).catch(() => { if (active) setState(previous => ({ ...previous, status: 'error' })); });
    };
    const registrationFailed = () => { if (active) setState(previous => ({ ...previous, status: 'error' })); };
    window.addEventListener('moonda-offline-error', registrationFailed);
    navigator.serviceWorker.addEventListener('message', receive);
    navigator.serviceWorker.addEventListener('controllerchange', requestStatus);
    requestStatus();
    return () => {
      active = false;
      window.removeEventListener('moonda-offline-error', registrationFailed);
      navigator.serviceWorker.removeEventListener('message', receive);
      navigator.serviceWorker.removeEventListener('controllerchange', requestStatus);
    };
  }, []);
  const percent = state.total > 0 ? Math.round(state.completed / state.total * 100) : 0;
  const label = state.status === 'local' ? 'LOCAL NASA DATA' : state.status === 'ready' ? 'OFFLINE READY' : state.status === 'error' ? 'OFFLINE INCOMPLETE' : state.status === 'unavailable' ? 'OFFLINE UNAVAILABLE' : state.total > 0 ? `OFFLINE CACHE ${percent}%` : 'PREPARING OFFLINE';
  const detail = state.status === 'ready' ? 'This build and its visual assets are cached in this browser.' : state.status === 'local' ? 'NASA datasets and display assets are served locally.' : state.status === 'error' ? 'Offline installation did not finish. Keep the local server running and reload to retry.' : state.status === 'unavailable' ? 'This browser cannot install an offline copy. Keep the local server running to use the packaged data.' : `Preparing this build for offline use${state.total ? `: ${state.completed} of ${state.total} files` : ''}${state.totalBytes ? `, ${Math.round(state.bytes / 1048576)} of ${Math.round(state.totalBytes / 1048576)} MB` : ''}.`;
  return { ...state, percent, label, detail };
}
