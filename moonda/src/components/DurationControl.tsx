import { useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus } from '@phosphor-icons/react';

interface DurationControlProps {
  value: number;
  max: number;
  onChange: (hours: number) => void;
}

const presets = [24, 48, 72, 168, 336];
const labelFor = (hours: number) => hours >= 168 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;

export default function DurationControl({ value, max, onChange }: DurationControlProps) {
  const [draft, setDraft] = useState(String(value));
  const skipNextBlur = useRef(false);
  const id = useId();
  const upperBound = Math.max(1, max);
  const bounded = (hours: number) => Math.min(upperBound, Math.max(1, Math.round(hours * 100) / 100));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    if (skipNextBlur.current) { skipNextBlur.current = false; return; }
    const number = Number(draft);
    const next = draft.trim() !== '' && Number.isFinite(number) ? bounded(number) : bounded(value);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  const step = (amount: number) => {
    const number = Number(draft);
    const next = bounded((draft.trim() !== '' && Number.isFinite(number) ? number : value) + amount);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return <div className="duration-control" role="group" aria-label="Mission duration">
    <div className="duration-presets">{presets.filter(hours => hours <= upperBound).map(hours => <button type="button" key={hours} className={value === hours ? 'is-selected' : ''} aria-label={`Set mission duration to ${hours} hours`} aria-pressed={value === hours} onClick={() => { setDraft(String(hours)); onChange(hours); }}>{labelFor(hours)}</button>)}</div>
    <div className="duration-entry"><button type="button" className="duration-step" aria-label="Decrease mission duration by one hour" disabled={value <= 1} onPointerDown={event => event.preventDefault()} onClick={() => step(-1)}><Minus size={16} /></button><label className="sr-only" htmlFor={`duration-hours-${id}`}>Mission duration in hours</label><input id={`duration-hours-${id}`} type="text" inputMode="decimal" role="spinbutton" aria-valuemin={1} aria-valuemax={upperBound} aria-valuenow={Number.isFinite(Number(draft)) && draft !== '' ? Number(draft) : value} value={draft} onChange={event => { if (/^\d*(\.\d*)?$/.test(event.target.value)) setDraft(event.target.value); }} onBlur={commit} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); skipNextBlur.current = true; setDraft(String(value)); event.currentTarget.blur(); }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); step(event.key === 'ArrowUp' ? 1 : -1); }
    }} /><span className="duration-unit" aria-hidden="true">hours</span><button type="button" className="duration-step" aria-label="Increase mission duration by one hour" disabled={value >= upperBound} onPointerDown={event => event.preventDefault()} onClick={() => step(1)}><Plus size={16} /></button></div>
  </div>;
}
