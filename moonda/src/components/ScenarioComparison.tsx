import { ArrowRight, CircleNotch, Info } from '@phosphor-icons/react';
import type { EnergyResult } from '../energy';
import { formatDuration } from '../science';
import type { SiteAnalysis } from '../types';
import type { ScenarioId, ScenarioView } from './ScenarioWorkspace';

export interface ScenarioComparisonItem extends ScenarioView {
  visibility: SiteAnalysis | null;
  energy: EnergyResult | null;
}
export interface ScenarioComparisonProps {
  scenarios: readonly ScenarioComparisonItem[];
  activeScenarioId: ScenarioId;
  missionDurationHours: number;
  maxDarkHours: number;
  maxEarthGapHours: number;
  sharedEnergyModel: boolean;
  terrainEnabled?: boolean;
  /** Embed below an existing panel heading without repeating the title. */
  compact?: boolean;
  onActivate: (id: ScenarioId) => void;
}

const number = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('en', { timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const energyText = (value: number) => Math.abs(value) >= 1000 ? `${number.format(value / 1000)} kWh` : `${number.format(value)} Wh`;
const signed = (value: number, unit: string) => `${Math.abs(value) < .00001 ? '' : value > 0 ? '+' : '−'}${number.format(Math.abs(value))} ${unit}`;
type Metric = { label: string; a?: number; b?: number; format: (value: number) => string; delta: (value: number) => string; higherIsBetter: boolean; energy?: boolean; hint?: string };

export default function ScenarioComparison({ scenarios, activeScenarioId, missionDurationHours, maxDarkHours, maxEarthGapHours, sharedEnergyModel, terrainEnabled = true, compact = false, onActivate }: ScenarioComparisonProps) {
  const a = scenarios.find(item => item.id === 'A');
  const b = scenarios.find(item => item.id === 'B');
  if (!a || !b) return <section className={`scenario-comparison ${compact ? 'is-compact' : ''}`}><p className="scenario-comparison-empty">Lock both scenarios to compare their arrival windows.</p></section>;
  const readyA = a.horizon.status === 'ready';
  const readyB = b.horizon.status === 'ready';
  const av = readyA ? a.visibility : null;
  const bv = readyB ? b.visibility : null;
  const ae = readyA ? a.energy : null;
  const be = readyB ? b.energy : null;
  const fullVisibility = Boolean(av && bv && av.actualDurationHours + .01 >= missionDurationHours && bv.actualDurationHours + .01 >= missionDurationHours);
  const fullEnergy = Boolean(ae?.complete && be?.complete);
  const samePoint = a.siteId === b.siteId && Math.abs(a.point.latitudeDeg - b.point.latitudeDeg) < 1e-8 && Math.abs(a.point.longitudeDeg - b.point.longitudeDeg) < 1e-8;
  const sameHeights = Math.abs(a.antennaHeightM - b.antennaHeightM) < 1e-9 && Math.abs(a.panelHeightM - b.panelHeightM) < 1e-9;
  const deltaHours = (Date.parse(b.startUtc) - Date.parse(a.startUtc)) / 3_600_000;
  const exact72 = Math.abs(deltaHours - 72) < 1e-9;
  const waiting = a.horizon.status === 'loading' || b.horizon.status === 'loading' || a.horizon.status === 'idle' || b.horizon.status === 'idle';
  const metrics: Metric[] = [
    { label: terrainEnabled ? 'Sun above terrain horizon' : 'Sun above geometric horizon', a: av?.solarPercent, b: bv?.solarPercent, format: value => `${number.format(value)}%`, delta: value => signed(value, 'pp'), higherIsBetter: true, hint: 'Panel viewpoint · excludes Earth eclipses' },
    { label: 'Earth visibility', a: av?.earthPercent, b: bv?.earthPercent, format: value => `${number.format(value)}%`, delta: value => signed(value, 'pp'), higherIsBetter: true, hint: 'Antenna viewpoint' },
    { label: terrainEnabled ? 'Longest terrain obstruction' : 'Longest below-horizon gap', a: av?.longestDarkHours, b: bv?.longestDarkHours, format: formatDuration, delta: value => signed(value, 'h'), higherIsBetter: false, hint: `Horizon-only limit ${formatDuration(maxDarkHours)}` },
    { label: 'Longest Earth gap', a: av?.longestEarthGapHours, b: bv?.longestEarthGapHours, format: formatDuration, delta: value => signed(value, 'h'), higherIsBetter: false, hint: `Limit ${formatDuration(maxEarthGapHours)}` },
    { label: 'Solar generation', a: ae?.generatedWh, b: be?.generatedWh, format: energyText, delta: value => `${value < 0 ? '−' : value > 0 ? '+' : ''}${energyText(Math.abs(value))}`, higherIsBetter: true, energy: true },
    { label: 'Minimum battery', a: ae?.minBatteryWh, b: be?.minBatteryWh, format: energyText, delta: value => `${value < 0 ? '−' : value > 0 ? '+' : ''}${energyText(Math.abs(value))}`, higherIsBetter: true, energy: true },
    { label: 'Unmet load', a: ae?.unmetLoadWh, b: be?.unmetLoadWh, format: energyText, delta: value => `${value < 0 ? '−' : value > 0 ? '+' : ''}${energyText(Math.abs(value))}`, higherIsBetter: false, energy: true },
  ];
  const value = (metric: Metric, number: number | undefined) => number === undefined || !Number.isFinite(number) ? <span className="scenario-comparison-unavailable" aria-label="Not yet available">—</span> : metric.format(number);
  const causeChanges = [!samePoint && 'landing point', !sameHeights && 'equipment heights', !sharedEnergyModel && 'energy assumptions'].filter(Boolean);
  const arrivalExplanation = exact72 ? compact ? 'B arrives exactly 72 h later.' : 'B arrives exactly 72 hours after A.' : deltaHours === 0 ? 'Both arrival times are identical.' : `B arrives ${formatDuration(Math.abs(deltaHours))} ${deltaHours > 0 ? 'after' : 'before'} A.`;
  const changedInputsExplanation = causeChanges.length
    ? `Also changed: ${causeChanges.join(', ')}. Arrival time is not isolated.`
    : deltaHours === 0 ? compact ? 'Same point, heights and energy assumptions.' : 'The locked point, equipment heights, arrival and energy assumptions are identical.'
      : compact ? 'Same point, heights and energy assumptions; only arrival changes.' : 'The locked point, equipment heights and energy assumptions are identical; arrival timing is the only scenario change.';
  const modelNote = 'Sun visibility and solar obstruction measure Sun-centre clearance of the modeled horizon; Earth eclipses are included in energy, not these visibility rows. Percentage-point changes compare visibility fractions. Energy changes depend on the stated panel, load and battery assumptions. A visibility fit does not establish a working radio link or a qualified power system.';
  return <section className={`scenario-comparison ${compact ? 'is-compact' : ''}`} aria-label="Scenario A and B comparison">
    {!compact && <div className="scenario-comparison-heading"><div><span className="eyebrow">EXPLAINED COMPARISON</span><h2>{exact72 ? 'What changes three days later?' : 'Two scenarios. Visible tradeoffs.'}</h2></div><span>{formatDuration(missionDurationHours)} each</span></div>}
    <div className="scenario-comparison-arrivals">{[a, b].map(item => <button key={item.id} type="button" className={item.id === activeScenarioId ? 'is-active' : ''} onClick={() => onActivate(item.id)} aria-pressed={item.id === activeScenarioId}><span className={`scenario-letter scenario-letter--${item.id.toLowerCase()}`}>{item.id}</span><span><strong>{item.siteName}</strong><small>{date.format(Date.parse(item.startUtc))} UTC</small></span><ArrowRight size={14} /></button>)}</div>
    <div className={`scenario-comparison-context ${causeChanges.length ? 'has-other-changes' : ''}`}><Info size={16} /><p>{arrivalExplanation} {changedInputsExplanation}</p></div>
    {waiting && <p className="scenario-comparison-pending" role="status"><CircleNotch size={15} className="loading-spinner" />Scenarios are updating. Previous results are hidden.</p>}
    {!waiting && (!fullVisibility || (ae && be && !fullEnergy)) && <p className="scenario-comparison-partial">One or both mission periods are incomplete or unavailable. Values cover their stated available periods; change columns wait for two complete periods.</p>}
    <div className="scenario-comparison-table-scroll"><table className="scenario-comparison-table"><thead><tr><th aria-label={`Mission measure, ${formatDuration(missionDurationHours)} for each scenario`}>{compact ? `${formatDuration(missionDurationHours)} mission each` : 'Mission measure'}</th><th>A</th><th>B</th><th>Change B − A</th></tr></thead><tbody>{metrics.map(metric => {
      const available = metric.a !== undefined && metric.b !== undefined && Number.isFinite(metric.a) && Number.isFinite(metric.b) && (metric.energy ? fullEnergy : fullVisibility);
      const difference = available ? metric.b! - metric.a! : 0;
      const adverse = available && Math.abs(difference) > 1e-6 && (metric.higherIsBetter ? difference < 0 : difference > 0);
      return <tr key={metric.label}><th>{metric.label}{metric.hint && <small>{metric.hint}</small>}</th><td>{value(metric, metric.a)}</td><td>{value(metric, metric.b)}</td><td className={adverse ? 'is-adverse' : ''}>{available ? metric.delta(difference) : <span className="scenario-comparison-unavailable" aria-label="A complete comparison is not yet available">—</span>}</td></tr>;
    })}</tbody></table></div>
    {fullVisibility && av && bv && <div className="scenario-comparison-outcome">{([['A', av], ['B', bv]] as const).map(([id, result]) => <p key={id}><span className={`scenario-letter scenario-letter--${id.toLowerCase()}`}>{id}</span><span>{result.fits ? 'Meets both modeled horizon-gap limits.' : [result.longestDarkHours > maxDarkHours ? `Solar horizon obstruction exceeds its limit by ${formatDuration(result.longestDarkHours - maxDarkHours)}.` : '', result.longestEarthGapHours > maxEarthGapHours ? `Earth gap exceeds its limit by ${formatDuration(result.longestEarthGapHours - maxEarthGapHours)}.` : ''].filter(Boolean).join(' ')}</span></p>)}</div>}
    {compact ? <details className="scenario-comparison-notes"><summary>Model notes: horizon visibility and energy<Info size={12} /></summary><p className="scenario-comparison-footnote">{modelNote}</p></details> : <p className="scenario-comparison-footnote">{modelNote}</p>}
  </section>;
}
