import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise, ArrowDown, ArrowRight, ArrowUpRight, Check,
  CircleNotch, Compass, Cube, GlobeHemisphereEast as Earth, GlobeHemisphereWest, Info,
  Moon, Pause, Play, SlidersHorizontal, Sparkle, Sun, X,
} from '@phosphor-icons/react';
import Scene from './Scene';
import HorizonPlot from './components/HorizonPlot';
import { analyzeSite, findMissionWindow, formatDuration, sampleAt, visibilitySegments } from './science';
import type { MissionWindow } from './science';
import type { Mission, ObservatoryData, Site, SiteAnalysis, SkySample } from './types';

type DialogName = 'compare' | 'sources' | null;
const number = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const dateLabel = (s: string, time = false) => new Intl.DateTimeFormat('en', {
  timeZone: 'UTC', month: 'short', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
}).format(new Date(s));
const coordinate = (v: number, positive: string, negative: string) => `${Math.abs(v).toFixed(3)}° ${v < 0 ? negative : positive}`;
const angle = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}°`;
const searchKeyFor = (siteId: string, mission: Mission) => [siteId, mission.startIndex, mission.durationHours, mission.maxDarkHours, mission.maxEarthGapHours, Number(mission.terrainEnabled)].join(':');

function StatusMark({ ok }: { ok: boolean }) {
  return <span className={`status-mark ${ok ? 'yes' : 'no'}`} aria-label={ok ? 'Within limit' : 'Over limit'}>{ok ? <Check size={12} weight="bold" /> : '−'}</span>;
}

function Modal({ open, title, close, children, wide = false }: {
  open: boolean; title: string; close: () => void; children: React.ReactNode; wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return <dialog ref={dialog} aria-label={title} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="modal-header"><div><span className="eyebrow">MOONDA / OBSERVATORY</span><h2>{title}</h2></div><button className="icon-button" aria-label={`Close ${title}`} onClick={close}><X size={21} /></button></div>
    <div className="modal-body">{children}</div>
  </dialog>;
}

function Timeline({ site, timeIndex, setTimeIndex, mission, playing, setPlaying }: {
  site: Site; timeIndex: number; setTimeIndex: (i: number) => void; mission: Mission; playing: boolean; setPlaying: (v: boolean) => void;
}) {
  const times = site.ephemeris.timesUtc;
  const selectedTime = sampleAt(site, timeIndex, mission.terrainEnabled).timeUtc;
  const segments = useMemo(() => visibilitySegments(site, {
    startIndex: 0,
    durationHours: (Date.parse(times[times.length - 1]) - Date.parse(times[0])) / 3600000,
    maxDarkHours: 0,
    maxEarthGapHours: 0,
    terrainEnabled: mission.terrainEnabled,
  }), [site, mission.terrainEnabled]);
  const startMs = new Date(times[0]).getTime();
  const endMs = new Date(times[times.length - 1]).getTime();
  const spanMs = Math.max(1, endMs - startMs);
  const xFor = (ms: number) => clamp((ms - startMs) / spanMs * 1000, 0, 1000);
  const missionStartMs = Date.parse(sampleAt(site, mission.startIndex, mission.terrainEnabled).timeUtc);
  const missionStartX = xFor(missionStartMs);
  const missionEndX = xFor(missionStartMs + mission.durationHours * 3600000);
  const currentX = xFor(Date.parse(selectedTime));
  function visibleIntervals(body: 'sun' | 'earth') {
    const intervals: [number, number][] = [];
    for (const interval of segments) {
      if (!(body === 'sun' ? interval.sunVisible : interval.earthVisible)) continue;
      const a = xFor(Date.parse(interval.startUtc)), b = xFor(Date.parse(interval.endUtc));
      const previous = intervals[intervals.length - 1];
      if (previous && Math.abs(previous[1] - a) < .001) previous[1] = b;
      else intervals.push([a, b]);
    }
    return intervals;
  }
  return <section className="timeline" aria-label="Sun and Earth visibility timeline">
    <div className="timeline-heading"><div className="timeline-title"><span className="eyebrow">TIME EXPLORER</span><span className="timeline-subtitle">Drag through the lunar day</span></div><div className="time-readout"><span>{dateLabel(selectedTime, true)}</span><small>UTC</small><button className="icon-button play-button" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause time animation' : 'Play time animation'}>{playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}</button></div></div>
    <div className="timeline-chart">
      <div className="timeline-labels"><span><Sun size={15} />Sunlight</span><span><Earth size={15} />Earth in view</span></div>
      <div className="timeline-tracks">
        <svg viewBox="0 0 1000 50" preserveAspectRatio="none" role="img" aria-label="Estimated sunlight and Earth visibility over the cached period; bright segments indicate visibility">
          <rect x="0" y="5" width="1000" height="12" rx="2" className="track" />
          <rect x="0" y="32" width="1000" height="12" rx="2" className="track" />
          <rect x={missionStartX} y="0" width={Math.max(0, missionEndX - missionStartX)} height="50" className="mission-shade" />
          {visibleIntervals('sun').map(([a, b], i) => <rect key={`s${i}`} x={a} y="5" width={Math.max(0, b - a + 0.1)} height="12" className="sun-segment" />)}
          {visibleIntervals('earth').map(([a, b], i) => <rect key={`e${i}`} x={a} y="32" width={Math.max(0, b - a + 0.1)} height="12" className="earth-segment" />)}
          <line x1={currentX} x2={currentX} y1="0" y2="50" className="time-guide" />
        </svg>
        <label className="sr-only" htmlFor="time-scrubber">Selected time in cached NASA dataset</label>
        <input id="time-scrubber" className="time-scrubber" type="range" min="0" max={times.length - 1} step="1" value={timeIndex} onChange={e => { setPlaying(false); setTimeIndex(Number(e.target.value)); }} aria-valuetext={`${dateLabel(selectedTime, true)} UTC`} />
        <div className="time-axis"><span>{dateLabel(times[0])}</span><span>{dateLabel(times[Math.floor((times.length - 1) / 2)])}</span><span>{dateLabel(times[times.length - 1])}</span></div>
      </div>
    </div>
    <div className="timeline-footnote"><span><span className="mission-key" />Shaded area: your mission window</span><span>{mission.terrainEnabled ? 'Terrain horizon' : 'Geometric horizon'} · sampled estimates</span></div>
  </section>;
}

function CurrentSky({ sample, terrain }: { sample: SkySample; terrain: boolean }) {
  return <div className="sky-readings" aria-label="Current sky geometry">
    <span className="eyebrow">AT THIS MOMENT</span>
    <div className="sky-reading sun-reading"><Sun size={21} /><div><span>Sun</span><strong>{angle(sample.sunEl)}</strong><small>{sample.sunVisible ? 'Above' : 'Below'} {terrain ? 'terrain' : 'geometric'} horizon</small></div><span className={`visibility-dot ${sample.sunVisible ? 'visible' : ''}`} /></div>
    <div className="sky-reading earth-reading"><Earth size={21} /><div><span>Earth</span><strong>{angle(sample.earthEl)}</strong><small>{sample.earthVisible ? 'Above' : 'Below'} {terrain ? 'terrain' : 'geometric'} horizon</small></div><span className={`visibility-dot ${sample.earthVisible ? 'visible' : ''}`} /></div>
  </div>;
}

function Summary({ analysis, mission, openCompare }: { analysis: SiteAnalysis; mission: Mission; openCompare: () => void }) {
  return <section className="mission-summary" aria-label="Selected site's mission analysis">
    <div className="summary-title"><span className="eyebrow">MISSION OUTLOOK</span><span className={`fit-label ${analysis.fits ? 'fits' : 'exceeds'}`}>{analysis.actualDurationHours + .01 < mission.durationHours ? 'Incomplete period' : analysis.fits ? 'Within your limits' : 'Review the gaps'}</span></div>
    <div className="coverage-row"><div><span className="coverage-value solar">{number.format(analysis.solarPercent)}<small>%</small></span><span>Sunlight access</span></div><div><span className="coverage-value earth">{number.format(analysis.earthPercent)}<small>%</small></span><span>Earth visibility</span></div></div>
    <div className="gap-row"><span>Longest darkness</span><strong>{formatDuration(analysis.longestDarkHours)}</strong><StatusMark ok={analysis.longestDarkHours <= mission.maxDarkHours} /></div>
    <div className="gap-row"><span>Longest Earth gap</span><strong>{formatDuration(analysis.longestEarthGapHours)}</strong><StatusMark ok={analysis.longestEarthGapHours <= mission.maxEarthGapHours} /></div>
    {analysis.actualDurationHours + .01 < mission.durationHours && <p className="inline-warning">Only {formatDuration(analysis.actualDurationHours)} remain in this cached period. Choose an earlier start for the full mission.</p>}
    <button className="text-button compare-link" onClick={openCompare}>Compare all locations <ArrowRight size={15} /></button>
  </section>;
}

const tour = [
  { label: '01 / DEFINE', title: 'Every mission has different needs.', text: 'Set a duration and the longest darkness and Earth-visibility gaps you can accept. The comparison uses your limits.' },
  { label: '02 / EXPLORE', title: 'A few places. Very different horizons.', text: 'Select a sample location to explore its NASA terrain and compare its available sunlight and Earth visibility.' },
  { label: '03 / DESCEND', title: 'Look from the surface.', text: 'The horizon view connects the shape of the surrounding terrain to the Sun and Earth positions at the selected time.' },
  { label: '04 / UNDERSTAND', title: 'Change the time. See the tradeoff.', text: 'Scrub the timeline below. Bright sections mark estimated visibility; the comparison explains which gaps exceed your limits.' },
];

export default function App() {
  const [data, setData] = useState<ObservatoryData | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [timeIndex, setTimeIndex] = useState(0);
  const [mode, setMode] = useState<'globe' | 'surface'>('globe');
  const [dialog, setDialog] = useState<DialogName>(null);
  const [playing, setPlaying] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [tourStep, setTourStep] = useState(-1);
  const [mission, setMission] = useState<Mission>({ startIndex: 0, durationHours: 48, maxDarkHours: 24, maxEarthGapHours: 12, terrainEnabled: true });
  const [searching, setSearching] = useState(false);
  const [windowSearch, setWindowSearch] = useState<{ key: string; result: MissionWindow | null; error?: string } | null>(null);
  const searchSerial = useRef(0);
  const searchJob = useRef<{ frame?: number; timer?: number }>({});

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let active = true;
    navigator.serviceWorker.ready.then(registration => {
      if (active && registration.active) setOfflineReady(true);
    }).catch(() => { /* Local data remains usable if offline installation is unavailable. */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetch('./data/observatory.json', { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(`Dataset request failed (${r.status}).`); return r.json(); })
      .then((loaded: ObservatoryData) => {
        if (!loaded.sites?.length || loaded.sites.some(s => s.ephemeris.timesUtc.length < 2)) throw new Error('The local NASA dataset is incomplete.');
        setData(loaded);
        setSelectedId(loaded.sites[0].id);
        // Start at the first cached UTC scenario, not the hackathon dates. The
        // event date is unrelated to the mission window being explored.
        const initial = 0;
        setTimeIndex(initial);
        setMission(m => ({ ...m, startIndex: initial }));
      })
      .catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [attempt]);

  const selected = data?.sites.find(s => s.id === selectedId) ?? data?.sites[0];
  const analyses = useMemo(() => data?.sites.map(s => analyzeSite(s, mission)) ?? [], [data, mission]);
  const current = useMemo(() => selected ? sampleAt(selected, timeIndex, mission.terrainEnabled) : null, [selected, timeIndex, mission.terrainEnabled]);
  const analysis = analyses.find(a => a.siteId === selected?.id);
  const searchKey = selected ? searchKeyFor(selected.id, mission) : '';
  const latestSearchKey = useRef(searchKey);
  latestSearchKey.current = searchKey;
  const activeWindowSearch = windowSearch?.key === searchKey ? windowSearch : null;

  useEffect(() => {
    searchSerial.current++;
    setSearching(false);
    setWindowSearch(previous => previous?.key === searchKey ? previous : null);
  }, [searchKey]);

  useEffect(() => () => {
    searchSerial.current++;
    if (searchJob.current.frame !== undefined) cancelAnimationFrame(searchJob.current.frame);
    if (searchJob.current.timer !== undefined) clearTimeout(searchJob.current.timer);
  }, []);

  const findWindow = () => {
    if (!selected || searching) return;
    const ownSerial = ++searchSerial.current;
    const requestedKey = searchKey;
    const requestedSite = selected;
    const requestedMission = { ...mission };
    setSearching(true);
    setWindowSearch(null);
    setPlaying(false);
    // Allow the busy state to paint before the bounded, local computation.
    searchJob.current.frame = requestAnimationFrame(() => {
      searchJob.current.timer = window.setTimeout(() => {
        if (ownSerial !== searchSerial.current || requestedKey !== latestSearchKey.current) return;
        try {
          const result = findMissionWindow(requestedSite, requestedMission, 6);
          if (ownSerial !== searchSerial.current || requestedKey !== latestSearchKey.current) return;
          const nextMission = result ? { ...requestedMission, startIndex: result.startIndex } : requestedMission;
          if (result) {
            setMission(nextMission);
            setTimeIndex(result.startIndex);
          }
          setWindowSearch({ key: searchKeyFor(requestedSite.id, nextMission), result });
        } catch (cause) {
          setWindowSearch({ key: requestedKey, result: null, error: cause instanceof Error ? cause.message : 'The cached period could not be analyzed.' });
        } finally {
          setSearching(false);
        }
      }, 0);
    });
  };

  useEffect(() => {
    if (!playing || !selected) return;
    const timer = window.setInterval(() => setTimeIndex(i => {
      if (i >= selected.ephemeris.timesUtc.length - 1) { setPlaying(false); return i; }
      return i + 1;
    }), 240);
    return () => window.clearInterval(timer);
  }, [playing, selected]);

  const selectSite = (id: string) => { setSelectedId(id); setPlaying(false); };
  const startTour = () => {
    setTourStep(0); setMode('globe'); setDialog(null); setPlaying(false);
    setSelectedId(data?.sites[0].id ?? ''); setTimeIndex(0);
    setMission({ startIndex: 0, durationHours: 48, maxDarkHours: 24, maxEarthGapHours: 12, terrainEnabled: true });
  };
  const nextTour = () => {
    const next = tourStep + 1;
    if (next >= tour.length) { setTourStep(-1); return; }
    if (next === 2) setMode('surface');
    setTourStep(next);
  };

  if (!data || !selected || !current || !analysis) return <div className="boot-screen">
    <div className="brand"><span className="brand-symbol"><Moon size={25} weight="fill" /></span><strong>MOONDA</strong></div>
    <div className="boot-orbit"><div /><Moon size={44} weight="light" /></div>
    <span className="eyebrow">LUNAR OBSERVATORY</span><h1>{error ? 'The dataset is unavailable.' : 'Preparing your view of the Moon.'}</h1>
    <p>{error || 'Loading the local NASA terrain and ephemeris dataset.'}</p>
    {error ? <button className="primary-button" onClick={() => setAttempt(a => a + 1)}><ArrowClockwise size={16} />Try again</button> : <CircleNotch size={20} className="loading-spinner" />}
  </div>;

  const times = selected.ephemeris.timesUtc;
  const missionStart = sampleAt(selected, mission.startIndex, mission.terrainEnabled).timeUtc;
  const changeStart = (value: string) => {
    if (!value) return;
    const target = new Date(`${value}Z`).getTime();
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(new Date(times[i]).getTime() - target) < Math.abs(new Date(times[best]).getTime() - target)) best = i;
    setMission(m => ({ ...m, startIndex: best })); setTimeIndex(best); setPlaying(false);
  };
  const limits = [...new Set([...(data.limitations ?? []), ...(selected.limitations ?? [])])];

  return <div className={`observatory-app ${mode === 'surface' ? 'surface-mode' : ''}`}>
    <header className="app-header">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setDialog(null); setMode('globe'); }} aria-label="MOONDA Lunar Observatory"><span className="brand-symbol"><Moon size={24} weight="fill" /></span><strong>MOONDA</strong><span className="brand-divider" /><span className="brand-description">Lunar Observatory</span></a>
      <nav className="header-nav" aria-label="Observatory views"><button className={dialog === null ? 'active' : ''} onClick={() => setDialog(null)}>Explore</button><button className={dialog === 'compare' ? 'active' : ''} onClick={() => setDialog('compare')}>Compare</button><button className={dialog === 'sources' ? 'active' : ''} onClick={() => setDialog('sources')}>Sources</button></nav>
      <div className="header-actions"><span className="dataset-state" role="status" aria-live="polite" title={offlineReady ? 'Application, terrain and NASA dataset cached for offline use in this browser' : 'NASA dataset served locally'}><span />{offlineReady ? 'OFFLINE READY' : 'LOCAL NASA DATA'}</span><button className="tour-button" onClick={startTour}><Play size={12} weight="fill" />Guided tour</button></div>
    </header>

    <main className="workspace">
      <aside className={`mission-panel ${tourStep === 0 ? 'tour-focus' : ''}`} aria-label="Mission setup">
        <div className="panel-heading"><span className="eyebrow">01 / YOUR MISSION</span><SlidersHorizontal size={17} /></div>
        <h1>Find your<br />next horizon.</h1>
        <p className="panel-intro">Compare lunar locations through the light they receive and the Earth they can see.</p>
        <div className="mission-fields">
          <label className="field-label" htmlFor="mission-start">Landing window <span>UTC</span></label>
          <input id="mission-start" className="date-input" type="datetime-local" value={missionStart.slice(0, 16)} min={times[0].slice(0, 16)} max={times[times.length - 2].slice(0, 16)} onInput={e => changeStart(e.currentTarget.value)} onChange={e => changeStart(e.target.value)} />
          <label className="field-label" htmlFor="duration">Mission duration</label>
          <div className="select-wrap"><select id="duration" value={mission.durationHours} onChange={e => setMission(m => ({ ...m, durationHours: Number(e.target.value) }))}><option value="24">24 hours</option><option value="48">48 hours</option><option value="72">72 hours</option><option value="168">7 days</option><option value="336">14 days</option></select></div>
          <div className="range-field"><label className="field-label" htmlFor="dark-limit">Maximum darkness <strong>{formatDuration(mission.maxDarkHours)}</strong></label><input id="dark-limit" type="range" min="0" max={Math.max(72, mission.durationHours, mission.maxDarkHours, mission.maxEarthGapHours)} step="1" value={mission.maxDarkHours} onChange={e => setMission(m => ({ ...m, maxDarkHours: Number(e.target.value) }))} /></div>
          <div className="range-field"><label className="field-label" htmlFor="earth-limit">Maximum Earth gap <strong>{formatDuration(mission.maxEarthGapHours)}</strong></label><input id="earth-limit" type="range" min="0" max={Math.max(72, mission.durationHours, mission.maxDarkHours, mission.maxEarthGapHours)} step="1" value={mission.maxEarthGapHours} onChange={e => setMission(m => ({ ...m, maxEarthGapHours: Number(e.target.value) }))} /></div>
        </div>
        <label className="terrain-toggle"><input type="checkbox" checked={mission.terrainEnabled} onChange={e => setMission(m => ({ ...m, terrainEnabled: e.target.checked }))} /><span className="toggle-track" /><span>Include surrounding terrain<small>Compare with the geometric horizon</small></span></label>
        <div className="window-finder" aria-busy={searching}>
          <button className="window-finder-button" onClick={findWindow} disabled={searching} title={`Search ${selected.name} using the current mission requirements`}>{searching ? <CircleNotch size={16} className="loading-spinner" /> : <Compass size={16} />}<span>{searching ? 'Checking cached windows…' : 'Find a window at this site'}</span>{!searching && <ArrowRight size={14} />}</button>
          <div className="window-finder-result" role="status" aria-live="polite">
            {activeWindowSearch?.error ? <p>{activeWindowSearch.error}</p> : activeWindowSearch && !activeWindowSearch.result ? <p>The cached period does not contain a complete analyzable mission of this duration. Try a shorter mission.</p> : activeWindowSearch?.result ? <>
              <strong className={activeWindowSearch.result.analysis.fits ? 'window-found' : 'window-closest'}>{activeWindowSearch.result.analysis.fits ? 'A sampled window meets both limits.' : 'No sampled window meets both limits.'}</strong>
              <p>{activeWindowSearch.result.analysis.fits ? 'Selected start' : 'Closest sampled start'}: {dateLabel(sampleAt(selected, activeWindowSearch.result.startIndex, mission.terrainEnabled).timeUtc, true)} UTC. Longest darkness {formatDuration(activeWindowSearch.result.analysis.longestDarkHours)}; Earth gap {formatDuration(activeWindowSearch.result.analysis.longestEarthGapHours)}.</p>
              <small>Best among {activeWindowSearch.result.candidatesChecked} starts checked every {activeWindowSearch.result.stepHours} hours. Finer start times may give different results.</small>
            </> : null}
          </div>
        </div>
        <div className={`site-section ${tourStep === 1 ? 'tour-focus' : ''}`}><div className="panel-heading"><span className="eyebrow">02 / EXPLORE LOCATIONS</span><span className="site-count">{data.sites.length.toString().padStart(2, '0')}</span></div>
          <div className="site-list">{data.sites.map((site, i) => <button key={site.id} className={`site-button ${site.id === selected.id ? 'selected' : ''}`} onClick={() => selectSite(site.id)} aria-pressed={site.id === selected.id}><span className="site-number">{String(i + 1).padStart(2, '0')}</span><span><strong>{site.name}</strong><small>{coordinate(site.latitudeDeg, 'N', 'S')} · {coordinate(site.longitudeDeg, 'E', 'W')}</small></span><ArrowUpRight size={15} /></button>)}</div>
        </div>
        <button className="method-link" onClick={() => setDialog('sources')}><Info size={15} />Data, method & limitations<ArrowUpRight size={13} /></button>
      </aside>

      <section className={`viewer viewer--${mode} ${tourStep >= 0 ? 'tour-active' : ''}`} aria-label="Interactive lunar scene">
        <div className="scene-container"><Scene sites={data.sites} selectedSite={selected} timeIndex={timeIndex} terrainEnabled={mission.terrainEnabled} mode={mode} onSelectSite={selectSite} onModeChange={setMode} /></div>
        <div className="scene-vignette" />
        <div className="viewer-title"><div className="eyebrow"><span className="location-tick" />LUNAR SOUTH POLE</div><h2>{selected.name}</h2><span>{coordinate(selected.latitudeDeg, 'N', 'S')}<span className="coordinate-divider">/</span>{coordinate(selected.longitudeDeg, 'E', 'W')}</span></div>
        <div className="view-switch" aria-label="Scene mode"><button className={mode === 'globe' ? 'active' : ''} onClick={() => setMode('globe')} aria-pressed={mode === 'globe'}><GlobeHemisphereWest size={16} />Overview</button><button className={mode === 'surface' ? 'active' : ''} onClick={() => setMode('surface')} aria-pressed={mode === 'surface'}><Compass size={16} />Horizon</button></div>
        <div className="viewer-inspector"><CurrentSky sample={current} terrain={mission.terrainEnabled} /><Summary analysis={analysis} mission={mission} openCompare={() => setDialog('compare')} /></div>
        <div className="view-guidance"><span className="navigation-glyph"><Cube size={17} /></span><span>{mode === 'globe' ? 'Drag to orbit · scroll to explore' : 'Drag to look · arrow keys rotate'}</span></div>
        <div className="scene-caption"><span className="eyebrow">{mode === 'globe' ? 'ORBITAL CONTEXT' : 'LOCAL TERRAIN'}</span><span>{mode === 'globe' ? 'Overview shown for orientation' : `Observer: ${number.format(selected.observerHeightM)} m above local ground`}</span></div>
        {tourStep >= 0 && <div className="guide-card"><button className="guide-close icon-button" aria-label="Close guided tour" onClick={() => setTourStep(-1)}><X size={16} /></button><span className="eyebrow">{tour[tourStep].label}</span><h3>{tour[tourStep].title}</h3><p>{tour[tourStep].text}</p><div className="guide-controls"><div className="guide-dots">{tour.map((_, i) => <span className={i === tourStep ? 'active' : ''} key={i} />)}</div><button className="text-button" onClick={nextTour}>{tourStep === tour.length - 1 ? 'Finish tour' : 'Continue'}<ArrowRight size={14} /></button></div></div>}
      </section>
    </main>
    {mode === 'surface' && <HorizonPlot site={selected} sample={current} terrainEnabled={mission.terrainEnabled} />}
    <Timeline site={selected} timeIndex={timeIndex} setTimeIndex={setTimeIndex} mission={mission} playing={playing} setPlaying={setPlaying} />
    <footer className="app-footer"><span>Built by MOONDA · NASA Space Apps 2026</span><span>Exploratory visibility estimates · not operational mission guidance</span><button onClick={() => setDialog('sources')}>NASA data & credits <ArrowUpRight size={11} /></button></footer>

    <Modal open={dialog === 'compare'} title="Different sites. Different tradeoffs." close={() => setDialog(null)} wide>
      <p className="dialog-intro">Your {formatDuration(mission.durationHours)} mission begins {dateLabel(missionStart, true)} UTC. Limits: {formatDuration(mission.maxDarkHours)} without sunlight and {formatDuration(mission.maxEarthGapHours)} without Earth visibility.</p>
      <div className="comparison-scroll"><table className="comparison-table"><thead><tr><th>Sample location</th><th>Sunlight</th><th>Earth visibility</th><th>Longest darkness</th><th>Longest Earth gap</th><th>Your limits</th></tr></thead><tbody>{data.sites.map(site => {
        const result = analyses.find(a => a.siteId === site.id)!;
        return <tr key={site.id} className={selected.id === site.id ? 'selected-row' : ''}><th><button onClick={() => { selectSite(site.id); setDialog(null); }}><strong>{site.name}</strong><span>Explore location <ArrowUpRight size={12} /></span></button></th><td className="solar">{number.format(result.solarPercent)}%</td><td className="earth">{number.format(result.earthPercent)}%</td><td>{formatDuration(result.longestDarkHours)}<StatusMark ok={result.longestDarkHours <= mission.maxDarkHours} /></td><td>{formatDuration(result.longestEarthGapHours)}<StatusMark ok={result.longestEarthGapHours <= mission.maxEarthGapHours} /></td><td><span className={`fit-label ${result.fits ? 'fits' : 'exceeds'}`}>{result.actualDurationHours + .01 < mission.durationHours ? 'Incomplete period' : result.fits ? 'Within limits' : 'Gap exceeds limit'}</span></td></tr>;
      })}</tbody></table></div>
      <div className="comparison-explanation"><Sparkle size={20} /><div><h3>There is no universal best site.</h3><p>A location fits this scenario when its estimated darkness and Earth-visibility gaps stay within both limits you chose. Changing the date, duration, or limits can change that result.</p></div></div>
      <p className="method-note">{mission.terrainEnabled ? `Uses sampled terrain horizons out to ${number.format(selected.horizon.maxRangeKm)} km.` : 'Uses a smooth geometric horizon with no terrain obstruction.'} Sun and Earth centre visibility is a geometric estimate. Electrical power output and working radio links require additional engineering analysis.</p>
    </Modal>

    <Modal open={dialog === 'sources'} title="An open view of our methods." close={() => setDialog(null)}>
      <p className="dialog-intro">{data.description}</p>
      <div className="source-method"><span className="eyebrow">CURRENT MODEL</span><dl><div><dt>Reference location</dt><dd>{selected.name}</dd></div><div><dt>Horizon</dt><dd>{mission.terrainEnabled ? selected.horizon.method : 'Geometric horizon at 0° elevation'}</dd></div><div><dt>Terrain coverage</dt><dd>Up to {number.format(selected.horizon.maxRangeKm)} km · {number.format(selected.horizon.terrainResolutionM)} m nominal resolution</dd></div><div><dt>Time convention</dt><dd>UTC throughout</dd></div><div><dt>Observer height</dt><dd>{number.format(selected.observerHeightM)} m above local ground</dd></div><div><dt>Dataset prepared</dt><dd>{dateLabel(data.generatedAt)} · {data.version}</dd></div></dl></div>
      <h3 className="source-section-title">Sources & acknowledgements</h3>
      <ul className="source-list">{selected.provenance.map((source, i) => <li key={`${source.url}-${i}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}<ArrowUpRight size={15} /></a>{source.detail && <p>{source.detail}</p>}</li>)}</ul>
      <ul className="source-list"><li><a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">NASA Scientific Visualization Studio · CGI Moon Kit<ArrowUpRight size={15} /></a><p>Moon appearance: NASA SVS / Ernie Wright, LRO/LROC. Display textures are optimized for appearance.</p></li><li><a href="https://svs.gsfc.nasa.gov/2915/" target="_blank" rel="noreferrer">NASA Blue Marble<ArrowUpRight size={15} /></a><p>Earth appearance: NASA Goddard / Reto Stöckli / Robert Simmon / MODIS Science Team.</p></li><li><a href="https://github.com/NASA-AMMOS/3DTilesRendererJS" target="_blank" rel="noreferrer">NASA-AMMOS · 3D Tiles Renderer<ArrowUpRight size={15} /></a><p>Rendering foundation, reused under Apache 2.0. MOONDA is an independent team project; no NASA endorsement is implied.</p></li></ul>
      <h3 className="source-section-title">What this prototype can establish</h3>
      <ul className="limitations-list">{limits.map((limit, i) => <li key={i}>{limit}</li>)}</ul>
      <p className="method-note">Geometric visibility does not certify a landing site, a radio link, battery requirements, or solar-panel power output. All comparisons are limited to the cached data period and the stated terrain model.</p>
    </Modal>
  </div>;
}
