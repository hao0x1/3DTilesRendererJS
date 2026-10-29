import { useEffect, useRef } from 'react';
import { ArrowRight, CaretDown, Check, CircleNotch, Crosshair, LockKey, WarningCircle } from '@phosphor-icons/react';
import UTCDateTimePicker from './UTCDateTimePicker';
import NumericControl from './NumericControl';

export type ScenarioId = 'A' | 'B';
export type HorizonJobStatus = 'idle' | 'loading' | 'ready' | 'error';
export interface ScenarioPointView {
  latitudeDeg: number;
  longitudeDeg: number;
  eastM: number;
  northM: number;
}
export interface ScenarioHorizonView {
  status: HorizonJobStatus;
  detail?: string;
  coverageLabel: string;
  /** Completed fraction, when the worker reports progress. Omit to stay indeterminate. */
  progress?: number;
}
export interface ScenarioView {
  id: ScenarioId;
  siteId: string;
  siteName: string;
  point: ScenarioPointView;
  startUtc: string;
  antennaHeightM: number;
  panelHeightM: number;
  horizon: ScenarioHorizonView;
}
export interface ScenarioPatch {
  siteId?: string;
  startUtc?: string;
  antennaHeightM?: number;
  panelHeightM?: number;
}
export interface ScenarioWorkspaceProps {
  scenarios: readonly ScenarioView[];
  activeScenarioId: ScenarioId;
  sites: readonly { id: string; name: string }[];
  dateRange: { min: string; max: string };
  heightRange: { min: number; max: number; step?: number };
  onActivate: (id: ScenarioId) => void;
  onChange: (id: ScenarioId, patch: ScenarioPatch) => void;
  onPickPoint: (id: ScenarioId) => void;
  onCopyAtoB: () => void;
  onDelayB72h: () => void;
  delayAllowed: boolean;
  delayUnavailableReason?: string;
  pointPickingId?: ScenarioId | null;
  onCancelPick?: () => void;
}

const dateLabel = new Intl.DateTimeFormat('en', { timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const coordinate = (value: number, positive: string, negative: string) => `${Math.abs(value).toFixed(5)}° ${value < 0 ? negative : positive}`;
const offset = (value: number, positive: string, negative: string) => `${Math.abs(value).toFixed(0)} m ${value < 0 ? negative : positive}`;

function SiteChoice({ value, sites, onChange }: { value: string; sites: ScenarioWorkspaceProps['sites']; onChange: (id: string) => void }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !disclosure.current?.contains(event.target) && disclosure.current) disclosure.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return <details className="scenario-site-choice" ref={disclosure} onKeyDown={event => {
    if (event.key === 'Escape' && disclosure.current?.open) { event.preventDefault(); event.stopPropagation(); disclosure.current.open = false; summary.current?.focus(); }
  }}>
    <summary ref={summary} aria-label={`Choose base region. Current region: ${sites.find(site => site.id === value)?.name ?? value}`}><span>{sites.find(site => site.id === value)?.name ?? value}</span><CaretDown size={14} /></summary>
    <div className="scenario-site-options" role="group" aria-label="Base regions">{sites.map(site => <button key={site.id} type="button" className={site.id === value ? 'is-selected' : ''} aria-pressed={site.id === value} onClick={() => { onChange(site.id); if (disclosure.current) disclosure.current.open = false; summary.current?.focus(); }}><span>{site.name}</span>{site.id === value && <Check size={14} />}</button>)}</div>
  </details>;
}

export function HorizonJobState({ value }: { value: ScenarioHorizonView }) {
  const label = value.status === 'ready' ? 'Scenario ready' : value.status === 'loading' ? 'Updating scenario' : value.status === 'error' ? 'Scenario unavailable' : 'Waiting for calculation';
  return <div className={`scenario-horizon-state is-${value.status}`} aria-busy={value.status === 'loading'}>
    <div className="scenario-horizon-heading">{value.status === 'loading' ? <CircleNotch size={14} className="loading-spinner" /> : value.status === 'ready' ? <Check size={14} /> : <WarningCircle size={14} />}<span role="status" aria-live="polite">{label}</span></div>
    {value.status === 'loading' && <progress max="1" value={typeof value.progress === 'number' && Number.isFinite(value.progress) ? Math.min(1, Math.max(0, value.progress)) : undefined} aria-label="Scenario update progress" />}
    {value.detail && <p>{value.detail}</p>}
    <small>{value.coverageLabel}</small>
  </div>;
}

export default function ScenarioWorkspace({ scenarios, activeScenarioId, sites, dateRange, heightRange, onActivate, onChange, onPickPoint, onCopyAtoB, onDelayB72h, delayAllowed, delayUnavailableReason, pointPickingId = null, onCancelPick }: ScenarioWorkspaceProps) {
  return <section className="scenario-workspace" aria-label="Landing scenarios A and B">
    <div className="scenario-workspace-heading"><span className="eyebrow">LOCKED SCENARIOS</span><p>Choose a point, arrival time and equipment heights.</p></div>
    <div className="scenario-cards">{scenarios.map(scenario => {
      const change = (patch: ScenarioPatch) => { onActivate(scenario.id); onChange(scenario.id, patch); };
      const picking = pointPickingId === scenario.id;
      return <article className={`scenario-card ${scenario.id === activeScenarioId ? 'is-active' : ''}`} key={scenario.id}>
        <button type="button" className="scenario-card-heading" onClick={() => onActivate(scenario.id)} aria-label={`Show scenario ${scenario.id} in the scene`} aria-pressed={scenario.id === activeScenarioId}>
          <span className={`scenario-letter scenario-letter--${scenario.id.toLowerCase()}`}>{scenario.id}</span><span className="scenario-card-name"><strong>{scenario.siteName}</strong><small>{dateLabel.format(Date.parse(scenario.startUtc))} UTC</small></span><span className="scenario-active-mark">{scenario.id === activeScenarioId ? 'In scene' : 'View'}</span>
        </button>
        <div className="scenario-fields">
          <div className="scenario-field"><span className="scenario-field-label">Base region</span><SiteChoice value={scenario.siteId} sites={sites} onChange={siteId => change({ siteId })} /></div>
          <div className="scenario-point"><div className="scenario-point-heading"><LockKey size={13} /><span>Locked landing point</span></div><p>{coordinate(scenario.point.latitudeDeg, 'N', 'S')}<span> / </span>{coordinate(scenario.point.longitudeDeg, 'E', 'W')}</p><small>{offset(scenario.point.eastM, 'east', 'west')} · {offset(scenario.point.northM, 'north', 'south')} of region origin</small></div>
          <button type="button" className={`scenario-pick-button ${picking ? 'is-picking' : ''}`} onClick={() => { onActivate(scenario.id); if (picking && onCancelPick) onCancelPick(); else onPickPoint(scenario.id); }}><Crosshair size={15} /><span>{picking ? onCancelPick ? 'Cancel terrain pick' : 'Picking on terrain…' : 'Pick a nearby point'}</span></button>
          {picking && <p className="scenario-pick-hint" role="status">Choose a nearby terrain point, then confirm it to replace this locked point.</p>}
          <div className="scenario-field"><span className="scenario-field-label">Arrival <span>UTC</span></span><UTCDateTimePicker value={scenario.startUtc} min={dateRange.min} max={dateRange.max} onChange={startUtc => change({ startUtc })} /></div>
          <div className="scenario-height-fields"><NumericControl label="Antenna height" unit="m" value={scenario.antennaHeightM} min={heightRange.min} max={heightRange.max} step={heightRange.step} onChange={antennaHeightM => change({ antennaHeightM })} /><NumericControl label="Panel height" unit="m" value={scenario.panelHeightM} min={heightRange.min} max={heightRange.max} step={heightRange.step} onChange={panelHeightM => change({ panelHeightM })} /></div>
          <HorizonJobState value={scenario.horizon} />
        </div>
      </article>;
    })}</div>
    <div className="scenario-copy"><button type="button" onClick={onCopyAtoB}><span className="scenario-delay-letters">A <ArrowRight size={12} /> B</span><span>Copy A to B</span><small>Same arrival</small></button></div>
    <div className="scenario-delay"><button type="button" onClick={onDelayB72h} disabled={!delayAllowed} aria-describedby={!delayAllowed && delayUnavailableReason ? 'scenario-delay-reason' : undefined}><span className="scenario-delay-letters">A <ArrowRight size={12} /> B</span><span>Copy A, arrive 72 hours later</span><ArrowRight size={15} /></button><p id="scenario-delay-reason">{!delayAllowed && delayUnavailableReason ? delayUnavailableReason : 'Copies the point and heights. Only arrival time changes, by exactly three UTC days.'}</p></div>
  </section>;
}
