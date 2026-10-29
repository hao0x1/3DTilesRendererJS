import { useId, useMemo, useRef } from 'react';
import type { PointerEvent } from 'react';
import { Pause, Play } from '@phosphor-icons/react';

export interface VisibilityPeriod {
  startUtc: string;
  endUtc: string;
  visible: boolean;
}

export interface ScenarioTimelineView {
  id: 'A' | 'B';
  label: string;
  startUtc: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  sunIntervals: readonly VisibilityPeriod[];
  earthIntervals: readonly VisibilityPeriod[];
  coverageEndUtc?: string;
}

interface ScenarioTimelineProps {
  scenarios: readonly ScenarioTimelineView[];
  durationHours: number;
  elapsedHours: number;
  onElapsedHoursChange: (hours: number) => void;
  playing?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  activeScenarioId: 'A' | 'B';
  onActivate?: (id: 'A' | 'B') => void;
}

interface Interval {
  startHours: number;
  endHours: number;
  visible: boolean;
}

const HOUR = 3_600_000;
const IDS = ['A', 'B'] as const;
const number = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('en', { timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const elapsedLabel = (hours: number) => hours > 0 && hours < 1 ? `${number.format(hours * 60)}m` : hours >= 48 ? `${number.format(hours / 24)}d` : `${number.format(hours)}h`;

function intervalsFor(periods: readonly VisibilityPeriod[], startMs: number, durationHours: number, coverageEndUtc?: string): Interval[] {
  if (!Number.isFinite(startMs) || durationHours <= 0) return [];
  const coverageEndMs = coverageEndUtc ? Date.parse(coverageEndUtc) : NaN;
  const endMs = Math.min(startMs + durationHours * HOUR, Number.isFinite(coverageEndMs) ? coverageEndMs : Infinity);
  const intervals: Interval[] = [];
  for (const period of Array.isArray(periods) ? periods : []) {
    if (!period || typeof period.visible !== 'boolean') continue;
    const from = Date.parse(period.startUtc), to = Date.parse(period.endUtc);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    const clippedFrom = Math.max(startMs, from), clippedTo = Math.min(endMs, to);
    if (clippedTo <= clippedFrom) continue;
    intervals.push({ startHours: (clippedFrom - startMs) / HOUR, endHours: (clippedTo - startMs) / HOUR, visible: period.visible });
  }
  // Keep known obstruction below explicit visibility if a caller supplies
  // overlapping periods; neither is extended outside its supplied bounds.
  return intervals.sort((a, b) => Number(a.visible) - Number(b.visible) || a.startHours - b.startHours);
}

export default function ScenarioTimeline({ scenarios, durationHours, elapsedHours, onElapsedHoursChange, playing = false, onPlayingChange, activeScenarioId, onActivate }: ScenarioTimelineProps) {
  const scrubbing = useRef(false);
  const id = useId().replace(/:/g, '');
  const sliderId = `scenario-time-${id}`;
  const patternId = `scenario-unknown-${id}`;
  const descriptionId = `scenario-time-description-${id}`;
  const duration = Number.isFinite(durationHours) ? Math.max(0, durationHours) : 0;
  const elapsed = clamp(Number.isFinite(elapsedHours) ? elapsedHours : 0, 0, duration);
  const views = useMemo(() => IDS.map(scenarioId => scenarios.find(scenario => scenario?.id === scenarioId)), [scenarios]);
  const rows = useMemo(() => IDS.flatMap((scenarioId, index) => {
    const view = views[index];
    const start = view ? Date.parse(view.startUtc) : NaN;
    return (['sun', 'earth'] as const).map(body => ({
      id: scenarioId,
      body,
      status: view?.status ?? 'idle',
      validStart: Number.isFinite(start),
      intervals: view?.status === 'ready' ? intervalsFor(body === 'sun' ? view.sunIntervals : view.earthIntervals, start, duration, view.coverageEndUtc) : [],
    }));
  }), [views, duration]);

  const currentDates = views.map(view => {
    const start = view ? Date.parse(view.startUtc) : NaN;
    return Number.isFinite(start) ? new Date(start + elapsed * HOUR).toISOString() : null;
  });
  const xFor = (hours: number) => duration > 0 ? clamp(hours / duration * 1000, 0, 1000) : 0;
  const chooseElapsed = (hours: number) => {
    if (duration <= 0) return;
    if (playing) onPlayingChange?.(false);
    onElapsedHoursChange(clamp(Math.round(hours * 60) / 60, 0, duration));
  };
  const chooseAtPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    chooseElapsed(clamp((event.clientX - bounds.left) / bounds.width, 0, 1) * duration);
  };
  const statusText = (row: typeof rows[number]) => row.status === 'loading' ? 'Calculating…' : row.status === 'error' ? 'Unavailable' : row.status === 'idle' ? 'Not calculated' : !row.validStart ? 'No UTC arrival' : row.intervals.length === 0 ? 'No samples' : '';

  return <section className="scenario-timeline" aria-label="Linked scenario visibility timeline">
    <div className="scenario-timeline-heading">
      <div className="scenario-timeline-dates">{IDS.map((scenarioId, index) => {
        const view = views[index];
        const label = view?.label || `Scenario ${scenarioId}`;
        const current = currentDates[index];
        return <div key={scenarioId} className={`scenario-timeline-date ${activeScenarioId === scenarioId ? 'is-active' : ''}`}>
          {onActivate ? <button type="button" className="scenario-timeline-scenario-button" onClick={() => onActivate(scenarioId)} aria-pressed={activeScenarioId === scenarioId} aria-label={`Activate scenario ${scenarioId}: ${label}`}><span className="scenario-timeline-scenario-id">{scenarioId}</span><span className="scenario-timeline-scenario-label">{label}</span></button> : <span className="scenario-timeline-scenario-label"><span className="scenario-timeline-scenario-id">{scenarioId}</span>{label}</span>}
          {current ? <time className="scenario-timeline-utc" dateTime={current}>{date.format(Date.parse(current))} <small>UTC</small></time> : <span className="scenario-timeline-utc scenario-timeline-utc-unavailable">Arrival not set</span>}
        </div>;
      })}</div>
      <div className="scenario-timeline-playback"><span className="scenario-timeline-elapsed">+{elapsedLabel(elapsed)}</span>{onPlayingChange && <button type="button" className="scenario-timeline-play-button" aria-label={playing ? 'Pause shared mission time' : 'Play shared mission time'} aria-pressed={playing} disabled={duration <= 0} onClick={() => onPlayingChange(!playing)}>{playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}</button>}</div>
    </div>
    <div className="scenario-timeline-body">
      <div className="scenario-timeline-row-labels">{rows.map(row => <div key={`${row.id}-${row.body}`} className={`scenario-timeline-row-label scenario-timeline-row-label-${row.body} ${activeScenarioId === row.id ? 'is-active' : ''}`}><span className="scenario-timeline-row-id">{row.id}</span><span title={row.body === 'sun' ? 'Sun centre above the modeled horizon; excludes Earth eclipses' : 'Earth centre above the antenna horizon'}>{row.body === 'sun' ? 'Sun horizon' : 'Earth centre'}</span>{statusText(row) && <small className="scenario-timeline-row-state">{statusText(row)}</small>}</div>)}</div>
      <div className="scenario-timeline-tracks">
        <svg className="scenario-timeline-svg" width="100%" height="80" viewBox="0 0 1000 80" preserveAspectRatio="none" role="img" aria-label="Four actual mission-relative visibility rows: scenario A Sun and Earth, then scenario B Sun and Earth" aria-describedby={descriptionId} onPointerDown={event => {
          scrubbing.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          chooseAtPointer(event);
        }} onPointerMove={event => { if (scrubbing.current) chooseAtPointer(event); }} onPointerUp={() => { scrubbing.current = false; }} onPointerCancel={() => { scrubbing.current = false; }} onLostPointerCapture={() => { scrubbing.current = false; }}>
          <desc id={descriptionId}>Bright amber bands indicate the Sun centre above the modeled horizon, excluding Earth eclipses. Bright blue bands indicate Earth-centre visibility from the antenna. Dark bands are supplied obstruction intervals. Hatched portions have no available calculation. A and B use the same elapsed mission time, with different UTC arrivals shown above.</desc>
          <defs><pattern id={patternId} width="12" height="8" patternUnits="userSpaceOnUse"><path className="scenario-timeline-unknown-hatch" d="M-2,8L6,0M4,8L12,0M10,8L18,0" fill="none" /></pattern></defs>
          {rows.map((row, index) => <g key={`${row.id}-${row.body}`} className={`scenario-timeline-row scenario-timeline-row-${row.body} scenario-timeline-row-${row.status} ${activeScenarioId === row.id ? 'is-active' : ''}`}>
            <rect className="scenario-timeline-track" x="0" y={index * 20 + 4} width="1000" height="12" rx="2" />
            <rect className="scenario-timeline-unavailable" x="0" y={index * 20 + 4} width="1000" height="12" rx="2" fill={`url(#${patternId})`} />
            {row.intervals.map((interval, intervalIndex) => <rect key={intervalIndex} className={`scenario-timeline-interval ${interval.visible ? `scenario-timeline-visible scenario-timeline-visible-${row.body}` : 'scenario-timeline-obstructed'}`} x={xFor(interval.startHours)} y={index * 20 + 4} width={Math.max(0, xFor(interval.endHours) - xFor(interval.startHours))} height="12" />)}
          </g>)}
          <line className="scenario-timeline-guide" x1={xFor(elapsed)} x2={xFor(elapsed)} y1="0" y2="80" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="scenario-timeline-axis"><span>+0h</span><span>+{elapsedLabel(duration / 2)}</span><span>+{elapsedLabel(duration)}</span></div>
        <label className="scenario-timeline-sr-only" htmlFor={sliderId}>Elapsed mission time shared by both scenarios</label>
        <input className="scenario-timeline-scrubber" id={sliderId} type="range" min="0" max={duration} step={1 / 60} value={elapsed} disabled={duration <= 0} onChange={event => chooseElapsed(Number(event.target.value))} aria-valuetext={`${elapsedLabel(elapsed)} into both missions. ${IDS.map((scenarioId, index) => currentDates[index] ? `Scenario ${scenarioId}: ${date.format(Date.parse(currentDates[index]!))} UTC` : `Scenario ${scenarioId}: arrival not set`).join('. ')}`} />
      </div>
    </div>
    <div className="scenario-timeline-footnote"><span>Shared elapsed time · Sun rows exclude Earth eclipses</span><span><i className="scenario-timeline-legend-visible" aria-hidden="true" />Visible<i className="scenario-timeline-legend-obstructed" aria-hidden="true" />Obstructed<i className="scenario-timeline-legend-unavailable" aria-hidden="true" />Uncalculated</span></div>
  </section>;
}
