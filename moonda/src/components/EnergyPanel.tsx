import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CaretDown, CircleNotch, Info, Sun } from '@phosphor-icons/react';
import { DEFAULT_REFERENCE_IRRADIANCE_WM2 } from '../energy';
import type { EnergyModel, EnergyResult } from '../energy';
import EnergyChart from './EnergyChart';
import NumericControl from './NumericControl';
import type { ScenarioId } from './ScenarioWorkspace';

export interface EnergyPanelProps {
  scenarioId: ScenarioId;
  model: EnergyModel;
  result: EnergyResult | null;
  pending?: boolean;
  unavailableReason?: string;
  currentTimeUtc?: string;
  onChange: (model: EnergyModel) => void;
  onSelectTime?: (iso: string) => void;
  sharedAcrossScenarios?: boolean;
}

const number = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const energy = (wh: number) => Math.abs(wh) >= 1000 ? { value: number.format(wh / 1000), unit: 'kWh' } : { value: number.format(wh), unit: 'Wh' };

function OptionalPowerLimit({ label, value, onChange }: { label: string; value?: number; onChange: (value: number | undefined) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    if (!draft.trim()) { if (value !== undefined) onChange(undefined); return; }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < 0) { setDraft(value === undefined ? '' : String(value)); return; }
    if (parsed !== value) onChange(parsed);
  };
  return <div className="energy-optional-limit"><label htmlFor={`energy-limit-${id}`}>{label}<span>W</span></label><input id={`energy-limit-${id}`} type="text" inputMode="decimal" placeholder="Unlimited" value={draft} onChange={event => { if (/^\d*(\.\d*)?$/.test(event.target.value)) setDraft(event.target.value); }} onBlur={commit} onKeyDown={event => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(value === undefined ? '' : String(value)); }
  }} /></div>;
}

function EnergyValue({ label, value, warning = false }: { label: string; value: number; warning?: boolean }) {
  const formatted = energy(value);
  return <div className={`energy-summary-metric ${warning ? 'is-warning' : ''}`}><span>{label}</span><strong>{formatted.value}<small>{formatted.unit}</small></strong></div>;
}

export default function EnergyPanel({ scenarioId, model, result, pending = false, unavailableReason, currentTimeUtc, onChange, onSelectTime, sharedAcrossScenarios = false }: EnergyPanelProps) {
  const resultRegion = useRef<HTMLDivElement>(null);
  const previousResultHeight = useRef(0);
  const [modelNotesOpen, setModelNotesOpen] = useState(false);
  useLayoutEffect(() => {
    const region = resultRegion.current;
    if (!region || pending || !result) return;
    const rememberHeight = () => {
      const height = region.getBoundingClientRect().height;
      if (Number.isFinite(height) && height > 0) previousResultHeight.current = Math.ceil(height);
    };
    rememberHeight();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', rememberHeight);
      return () => window.removeEventListener('resize', rememberHeight);
    }
    const observer = new ResizeObserver(rememberHeight);
    observer.observe(region);
    return () => observer.disconnect();
  }, [pending, result]);
  const patchPanel = (patch: Partial<EnergyModel['panel']>) => onChange({ ...model, panel: { ...model.panel, ...patch } });
  const patchBattery = (patch: Partial<EnergyModel['battery']>) => onChange({ ...model, battery: { ...model.battery, ...patch } });
  const fixed = model.panel.mode === 'fixed';
  const status = !result?.complete ? 'Partial period' : result.unmetLoadWh > 1e-6 ? 'Load shortfall' : result.reserveBreached ? 'Reserve crossed' : 'Load met in this model';
  return <section className="energy-panel" aria-label={`Energy model for scenario ${scenarioId}`}>
    <div className="energy-panel-heading"><div><span className="eyebrow">ILLUSTRATIVE ENERGY BALANCE</span><h2><Sun size={18} />Power through the mission</h2></div><span className={`scenario-letter scenario-letter--${scenarioId.toLowerCase()}`}>{scenarioId}</span></div>
    <p className="energy-model-summary">{number.format(model.panel.areaM2)} m² panel · {number.format(model.panel.efficiency * 100)}% efficiency · {fixed ? 'fixed orientation' : 'Sun tracking'} · {number.format(model.loadW)} W constant load.</p>
    <details className="energy-assumptions"><summary><span>Model assumptions</span><span>{sharedAcrossScenarios ? 'Shared by A & B' : 'Edit'}<CaretDown size={14} /></span></summary>
      <div className="energy-assumption-fields">
        <div className="energy-control-heading"><h3>Solar panel</h3><span>Height comes from the locked scenario</span></div>
        <div className="energy-field-grid"><NumericControl label="Panel area" unit="m²" value={model.panel.areaM2} min={0} max={1e6} step={.5} onChange={areaM2 => patchPanel({ areaM2 })} /><NumericControl label="Conversion efficiency" unit="%" value={model.panel.efficiency * 100} min={0} max={100} step={1} onChange={percent => patchPanel({ efficiency: percent / 100 })} /><NumericControl label="Derating factor" unit="%" value={model.panel.deratingFactor * 100} min={0} max={100} step={1} onChange={percent => patchPanel({ deratingFactor: percent / 100 })} /><NumericControl label="Constant load" unit="W" value={model.loadW} min={0} max={1e9} step={5} onChange={loadW => onChange({ ...model, loadW })} /></div>
        <div className="energy-orientation"><span>Panel orientation</span><div role="group" aria-label="Panel orientation model"><button type="button" aria-pressed={fixed} onClick={() => patchPanel({ mode: 'fixed' })}>Fixed</button><button type="button" aria-pressed={!fixed} onClick={() => patchPanel({ mode: 'sun-tracking' })}>Sun tracking</button></div></div>
        {fixed && <div className="energy-field-grid"><NumericControl label="Panel tilt" unit="°" value={model.panel.tiltDeg} min={0} max={180} step={5} onChange={tiltDeg => patchPanel({ tiltDeg })} description="0° horizontal; 90° vertical." /><NumericControl label="Panel azimuth" unit="°" value={model.panel.azimuthDeg} min={0} max={360} step={5} onChange={azimuthDeg => patchPanel({ azimuthDeg })} description="Clockwise from north." /></div>}
        {!fixed && <p className="energy-control-note">The model points the panel normal toward the Sun. The stated solar-disc and obstruction model determines the direct light reaching it.</p>}
        <div className="energy-control-heading"><h3>Battery</h3><span>Energy stored and delivered</span></div>
        <div className="energy-field-grid"><NumericControl label="Battery capacity" unit="Wh" value={model.battery.capacityWh} min={0} max={1e9} step={100} onChange={capacityWh => patchBattery({ capacityWh, initialChargeWh: Math.min(model.battery.initialChargeWh, capacityWh), reserveWh: Math.min(model.battery.reserveWh, capacityWh) })} /><NumericControl label="Initial charge" unit="Wh" value={model.battery.initialChargeWh} min={0} max={model.battery.capacityWh} step={100} onChange={initialChargeWh => patchBattery({ initialChargeWh })} /><NumericControl label="Reserve threshold" unit="Wh" value={model.battery.reserveWh} min={0} max={model.battery.capacityWh} step={50} onChange={reserveWh => patchBattery({ reserveWh })} /><NumericControl label="Charge efficiency" unit="%" value={model.battery.chargeEfficiency * 100} min={1} max={100} step={1} onChange={percent => patchBattery({ chargeEfficiency: percent / 100 })} /><NumericControl label="Discharge efficiency" unit="%" value={model.battery.dischargeEfficiency * 100} min={1} max={100} step={1} onChange={percent => patchBattery({ dischargeEfficiency: percent / 100 })} /></div>
        <p className="energy-control-note">Initial charge and reserve stay within capacity. Reserve is a warning threshold; it does not stop battery discharge.</p>
        <div className="energy-field-grid"><OptionalPowerLimit label="Maximum charging" value={model.battery.maxChargeW} onChange={maxChargeW => patchBattery({ maxChargeW })} /><OptionalPowerLimit label="Maximum discharging" value={model.battery.maxDischargeW} onChange={maxDischargeW => patchBattery({ maxDischargeW })} /></div>
        <p className="energy-control-note">Blank power limits mean unlimited charging or discharging in this model.</p>
        <NumericControl label="Reference solar irradiance" unit="W/m²" value={model.referenceIrradianceWm2 ?? DEFAULT_REFERENCE_IRRADIANCE_WM2} min={0} max={10000} step={1} onChange={referenceIrradianceWm2 => onChange({ ...model, referenceIrradianceWm2 })} description="Reference at one astronomical unit; the model adjusts for Sun distance." />
      </div>
    </details>
    <div ref={resultRegion} className="energy-results-region" aria-busy={pending} style={{ minHeight: pending && previousResultHeight.current > 0 ? previousResultHeight.current : undefined }}>
    {pending ? <div className="energy-pending" role="status"><CircleNotch size={19} className="loading-spinner" /><div><strong>Updating scenario estimates</strong><p>New results appear after the point, equipment heights and energy balance are calculated.</p></div></div> : !result ? <div className="energy-pending"><Info size={18} /><p>{unavailableReason || 'Energy estimates are unavailable until the locked scenario has a complete horizon calculation.'}</p></div> : <>
      <div className="energy-result-status"><span className={`energy-result-badge ${!result.complete || result.unmetLoadWh > 1e-6 || result.reserveBreached ? 'is-warning' : ''}`}>{status}</span><span>{number.format(result.coveredHours)} hours evaluated</span></div>
      {!result.complete && <p className="energy-partial-note">These estimates cover only the available part of the mission. Choose an earlier arrival or a shorter duration for a complete comparison.</p>}
      <div className="energy-summary-grid"><EnergyValue label="Solar generation" value={result.generatedWh} /><EnergyValue label="Load demand" value={result.loadWh} /><EnergyValue label="Minimum battery" value={result.minBatteryWh} warning={result.reserveBreached} /><EnergyValue label="Unmet load" value={result.unmetLoadWh} warning={result.unmetLoadWh > 1e-6} /></div>
      <EnergyChart points={result.series} generationIntervals={result.intervals} capacityWh={model.battery.capacityWh} reserveWh={model.battery.reserveWh} currentTimeUtc={currentTimeUtc} onSelectTime={onSelectTime} label={`Scenario ${scenarioId} · power and battery`} />
      <details className="energy-model-limits" open={modelNotesOpen} onToggle={event => setModelNotesOpen(event.currentTarget.open)}><summary>How to read these estimates<Info size={13} /></summary><ul>{result.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul><p>These are scenario estimates, not a qualified power-system design.</p></details>
    </>}
    </div>
  </section>;
}
