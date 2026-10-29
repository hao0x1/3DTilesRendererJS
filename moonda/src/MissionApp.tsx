import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, ArrowRight, ArrowUpRight, ArrowsIn, Check, CircleNotch, Compass, Cube, GlobeHemisphereWest as Earth, Info, Moon, Play, Presentation, SidebarSimple, SlidersHorizontal, SquaresFour, Sun, X } from '@phosphor-icons/react';
import Scene from './Scene';
import type { SceneMode, SceneObserverMarker, SceneObserverView, SceneTerrainPick } from './Scene';
import type { ObservatoryData, SkySample } from './types';
import type { ScenarioManifest, ScenarioRequest, PreparedScenario } from './scenarioData';
import { destinationFromOffset } from './scenarioData';
import { componentSamplesAtTime, delayedScenario } from './scenarios';
import type { ScenarioDefinition } from './scenarios';
import { finiteSolarDisc, panelNormalEnu, DEFAULT_REFERENCE_IRRADIANCE_WM2, DEFAULT_SOLAR_DISC_RAYS } from './energy';
import type { EnergyModel, EnergyResult } from './energy';
import { formatDuration, indexForTime } from './science';
import usePreparedScenario from './usePreparedScenario';
import useScenarioAnalysis from './useScenarioAnalysis';
import useOfflineStatus from './components/useOfflineStatus';
import useSceneOverlayLayout from './useSceneOverlayLayout';
import ScenarioWorkspace from './components/ScenarioWorkspace';
import type { ScenarioId, ScenarioPatch, ScenarioView } from './components/ScenarioWorkspace';
import ScenarioComparison from './components/ScenarioComparison';
import EnergyPanel from './components/EnergyPanel';
import ScenarioTimeline from './components/ScenarioTimeline';
import DurationControl from './components/DurationControl';
import NumericControl from './components/NumericControl';
import HorizonPlot from './components/HorizonPlot';
import MethodDialog from './components/MethodDialog';

const HOUR = 3_600_000;
const IDS = ['A', 'B'] as const;
const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const utc = new Intl.DateTimeFormat('en', { timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const angle = (value: number) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)}°`;
const coordinate = (value: number, positive: string, negative: string) => `${Math.abs(value).toFixed(5)}° ${value < 0 ? negative : positive}`;
const asset = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^(?:\.\/|\/)+/, '')}`;

interface LockedCase {
  id: ScenarioId;
  regionId: string;
  eastM: number;
  northM: number;
  startUtc: string;
  panelHeightM: number;
  antennaHeightM: number;
  displaySurfaceHeightM?: number;
}
interface Bootstrap { regions: ObservatoryData; manifest: ScenarioManifest; dates: { min: string; max: string } }

const initialCase = (id: ScenarioId): LockedCase => ({ id, regionId: 'connecting-ridge', eastM: 0, northM: 0, startUtc: id === 'A' ? '2026-11-04T00:00:00.000Z' : '2026-11-07T00:00:00.000Z', panelHeightM: 2, antennaHeightM: 2 });
const initialEnergy: EnergyModel = { panel: { areaM2: 2, efficiency: .28, deratingFactor: .75, mode: 'sun-tracking', tiltDeg: 80, azimuthDeg: 0 }, battery: { capacityWh: 2000, initialChargeWh: 1600, reserveWh: 400, chargeEfficiency: .95, dischargeEfficiency: .95 }, loadW: 80, referenceIrradianceWm2: DEFAULT_REFERENCE_IRRADIANCE_WM2 };

function pointId(value: LockedCase) { return `${value.regionId}:E${value.eastM}:N${value.northM}`; }
function requestFor(value: LockedCase, durationHours: number): ScenarioRequest {
  return { scenarioId: value.id, pointId: pointId(value), point: { regionId: value.regionId, eastM: value.eastM, northM: value.northM, panelHeightM: value.panelHeightM, antennaHeightM: value.antennaHeightM }, startUtc: value.startUtc, endUtc: new Date(Date.parse(value.startUtc) + durationHours * HOUR).toISOString(), cadenceMinutes: 5, azimuthStepDeg: .25 };
}

function interpolate(values: number[], index: number) {
  const lower = Math.max(0, Math.min(values.length - 1, Math.floor(index)));
  const upper = Math.min(values.length - 1, lower + 1);
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function sceneViews(prepared: PreparedScenario, timeMs: number, terrainEnabled: boolean): { panel: SceneObserverView; antenna: SceneObserverView } {
  const samples = componentSamplesAtTime(prepared, timeMs, terrainEnabled);
  const view = (receiver: 'panel' | 'antenna'): SceneObserverView => {
    const site = receiver === 'panel' ? prepared.panelSite : prepared.antennaSite;
    const index = indexForTime(site.ephemeris.timesUtc.map(Date.parse), timeMs);
    const sunRadius = interpolate(site.ephemeris.sunAngularRadiusDeg, index);
    const earthRadius = interpolate(site.ephemeris.earthAngularRadiusDeg, index);
    const sample = samples[receiver];
    const eclipse = finiteSolarDisc({ sunAzDeg: sample.sunAz, sunElDeg: sample.sunEl, sunAngularRadiusDeg: sunRadius, earthAzDeg: sample.earthAz, earthElDeg: sample.earthEl, earthAngularRadiusDeg: earthRadius, horizonAtAzimuth: () => -90, panel: { mode: 'sun-tracking', tiltDeg: 0, azimuthDeg: 0 }, rayCount: DEFAULT_SOLAR_DISC_RAYS });
    return { latitudeDeg: prepared.latitudeDeg, longitudeDeg: prepared.longitudeDeg, groundHeightM: prepared.surfaceElevationM, heightM: site.observerHeightM, horizon: site.horizon, sample, sunAngularRadiusDeg: sunRadius, earthAngularRadiusDeg: earthRadius, earthBlockedSolarFraction: eclipse.earthBlockedFraction };
  };
  return { panel: view('panel'), antenna: view('antenna') };
}

function batterySample(result: EnergyResult | null | undefined, timeMs: number) {
  if (!result?.series.length) return null;
  let low = 0, high = result.series.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (Date.parse(result.series[middle].timeUtc) <= timeMs) low = middle; else high = middle - 1; }
  const interval = result.intervals.find(item => Date.parse(item.startUtc) <= timeMs && timeMs < Date.parse(item.endUtc)) ?? result.intervals[result.intervals.length - 1];
  return { ...result.series[low], generationW: interval?.generationW ?? 0 };
}

function SkyReadings({ sample, panelHeightM, antennaHeightM, terrain }: { sample: SkySample; panelHeightM: number; antennaHeightM: number; terrain: boolean }) {
  return <div className="sky-readings" aria-label="Sky geometry at the panel and antenna">
    <span className="eyebrow">AT THIS MISSION TIME</span>
    <div className="sky-reading sun-reading"><Sun size={21} /><div><span>Sun · panel at {fmt.format(panelHeightM)} m</span><strong>{angle(sample.sunEl)}</strong><small>{sample.sunVisible ? 'Above' : 'Below'} {terrain ? 'terrain horizon' : '0° reference'}</small></div><span className={`visibility-dot ${sample.sunVisible ? 'visible' : ''}`} /></div>
    <div className="sky-reading earth-reading"><Earth size={21} /><div><span>Earth · antenna at {fmt.format(antennaHeightM)} m</span><strong>{angle(sample.earthEl)}</strong><small>{sample.earthVisible ? 'Above' : 'Below'} {terrain ? 'terrain horizon' : '0° reference'}</small></div><span className={`visibility-dot ${sample.earthVisible ? 'visible' : ''}`} /></div>
  </div>;
}

export default function MissionApp({ visible, onOpenReference }: { visible: boolean; onOpenReference: () => void }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState('');
  const [bootAttempt, setBootAttempt] = useState(0);
  const [cases, setCases] = useState<Record<ScenarioId, LockedCase>>({ A: initialCase('A'), B: initialCase('B') });
  const [activeId, setActiveId] = useState<ScenarioId>('A');
  const [resultView, setResultView] = useState<'energy' | 'visibility'>('energy');
  const [durationHours, setDurationHours] = useState(48);
  const [maxDarkHours, setMaxDarkHours] = useState(24);
  const [maxEarthGapHours, setMaxEarthGapHours] = useState(12);
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const [energyModel, setEnergyModel] = useState<EnergyModel>(initialEnergy);
  const [elapsedHours, setElapsedHours] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<SceneMode>('globe');
  const [observerView, setObserverView] = useState<'panel' | 'antenna'>('panel');
  const [missionOpen, setMissionOpen] = useState(() => window.innerWidth >= 1000);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [presentation, setPresentation] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [pickingId, setPickingId] = useState<ScenarioId | null>(null);
  const [candidate, setCandidate] = useState<SceneTerrainPick | null>(null);
  const [tourStep, setTourStep] = useState(-1);
  const viewerRef = useRef<HTMLElement>(null);
  useSceneOverlayLayout(viewerRef, Boolean(boot) && visible);
  useEffect(() => {
    const narrow = window.matchMedia('(min-width: 761px) and (max-width: 1299px)');
    const fit = () => { if (narrow.matches && missionOpen && resultsOpen) setMissionOpen(false); };
    fit();
    narrow.addEventListener('change', fit);
    return () => narrow.removeEventListener('change', fit);
  }, [missionOpen, resultsOpen]);
  const panelMemory = useRef({ mission: true, results: false, compare: false });
  const offline = useOfflineStatus();

  useEffect(() => {
    const controller = new AbortController();
    const json = async (path: string) => { const response = await fetch(asset(path), { signal: controller.signal }); if (!response.ok) throw new Error(`Local NASA metadata could not be loaded (${response.status}).`); return response.json(); };
    setBootError('');
    void Promise.all([json('data/observatory.json'), json('scenarios/manifest.json')]).then(async ([regions, manifest]: [ObservatoryData, ScenarioManifest]) => {
      const ephemeris = await json(manifest.ephemerisManifestUrl!);
      if (!regions.sites.length || regions.sites.some(site => !manifest.regions[site.id])) throw new Error('The scientific regions do not match the visual terrain.');
      if (manifest.frame !== 'MOON_ME_DE421' || !ephemeris.startUtc || !ephemeris.endUtc) throw new Error('The pinned NASA lunar frame or date coverage is missing.');
      setBoot({ regions, manifest, dates: { min: ephemeris.startUtc, max: ephemeris.endUtc } });
    }).catch(error => { if (error.name !== 'AbortError') setBootError(error.message); });
    return () => controller.abort();
  }, [bootAttempt]);

  const requests = useMemo(() => ({ A: boot ? requestFor(cases.A, durationHours) : null, B: boot ? requestFor(cases.B, durationHours) : null }), [boot, cases, durationHours]);
  const prepA = usePreparedScenario(requests.A), prepB = usePreparedScenario(requests.B);
  const definitions = useMemo(() => Object.fromEntries(IDS.map(id => [id, { id, regionId: cases[id].regionId, pointId: pointId(cases[id]), startUtc: cases[id].startUtc, durationHours, panelHeightM: cases[id].panelHeightM, antennaHeightM: cases[id].antennaHeightM, maxDarkHours, maxEarthGapHours, terrainEnabled }])) as Record<ScenarioId, ScenarioDefinition>, [cases, durationHours, maxDarkHours, maxEarthGapHours, terrainEnabled]);
  const analysisA = useScenarioAnalysis(prepA.status === 'ready' ? prepA.data : null, prepA.key, definitions.A, energyModel);
  const analysisB = useScenarioAnalysis(prepB.status === 'ready' ? prepB.data : null, prepB.key, definitions.B, energyModel);
  const preparedJobs = { A: prepA, B: prepB };
  const analysisJobs = { A: analysisA, B: analysisB };
  const activeCase = cases[activeId];
  const activePrep = preparedJobs[activeId];
  const activePrepared = activePrep.status === 'ready' ? activePrep.data : null;
  const activeAnalysisJob = analysisJobs[activeId];
  const activeAnalysis = activeAnalysisJob.status === 'ready' ? activeAnalysisJob.data : null;
  const currentTimeMs = Date.parse(activeCase.startUtc) + elapsedHours * HOUR;
  const preparedA = prepA.status === 'ready' ? prepA.data : null, preparedB = prepB.status === 'ready' ? prepB.data : null;
  const currentA = useMemo(() => preparedA ? sceneViews(preparedA, Date.parse(cases.A.startUtc) + elapsedHours * HOUR, terrainEnabled) : null, [preparedA, cases.A.startUtc, elapsedHours, terrainEnabled]);
  const currentB = useMemo(() => preparedB ? sceneViews(preparedB, Date.parse(cases.B.startUtc) + elapsedHours * HOUR, terrainEnabled) : null, [preparedB, cases.B.startUtc, elapsedHours, terrainEnabled]);
  const currentViews = activeId === 'A' ? currentA : currentB;
  const combinedSky = currentViews ? { ...currentViews.panel.sample, earthAz: currentViews.antenna.sample.earthAz, earthEl: currentViews.antenna.sample.earthEl, earthHorizon: currentViews.antenna.sample.earthHorizon, earthVisible: currentViews.antenna.sample.earthVisible } : null;
  const currentEnergy = batterySample(activeAnalysis?.energy, currentTimeMs);

  useEffect(() => {
    if (!playing || !visible) return;
    const timer = window.setInterval(() => setElapsedHours(value => { const next = Math.min(durationHours, value + .25); if (next >= durationHours) setPlaying(false); return next; }), 160);
    return () => window.clearInterval(timer);
  }, [playing, visible, durationHours]);
  useEffect(() => { if (!visible) setPlaying(false); }, [visible]);

  const activate = (id: ScenarioId) => { setActiveId(id); setPickingId(null); setCandidate(null); setPlaying(false); };
  const changeCase = (id: ScenarioId, patch: ScenarioPatch) => {
    setPlaying(false);
    setCases(previous => ({ ...previous, [id]: { ...previous[id], ...(patch.siteId ? { regionId: patch.siteId, eastM: 0, northM: 0, displaySurfaceHeightM: undefined } : {}), ...(patch.startUtc !== undefined ? { startUtc: patch.startUtc } : {}), ...(patch.panelHeightM !== undefined ? { panelHeightM: patch.panelHeightM } : {}), ...(patch.antennaHeightM !== undefined ? { antennaHeightM: patch.antennaHeightM } : {}) } }));
  };
  const copyAtoB = (delay: number) => {
    const clone = delayedScenario(definitions.A, delay, 'B');
    setCases(previous => ({ ...previous, B: { ...previous.A, id: 'B', startUtc: clone.startUtc } }));
    setActiveId('B'); setPickingId(null); setCandidate(null); setElapsedHours(0); setPlaying(false);
  };
  const beginPick = (id: ScenarioId) => { setTourStep(-1); setActiveId(id); setPickingId(id); setCandidate(null); setMode('terrain'); setMissionOpen(false); setResultsOpen(false); setCompareOpen(false); setPlaying(false); };
  const cancelPick = () => { setPickingId(null); setCandidate(null); };
  const lockCandidate = () => {
    if (!candidate?.supported || !pickingId || candidate.regionId !== cases[pickingId].regionId) return;
    const id = pickingId;
    setCases(previous => ({ ...previous, [id]: { ...previous[id], regionId: candidate.regionId, eastM: candidate.arcEastM, northM: candidate.arcNorthM, displaySurfaceHeightM: candidate.displayGroundHeightM } }));
    setActiveId(id); cancelPick(); setResultsOpen(true); setCompareOpen(false); setMissionOpen(false);
  };
  const toggleMission = () => { setMissionOpen(value => !value); if (!missionOpen && window.innerWidth < 1300) setResultsOpen(false); setCompareOpen(false); };
  const toggleResults = () => { setResultsOpen(value => !value || compareOpen); if ((!resultsOpen || compareOpen) && window.innerWidth < 1300) setMissionOpen(false); setCompareOpen(false); };
  const toggleCompare = () => { if (compareOpen) { setCompareOpen(false); setResultsOpen(false); } else { setCompareOpen(true); setResultsOpen(true); setMissionOpen(false); cancelPick(); } };
  const togglePresentation = () => {
    setTourStep(-1);
    if (presentation) { setMissionOpen(panelMemory.current.mission); setResultsOpen(panelMemory.current.results); setCompareOpen(panelMemory.current.compare); setPresentation(false); }
    else { panelMemory.current = { mission: missionOpen, results: resultsOpen, compare: compareOpen }; setMissionOpen(false); setResultsOpen(false); setCompareOpen(false); cancelPick(); setTourStep(-1); setPresentation(true); }
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !sourcesOpen) { if (pickingId) cancelPick(); else if (presentation) { setMissionOpen(panelMemory.current.mission); setResultsOpen(panelMemory.current.results); setCompareOpen(panelMemory.current.compare); setPresentation(false); } } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [presentation, sourcesOpen, pickingId]);

  if (!boot) return <div className="boot-screen"><div className="brand"><Moon size={25} weight="fill" /><strong>MOONDA</strong></div><span className="eyebrow">MISSION SCENARIOS</span><h1>{bootError ? 'The local data is unavailable.' : 'Preparing your lunar mission.'}</h1><p>{bootError || 'Loading the NASA terrain and SPICE data catalogue.'}</p>{bootError ? <button className="primary-button" onClick={() => setBootAttempt(value => value + 1)}><ArrowClockwise size={16} />Try again</button> : <CircleNotch size={20} className="loading-spinner" />}</div>;

  const baseSite = boot.regions.sites.find(site => site.id === activeCase.regionId)!;
  const region = boot.manifest.regions[activeCase.regionId];
  const fullDomain = region.supportedDomain.bounds;
  const heightRange = boot.manifest.horizonSampling?.observerHeightRangeM ?? { min: 0, max: 100 };
  const scenarioViews: ScenarioView[] = IDS.map(id => {
    const value = cases[id], preparedJob = preparedJobs[id], analyzedJob = analysisJobs[id];
    const origin = boot.manifest.regions[value.regionId].origin;
    const location = preparedJob.data ?? destinationFromOffset(origin.latitudeDeg, origin.longitudeDeg, value.eastM, value.northM);
    const error = preparedJob.error || analyzedJob.error || analyzedJob.data?.message;
    const status = preparedJob.status === 'error' || analyzedJob.status === 'error' || (analyzedJob.data && analyzedJob.data.status !== 'complete') ? 'error' : preparedJob.status === 'ready' && analyzedJob.status === 'ready' ? 'ready' : 'loading';
    return { id, siteId: value.regionId, siteName: boot.manifest.regions[value.regionId].name, point: { latitudeDeg: location.latitudeDeg, longitudeDeg: location.longitudeDeg, eastM: value.eastM, northM: value.northM }, startUtc: value.startUtc, antennaHeightM: value.antennaHeightM, panelHeightM: value.panelHeightM, horizon: { status, detail: error ?? (preparedJob.status === 'ready' && analyzedJob.status !== 'ready' ? 'Integrating partial sunlight and battery energy…' : preparedJob.progress?.message), progress: preparedJob.progress?.fraction, coverageLabel: 'Native 5 m / 80 m NASA DEM · 0.25° horizons to 200 km' } };
  });
  const activeView = scenarioViews.find(item => item.id === activeId)!;
  const markers: SceneObserverMarker[] = IDS.map(id => {
    const value = cases[id], prepared = preparedJobs[id].status === 'ready' ? preparedJobs[id].data : null;
    const view = id === 'A' ? currentA : currentB;
    const point = scenarioViews.find(item => item.id === id)!.point;
    return { id, regionId: value.regionId, latitudeDeg: point.latitudeDeg, longitudeDeg: point.longitudeDeg, groundHeightM: prepared?.surfaceElevationM ?? value.displaySurfaceHeightM ?? boot.manifest.regions[value.regionId].origin.surfaceHeightM ?? 0, antennaHeightM: value.antennaHeightM, panelHeightM: value.panelHeightM, panelAreaM2: energyModel.panel.areaM2, panelNormalEnu: view ? panelNormalEnu(energyModel.panel, view.panel.sample.sunAz, view.panel.sample.sunEl) : undefined };
  });
  const delayAllowed = Date.parse(cases.A.startUtc) + (72 + durationHours) * HOUR <= Date.parse(boot.dates.max);
  const readyAnalysis = activeAnalysis?.status === 'complete' ? activeAnalysis : null;
  const horizonSite = activePrepared ? observerView === 'panel' ? activePrepared.panelSite : activePrepared.antennaSite : null;
  const horizonSample = currentViews?.[observerView].sample;
  const energyPending = activePrep.status === 'loading' || activePrep.status === 'idle' || activeAnalysisJob.status === 'loading';
  const currentUtc = new Date(currentTimeMs).toISOString();
  const presentationSky = mode === 'surface' ? horizonSample : combinedSky;
  const presentationSunLabel = mode === 'surface' ? `Sun · ${observerView}` : 'Sun · panel';
  const presentationEarthLabel = mode === 'surface' ? `Earth · ${observerView}` : 'Earth · antenna';
  const tour = [
    { title: 'One mission. Two alternatives.', text: 'Set A’s arrival and shared mission requirements. Both scenarios use the same panel, battery and load assumptions.' },
    { title: 'Pick a point, then lock it.', text: 'Explore the real terrain, select a nearby point and confirm it. The 10 m selection grid matches the detailed display; science re-samples the native NASA DEM.' },
    { title: 'Change only the arrival.', text: 'Copy A to B and arrive exactly 72 hours later. Compare horizon access, battery reserve and unmet load with the same point and equipment.' },
    { title: 'Follow the energy.', text: 'Scrub elapsed mission time. Each scenario keeps its own UTC date, sky geometry and energy trace. Select A or B to show that mission in 3D.' },
  ];
  const nextTour = () => { const next = tourStep + 1; if (next >= tour.length) setTourStep(-1); else { setTourStep(next); if (next === 1) { setMode('terrain'); setMissionOpen(false); } if (next === 2) { setCompareOpen(true); setResultsOpen(true); setMissionOpen(false); } if (next === 3) { setCompareOpen(false); setResultsOpen(true); setResultView('energy'); } } };

  return <div className={`observatory-app mission-scenarios-app ${mode === 'surface' ? 'surface-mode' : ''} ${presentation ? 'presentation-mode' : ''} ${missionOpen ? 'mission-open' : ''} ${resultsOpen ? 'results-open' : ''} ${compareOpen ? 'comparison-open' : ''}`}>
    <header className="app-header"><a className="brand" href="#" aria-label="MOONDA mission scenarios" onClick={event => { event.preventDefault(); setMode('globe'); }}><span className="brand-symbol"><Moon size={24} weight="fill" /></span><span className="brand-words"><strong>MOONDA</strong><small>LUNAR OBSERVATORY</small></span></a><nav className="mode-navigation" aria-label="Scene mode">{([['globe', 'Explore', Earth], ['terrain', 'Terrain', Cube], ['surface', 'Horizon', Compass]] as const).map(([value, label, Icon]) => <button key={value} onClick={() => setMode(value)} aria-pressed={mode === value}><Icon size={16} /><span>{label}</span></button>)}</nav><div className="header-actions"><button className={`header-link ${compareOpen ? 'active' : ''}`} onClick={toggleCompare} aria-label="Compare scenarios" aria-pressed={compareOpen}><SquaresFour size={16} /><span>Compare</span></button><button className="header-link" onClick={() => setSourcesOpen(true)} aria-label="Data and assumptions"><Info size={16} /><span>Sources</span></button><button className="icon-button tour-button" aria-label="Run guided mission tour" onClick={() => { setTourStep(0); setMode('globe'); setPresentation(false); setMissionOpen(true); setResultsOpen(false); setCompareOpen(false); cancelPick(); }}><Play size={16} /></button><button className="presentation-button" aria-label={presentation ? 'Exit presentation mode' : 'Enter presentation mode'} aria-pressed={presentation} onClick={togglePresentation}>{presentation ? <ArrowsIn size={17} /> : <Presentation size={17} />}<span>{presentation ? 'Exit presentation' : 'Present'}</span></button></div></header>
    <div className="workspace-toolbar"><button className={`panel-toggle ${missionOpen ? 'active' : ''}`} onClick={toggleMission} aria-expanded={missionOpen}><SidebarSimple size={16} />Mission</button><div className="mission-scenario-switch" aria-label="Scenario shown in the 3D view">{IDS.map(id => <button key={id} onClick={() => activate(id)} aria-pressed={id === activeId}><span className={`scenario-letter scenario-letter--${id.toLowerCase()}`}>{id}</span><span>{utc.format(Date.parse(cases[id].startUtc) + elapsedHours * HOUR)} UTC</span></button>)}<button className="quick-delay" aria-label="Set B to A plus 72 hours" title="Copy A’s point and heights to B, arriving exactly 72 hours later" disabled={!delayAllowed} onClick={() => copyAtoB(72)}>B = A +72h<ArrowRight size={13} /></button></div><button className={`panel-toggle ${resultsOpen ? 'active' : ''}`} onClick={toggleResults} aria-expanded={resultsOpen}><SlidersHorizontal size={16} />Results</button></div>
    <main className="workspace">
      {missionOpen && <aside className="mission-panel" aria-label="Mission scenario setup"><div className="panel-heading"><div><span className="eyebrow">MISSION DESIGN</span><h2>Two ways to arrive</h2></div><button className="icon-button" aria-label="Collapse mission setup" onClick={toggleMission}><X size={18} /></button></div>
        <details className="scenario-duration"><summary><span>Shared mission duration</span><strong>{durationHours} h</strong><ArrowRight size={13} /></summary><div className="mission-fields"><DurationControl value={durationHours} max={336} onChange={value => { setDurationHours(value); setElapsedHours(hours => Math.min(value, hours)); setPlaying(false); }} /></div></details>
        <ScenarioWorkspace scenarios={scenarioViews} activeScenarioId={activeId} sites={boot.regions.sites.map(site => ({ id: site.id, name: site.name }))} dateRange={boot.dates} heightRange={{ ...heightRange, step: .5 }} onActivate={activate} onChange={changeCase} onPickPoint={beginPick} onCopyAtoB={() => copyAtoB(0)} onDelayB72h={() => copyAtoB(72)} delayAllowed={delayAllowed} delayUnavailableReason="The delayed mission would extend beyond the prepared SPICE period. Choose an earlier A arrival or a shorter mission." pointPickingId={pickingId} onCancelPick={cancelPick} />
        <details className="scenario-criteria"><summary>Visibility criteria<span>Terrain and communication gaps</span></summary><div className="scenario-shared-limits"><NumericControl label="Maximum terrain obstruction" unit="h" value={maxDarkHours} min={0} max={336} step={1} onChange={setMaxDarkHours} description="Sun-centre horizon clearance; eclipses affect energy separately." /><NumericControl label="Maximum Earth gap" unit="h" value={maxEarthGapHours} min={0} max={336} step={1} onChange={setMaxEarthGapHours} /></div><label className="terrain-toggle"><input type="checkbox" checked={terrainEnabled} onChange={event => setTerrainEnabled(event.target.checked)} /><span className="toggle-track" /><span>Use terrain horizons<small>{terrainEnabled ? 'Separate panel and antenna profiles' : 'Flat 0° comparison baseline'}</small></span></label></details>
        <button className="method-link" onClick={() => setSourcesOpen(true)}><Info size={15} />Data, method & assumptions<ArrowUpRight size={13} /></button>
      </aside>}
      <section ref={viewerRef} className={`viewer viewer--${mode} ${tourStep >= 0 ? 'tour-active' : ''} ${pickingId ? 'is-picking' : ''}`} aria-label="Interactive lunar scene">
        <div className="scene-container">{visible && <Scene sites={boot.regions.sites} selectedSite={baseSite} integratedControls guidanceText={mode === 'globe' ? 'Drag to orbit · scroll to approach' : mode === 'terrain' ? pickingId ? 'Click a nearby point · review the preview · lock the point' : 'Drag to orbit · right-drag to pan · scroll to move' : 'Drag to look · arrow keys rotate · scroll to zoom view'} timeIndex={0} terrainEnabled={terrainEnabled} mode={mode} onSelectSite={id => { changeCase(activeId, { siteId: id }); cancelPick(); }} onModeChange={setMode} analysisObservers={currentViews ?? undefined} analysisStatus={activePrep.status === 'ready' ? 'ready' : activePrep.status === 'error' ? 'error' : 'loading'} observerView={observerView} onObserverViewChange={setObserverView} observers={markers} activeObserverId={activeId} onActivateObserver={activate} pickingEnabled={Boolean(pickingId)} pickingDomain={fullDomain} candidate={candidate} onTerrainPick={pick => { if (pickingId && pick.regionId === cases[pickingId].regionId) setCandidate(pick); }} onLockCandidate={lockCandidate} onCancelCandidate={cancelPick} />}</div><div className="scene-vignette" />
        <div className="scene-header" data-scene-hud><div className="viewer-title"><div className="eyebrow"><span className={`scenario-letter scenario-letter--${activeId.toLowerCase()}`}>{activeId}</span>{mode === 'surface' ? `${observerView.toUpperCase()} VIEWPOINT` : mode === 'terrain' ? 'TERRAIN EXPLORATION' : 'LUNAR SOUTH POLE'}</div><h1>{baseSite.name}</h1><span className="viewer-coordinates">{coordinate(activeView.point.latitudeDeg, 'N', 'S')}<span className="coordinate-divider">/</span>{coordinate(activeView.point.longitudeDeg, 'E', 'W')}</span><span className="mode-context">{utc.format(currentTimeMs)} UTC · {mode === 'surface' ? `${observerView === 'panel' ? 'Panel' : 'Antenna'} at ${fmt.format(activeCase[observerView === 'panel' ? 'panelHeightM' : 'antennaHeightM'])} m` : 'Free camera · fixed analysis point'}</span></div>

        {presentation && <div className="presentation-readings">{presentationSky ? <><div className="sun-reading"><Sun size={22} /><span>{presentationSunLabel}<strong>{angle(presentationSky.sunEl)}</strong><small>{presentationSky.sunVisible ? 'Above horizon' : 'Below horizon'}</small></span></div><div className="earth-reading"><Earth size={22} /><span>{presentationEarthLabel}<strong>{angle(presentationSky.earthEl)}</strong><small>{presentationSky.earthVisible ? 'Above horizon' : 'Below horizon'}</small></span></div>{currentEnergy && <div className="presentation-energy"><span>Interval power<strong>{fmt.format(currentEnergy.generationW)} W</strong><small>Battery sample {fmt.format(currentEnergy.batteryWh)} Wh</small></span></div>}</> : <span>Preparing scenario {activeId}…</span>}</div>}
        </div>
        {tourStep >= 0 && <div className="guide-card"><button className="guide-close icon-button" aria-label="Close guided tour" onClick={() => setTourStep(-1)}><X size={16} /></button><span className="eyebrow">{String(tourStep + 1).padStart(2, '0')} / MISSION STORY</span><h3>{tour[tourStep].title}</h3><p>{tour[tourStep].text}</p><div className="guide-controls"><span>{tourStep + 1} of {tour.length}</span><button className="text-button" onClick={nextTour}>{tourStep === tour.length - 1 ? 'Finish tour' : 'Continue'}<ArrowRight size={14} /></button></div></div>}
      </section>
      {resultsOpen && <aside className={`results-panel ${compareOpen ? 'mission-comparison-panel' : ''}`} aria-label={compareOpen ? 'Scenario comparison workspace' : 'Scenario results and energy'}><div className="panel-heading"><div><span className="eyebrow">{compareOpen ? 'A / B COMPARISON' : `SCENARIO ${activeId}`}</span><h2>{compareOpen ? 'What changes the mission?' : 'Mission results'}</h2></div>{compareOpen && <button className="text-button comparison-power-link" onClick={() => { setCompareOpen(false); setResultView('energy'); }}><Sun size={14} />Power chart</button>}<button className="icon-button" aria-label="Collapse results" onClick={() => { setResultsOpen(false); setCompareOpen(false); }}><X size={18} /></button></div>
        {!compareOpen && <div className="result-view-switch" role="group" aria-label="Mission result view"><button aria-pressed={resultView === 'energy'} onClick={() => setResultView('energy')}><Sun size={14} />Power & battery</button><button aria-pressed={resultView === 'visibility'} onClick={() => setResultView('visibility')}><Earth size={14} />Visibility</button></div>}
        {compareOpen ? <ScenarioComparison compact scenarios={scenarioViews.map(view => ({ ...view, visibility: analysisJobs[view.id].data?.visibility ?? null, energy: analysisJobs[view.id].data?.energy ?? null }))} activeScenarioId={activeId} missionDurationHours={durationHours} maxDarkHours={maxDarkHours} maxEarthGapHours={maxEarthGapHours} sharedEnergyModel terrainEnabled={terrainEnabled} onActivate={activate} /> : resultView === 'visibility' ? <>
          {combinedSky ? <SkyReadings sample={combinedSky} panelHeightM={activeCase.panelHeightM} antennaHeightM={activeCase.antennaHeightM} terrain={terrainEnabled} /> : <div className="scenario-calculation-state" role="status"><CircleNotch size={20} className="loading-spinner" /><strong>{activePrep.status === 'error' ? 'The point could not be calculated.' : `Preparing scenario ${activeId}`}</strong><p>{activePrep.error ?? activePrep.progress?.message ?? 'Waiting for native NASA data and height-specific horizons.'}</p></div>}
          {readyAnalysis?.visibility && <section className="mission-summary" aria-label={`Scenario ${activeId} visibility results`}><div className="summary-title"><span className="eyebrow">HORIZON ACCESS</span><span className={`fit-label ${readyAnalysis.visibility.fits ? 'fits' : 'exceeds'}`}>{readyAnalysis.visibility.fits ? 'Within gap limits' : 'Review the gaps'}</span></div><div className="coverage-row"><div><span className="coverage-value solar">{fmt.format(readyAnalysis.visibility.solarPercent)}<small>%</small></span><span>Sun above horizon</span></div><div><span className="coverage-value earth">{fmt.format(readyAnalysis.visibility.earthPercent)}<small>%</small></span><span>Earth visibility</span></div></div><div className="gap-row"><span>Longest terrain obstruction</span><strong>{formatDuration(readyAnalysis.visibility.longestDarkHours)}</strong><span>{readyAnalysis.visibility.longestDarkHours <= maxDarkHours ? <Check size={13} /> : '−'}</span></div><div className="gap-row"><span>Longest Earth gap</span><strong>{formatDuration(readyAnalysis.visibility.longestEarthGapHours)}</strong><span>{readyAnalysis.visibility.longestEarthGapHours <= maxEarthGapHours ? <Check size={13} /> : '−'}</span></div><p className="horizon-only-note">Sun-centre horizon access excludes Earth eclipses. The energy model below includes partial sunlight and Earth occultation.</p><button className="text-button compare-link" onClick={toggleCompare}>Compare A and B<ArrowRight size={15} /></button></section>}
        </> : null}
        {scenarioViews.some(view => view.horizon.status === 'error') && <div className="scenario-job-errors">{scenarioViews.filter(view => view.horizon.status === 'error').map(view => <p key={view.id}>Scenario {view.id}: {view.horizon.detail}<button type="button" onClick={preparedJobs[view.id].retry}>Retry {view.id}</button></p>)}</div>}
        {(compareOpen || resultView === 'energy') && <EnergyPanel scenarioId={activeId} model={energyModel} result={readyAnalysis?.energy ?? null} pending={energyPending} unavailableReason={activeAnalysis?.message ?? activePrep.error} currentTimeUtc={currentUtc} onChange={setEnergyModel} onSelectTime={time => { setElapsedHours(Math.max(0, Math.min(durationHours, (Date.parse(time) - Date.parse(activeCase.startUtc)) / HOUR))); setPlaying(false); }} sharedAcrossScenarios />}
      </aside>}
    </main>
    {tourStep < 0 && mode === 'surface' && horizonSite && horizonSample && !compareOpen && <HorizonPlot site={{ ...horizonSite, name: `${activeId} · ${baseSite.name} · ${observerView} at ${horizonSite.observerHeightM} m` }} sample={horizonSample} terrainEnabled={terrainEnabled} />}
    <ScenarioTimeline scenarios={scenarioViews.map(view => { const analyzed = analysisJobs[view.id].data; return { id: view.id, label: view.siteName, startUtc: view.startUtc, status: view.horizon.status, sunIntervals: analyzed?.visibilitySegments.map(segment => ({ startUtc: segment.startUtc, endUtc: segment.endUtc, visible: segment.sunVisible })) ?? [], earthIntervals: analyzed?.visibilitySegments.map(segment => ({ startUtc: segment.startUtc, endUtc: segment.endUtc, visible: segment.earthVisible })) ?? [], coverageEndUtc: analyzed?.endUtc }; })} durationHours={durationHours} elapsedHours={elapsedHours} onElapsedHoursChange={value => { setElapsedHours(value); setPlaying(false); }} playing={playing} onPlayingChange={setPlaying} activeScenarioId={activeId} onActivate={activate} />
    <footer className="app-footer"><span>MOONDA · NASA Space Apps 2026</span><span className={`dataset-state cache-status--${offline.status}`} role="status" title={offline.detail}><span />{offline.label}</span><span className="footer-method">NASA terrain · SPICE geometry · assumption-based energy</span><button onClick={() => setSourcesOpen(true)}>Data & assumptions<ArrowUpRight size={12} /></button></footer>
    <MethodDialog open={sourcesOpen} onClose={() => setSourcesOpen(false)}><p className="dialog-intro">Each locked point is sampled from native NASA lunar elevation data. Sun and Earth geometry is calculated at that point and each receiver height using a pinned SPICE state cache.</p><div className="source-method"><span className="eyebrow">CURRENT SCENARIO {activeId}</span><dl><div><dt>Frame and datum</dt><dd>MOON_ME_DE421 · radial heights above a 1,737,400 m sphere</dd></div><div><dt>Date coverage</dt><dd>{boot.dates.min.slice(0, 10)} through {boot.dates.max.slice(0, 10)} UTC</dd></div><div><dt>Terrain</dt><dd>Native 5 m regional / 80 m far-field DEM; 0.25° bearings to 200 km</dd></div><div><dt>Receiver heights</dt><dd>Panel {activeCase.panelHeightM} m · antenna {activeCase.antennaHeightM} m above sampled ground</dd></div><div><dt>Energy assumptions</dt><dd>Shared by A and B; editable panel, battery, efficiencies and load</dd></div></dl></div>
      <h3 className="source-section-title">Sources and validation</h3><ul className="source-list">{(activePrepared?.provenance ?? baseSite.provenance).map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}<ArrowUpRight size={14} /></a><p>{source.detail}</p></li>)}<li><a href={asset('scenarios/manifest.json')} target="_blank" rel="noreferrer">Terrain package manifest and source hashes<ArrowUpRight size={14} /></a></li><li><a href={asset('scenarios/ephemeris/manifest.json')} target="_blank" rel="noreferrer">SPICE kernels, cache coverage and withheld validation<ArrowUpRight size={14} /></a></li><li><a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">NASA CGI Moon Kit · imagery and global relief<ArrowUpRight size={14} /></a><p>NASA SVS / Ernie Wright / LRO-LROC and LOLA.</p></li><li><a href="https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/" target="_blank" rel="noreferrer">NASA Blue Marble Next Generation · Earth imagery<ArrowUpRight size={14} /></a></li><li><a href="https://github.com/NASA-AMMOS/3DTilesRendererJS" target="_blank" rel="noreferrer">NASA-AMMOS 3D Tiles Renderer · Apache 2.0<ArrowUpRight size={14} /></a><p>IBM Plex Sans and Mono are bundled under the <a href={asset('visuals/fonts/OFL-IBM-Plex.txt')} target="_blank" rel="noreferrer">SIL Open Font License</a>. MOONDA is an independent team project.</p></li></ul>
      <h3 className="source-section-title">What the estimates mean</h3><ul className="limitations-list">{(Array.isArray(boot.manifest.limitations) ? boot.manifest.limitations as string[] : []).map((text, index) => <li key={index}>{text}</li>)}<li>Sun-centre visibility describes terrain clearance. Energy integrates a finite solar disc with joint terrain and Earth obstruction, actual Sun distance, and panel incidence.</li><li>The battery model includes charge/discharge losses, capacity, optional power limits and unmet load. It excludes thermal design, ageing, detailed electrical behavior and radio link budgets.</li><li>Numerical refinement checks and NASA elevation uncertainty are separate. Five-metre pixels do not imply five-metre accuracy; small changes near a skyline can change the result.</li><li>The free camera never moves the locked observer. Terrain picks use a 10 m display grid; scientific heights are re-sampled from the native DEM.</li><li>Global imagery and estimated render shadows provide context; numerical results consume the independently sampled elevation profiles and SPICE geometry.</li></ul>
      {activePrepared && <p className="method-note">Local refinement diagnostics: radial coarsening {activePrepared.quality.radialCoarseningMaxDeltaDeg.toFixed(4)}°, angular coarsening {activePrepared.quality.angularCoarseningMaxDeltaDeg.toFixed(4)}°, sampled half-step check {activePrepared.quality.halfStepCheckMaxDeltaDeg.toFixed(4)}°. These measured checks are not a guaranteed terrain error bound.</p>}
      <button className="text-button" onClick={() => { setSourcesOpen(false); onOpenReference(); }}>Open the original three-point reference explorer<ArrowRight size={15} /></button>
    </MethodDialog>
  </div>;
}
