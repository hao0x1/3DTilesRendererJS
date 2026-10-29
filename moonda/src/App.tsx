import { lazy, Suspense, useState } from 'react';
import MissionApp from './MissionApp';

const ReferenceExplorer = lazy(() => import('./ReferenceExplorer'));

export default function App() {
  const [reference, setReference] = useState(false);
  return <>
    <div hidden={reference}><MissionApp visible={!reference} onOpenReference={() => setReference(true)} /></div>
    {reference && <Suspense fallback={<div className="boot-screen">Loading the reference explorer…</div>}><ReferenceExplorer onExit={() => setReference(false)} /></Suspense>}
  </>;
}
