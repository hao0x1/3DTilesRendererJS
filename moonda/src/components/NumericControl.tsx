import { useEffect, useId, useRef, useState } from 'react';
import { Minus, Plus } from '@phosphor-icons/react';

export interface NumericControlProps {
  label: string;
  value: number;
  unit?: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  description?: string;
  disabled?: boolean;
}

const displayNumber = (value: number) => String(Number(value.toFixed(6)));

/** Drafts stay local; expensive horizon work starts only after a committed edit. */
export default function NumericControl({ label, value, unit, min, max, step = 1, onChange, description, disabled = false }: NumericControlProps) {
  const id = useId();
  const [draft, setDraft] = useState(displayNumber(value));
  const skipBlur = useRef(false);
  useEffect(() => setDraft(displayNumber(value)), [value]);
  const bounded = (number: number) => Math.min(max, Math.max(min, Math.round(number * 1e6) / 1e6));
  const commit = () => {
    if (skipBlur.current) { skipBlur.current = false; return; }
    const parsed = Number(draft);
    const next = draft.trim() && Number.isFinite(parsed) ? bounded(parsed) : value;
    setDraft(displayNumber(next));
    if (next !== value) onChange(next);
  };
  const adjust = (direction: number) => {
    const parsed = Number(draft);
    const next = bounded((draft.trim() && Number.isFinite(parsed) ? parsed : value) + direction * step);
    setDraft(displayNumber(next));
    if (next !== value) onChange(next);
  };
  return <div className="scenario-number">
    <label className="scenario-number-label" htmlFor={`scenario-number-${id}`}>{label}{unit && <span>{unit}</span>}</label>
    <div className="scenario-number-entry">
      <button type="button" aria-label={`Decrease ${label}`} disabled={disabled || value <= min} onPointerDown={event => event.preventDefault()} onClick={() => adjust(-1)}><Minus size={14} /></button>
      <input id={`scenario-number-${id}`} type="text" inputMode="decimal" role="spinbutton" aria-valuemin={min} aria-valuemax={max} aria-valuenow={draft.trim() && Number.isFinite(Number(draft)) ? Number(draft) : value} aria-describedby={description ? `scenario-number-help-${id}` : undefined} disabled={disabled} value={draft} onChange={event => { if (/^-?\d*(\.\d*)?$/.test(event.target.value)) setDraft(event.target.value); }} onBlur={commit} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); skipBlur.current = true; setDraft(displayNumber(value)); event.currentTarget.blur(); }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); adjust(event.key === 'ArrowUp' ? 1 : -1); }
      }} />
      <button type="button" aria-label={`Increase ${label}`} disabled={disabled || value >= max} onPointerDown={event => event.preventDefault()} onClick={() => adjust(1)}><Plus size={14} /></button>
    </div>
    {description && <small id={`scenario-number-help-${id}`} className="scenario-number-help">{description}</small>}
  </div>;
}
