import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent } from 'react';
import { CalendarBlank, CaretLeft, CaretRight, Check, X } from '@phosphor-icons/react';

interface UTCDateTimePickerProps {
  value: string;
  min: string;
  max: string;
  onChange: (value: string) => void;
}

const DAY = 86_400_000;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const dayOf = (ms: number) => {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};
const monthOf = (ms: number) => {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};
const shiftMonth = (ms: number, amount: number) => {
  const date = new Date(ms);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount + 1, 0)).getUTCDate();
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, Math.min(date.getUTCDate(), lastDay));
};
const fullDate = new Intl.DateTimeFormat('en', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const shortDate = new Intl.DateTimeFormat('en', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
const monthLabel = new Intl.DateTimeFormat('en', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const timeLabel = new Intl.DateTimeFormat('en', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const padded = (value: number) => String(value).padStart(2, '0');
const focusableSelector = 'button, input, select, textarea, a[href], summary, [tabindex], [contenteditable="true"]';
const tabbableElements = (container: ParentNode) => Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
  .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible')
  .sort((a, b) => (a.tabIndex || Number.MAX_SAFE_INTEGER) - (b.tabIndex || Number.MAX_SAFE_INTEGER));

export default function UTCDateTimePicker({ value, min, max, onChange }: UTCDateTimePickerProps) {
  const minimum = Date.parse(min);
  const maximum = Math.max(minimum, Date.parse(max));
  const selected = clamp(Date.parse(value), minimum, maximum);
  const minimumDay = dayOf(minimum);
  const maximumDay = dayOf(maximum);
  const [open, setOpen] = useState(false);
  const [draftDay, setDraftDay] = useState(dayOf(selected));
  const [focusedDay, setFocusedDay] = useState(dayOf(selected));
  const [viewMonth, setViewMonth] = useState(monthOf(selected));
  const [hours, setHours] = useState(padded(new Date(selected).getUTCHours()));
  const [minutes, setMinutes] = useState(padded(new Date(selected).getUTCMinutes()));
  const [position, setPosition] = useState({ left: 12, top: 12, width: 312 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const dayButtons = useRef(new Map<number, HTMLButtonElement>());
  const needsDayFocus = useRef(false);
  const id = useId();
  const dialogId = `utc-dialog-${id}`;
  const headingId = `utc-heading-${id}`;
  const helpId = `utc-help-${id}`;

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  const handlePopoverTab = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = popover.current;
    const anchor = trigger.current;
    if (!open || event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || !panel || !anchor) return;
    const controls = tabbableElements(panel);
    const atFirst = document.activeElement === controls[0];
    const atLast = document.activeElement === controls[controls.length - 1];
    if (!(event.shiftKey ? atFirst : atLast)) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      // The popup follows its trigger in the logical form order, even though
      // its portal is physically the last child of document.body.
      close(true);
      return;
    }
    const pageControls = tabbableElements(document).filter(element => !panel.contains(element));
    const anchorIndex = pageControls.indexOf(anchor);
    const next = anchorIndex < 0 ? undefined : pageControls[anchorIndex + 1];
    close();
    // Continue through the form; returning to the trigger is a safe fallback
    // when the picker itself is the last control in the document.
    (next ?? anchor).focus();
  };

  const show = () => {
    const date = new Date(selected);
    setDraftDay(dayOf(selected));
    setFocusedDay(dayOf(selected));
    setViewMonth(monthOf(selected));
    setHours(padded(date.getUTCHours()));
    setMinutes(padded(date.getUTCMinutes()));
    needsDayFocus.current = true;
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !popover.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const placePopover = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const panel = popover.current;
      if (!anchor || !panel) return;
      const width = Math.min(312, window.innerWidth - 24);
      const height = Math.min(panel.offsetHeight, window.innerHeight - 24);
      const below = window.innerHeight - anchor.bottom - 12;
      const above = anchor.top - 12;
      const preferredTop = below >= height || below >= above ? anchor.bottom + 8 : anchor.top - height - 8;
      setPosition({
        left: clamp(anchor.left, 12, window.innerWidth - width - 12),
        top: clamp(preferredTop, 12, window.innerHeight - height - 12),
        width,
      });
    };
    placePopover();
    window.addEventListener('resize', placePopover);
    document.addEventListener('scroll', placePopover, true);
    return () => {
      window.removeEventListener('resize', placePopover);
      document.removeEventListener('scroll', placePopover, true);
    };
  }, [open, viewMonth]);

  useEffect(() => {
    if (!open || !needsDayFocus.current) return;
    needsDayFocus.current = false;
    dayButtons.current.get(focusedDay)?.focus();
  }, [open, focusedDay, viewMonth]);

  const focusDay = (day: number) => {
    const bounded = clamp(day, minimumDay, maximumDay);
    needsDayFocus.current = true;
    setFocusedDay(bounded);
    setViewMonth(monthOf(bounded));
    // A boundary key may keep the same date, so it cannot rely on a render.
    if (bounded === focusedDay && monthOf(bounded) === viewMonth) {
      dayButtons.current.get(bounded)?.focus();
      needsDayFocus.current = false;
    }
  };

  const handleDayKey = (event: KeyboardEvent<HTMLButtonElement>, day: number) => {
    let next: number | undefined;
    switch (event.key) {
      case 'ArrowLeft': next = day - DAY; break;
      case 'ArrowRight': next = day + DAY; break;
      case 'ArrowUp': next = day - DAY * 7; break;
      case 'ArrowDown': next = day + DAY * 7; break;
      case 'Home': next = day - new Date(day).getUTCDay() * DAY; break;
      case 'End': next = day + (6 - new Date(day).getUTCDay()) * DAY; break;
      case 'PageUp': next = shiftMonth(day, event.shiftKey ? -12 : -1); break;
      case 'PageDown': next = shiftMonth(day, event.shiftKey ? 12 : 1); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    focusDay(next);
  };

  const changeMonth = (amount: number) => {
    const next = clamp(shiftMonth(focusedDay, amount), minimumDay, maximumDay);
    setFocusedDay(next);
    setViewMonth(monthOf(next));
  };

  const adjustTime = (event: KeyboardEvent<HTMLInputElement>, current: string, limit: number, set: (value: string) => void) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const parsed = Number(current);
    set(padded(clamp((Number.isFinite(parsed) ? parsed : 0) + (event.key === 'ArrowUp' ? 1 : -1), 0, limit)));
  };

  const apply = () => {
    const date = new Date(draftDay);
    const hour = clamp(Number(hours) || 0, 0, 23);
    const minute = clamp(Number(minutes) || 0, 0, 59);
    const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
    onChange(new Date(clamp(next, minimum, maximum)).toISOString());
    close(true);
  };

  const firstGridDay = viewMonth - new Date(viewMonth).getUTCDay() * DAY;
  const days = Array.from({ length: 42 }, (_, index) => firstGridDay + index * DAY);
  const previousMonth = shiftMonth(viewMonth, -1);
  const nextMonth = shiftMonth(viewMonth, 1);
  const canPrevious = monthOf(previousMonth) >= monthOf(minimum);
  const canNext = monthOf(nextMonth) <= monthOf(maximum);

  return <div className="utc-picker" ref={root} onBlur={event => {
    if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && !popover.current?.contains(event.relatedTarget)) close();
  }} onKeyDown={event => {
    handlePopoverTab(event);
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }}>
    <button ref={trigger} type="button" className={`date-trigger ${open ? 'is-open' : ''}`} aria-label={`Mission start: ${shortDate.format(selected)}, ${timeLabel.format(selected)} UTC. Change date and time.`} aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId} onClick={() => open ? close() : show()}>
      <CalendarBlank size={18} /><span className="date-trigger-date">{shortDate.format(selected)}</span><span className="date-trigger-time">{timeLabel.format(selected)} <small>UTC</small></span>
    </button>
    {open && createPortal(<div id={dialogId} ref={popover} role="dialog" aria-labelledby={headingId} aria-describedby={helpId} className="utc-popover" style={{ position: 'fixed', ...position, maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100dvh - 24px)', overflowY: 'auto', zIndex: 100 }}>
      <form onSubmit={event => { event.preventDefault(); apply(); }}>
        <div className="utc-popover-heading"><span id={headingId}>Mission start · UTC</span><button type="button" className="utc-close icon-button" aria-label="Close date picker" onClick={() => close(true)}><X size={17} /></button></div>
        <div className="utc-month-nav"><button type="button" className="utc-month-button icon-button" aria-label="Previous month" disabled={!canPrevious} onClick={() => changeMonth(-1)}><CaretLeft size={17} /></button><strong aria-live="polite">{monthLabel.format(viewMonth)}</strong><button type="button" className="utc-month-button icon-button" aria-label="Next month" disabled={!canNext} onClick={() => changeMonth(1)}><CaretRight size={17} /></button></div>
        <div className="utc-calendar" role="grid" aria-label={monthLabel.format(viewMonth)}>
          <div className="utc-weekdays" role="row">{weekdays.map((name, index) => <span role="columnheader" aria-label={weekdayNames[index]} key={index}>{name}</span>)}</div>
          {Array.from({ length: 6 }, (_, row) => <div className="utc-week" role="row" key={row}>{days.slice(row * 7, row * 7 + 7).map(day => {
            const outside = monthOf(day) !== viewMonth;
            const disabled = day < minimumDay || day > maximumDay;
            return <button key={day} ref={element => { if (element) dayButtons.current.set(day, element); else dayButtons.current.delete(day); }} type="button" role="gridcell" className={`utc-day ${outside ? 'is-outside' : ''} ${day === draftDay ? 'is-selected' : ''}`} aria-label={fullDate.format(day)} aria-selected={day === draftDay} disabled={disabled} tabIndex={day === focusedDay ? 0 : -1} onKeyDown={event => handleDayKey(event, day)} onFocus={() => setFocusedDay(day)} onClick={() => { setDraftDay(day); setFocusedDay(day); if (outside) { needsDayFocus.current = true; setViewMonth(monthOf(day)); } }}>{new Date(day).getUTCDate()}</button>;
          })}</div>)}
        </div>
        <div className="utc-time-row"><span className="utc-time-label">Time</span><div className="utc-time-fields"><label className="sr-only" htmlFor={`utc-hour-${id}`}>Hour, UTC</label><input id={`utc-hour-${id}`} className="utc-time-input" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={2} value={hours} onChange={event => setHours(event.target.value.replace(/\D/g, '').slice(0, 2))} onBlur={() => setHours(padded(clamp(Number(hours) || 0, 0, 23)))} onKeyDown={event => adjustTime(event, hours, 23, setHours)} aria-label="Hour, UTC, 0 to 23" /><span aria-hidden="true">:</span><label className="sr-only" htmlFor={`utc-minute-${id}`}>Minute, UTC</label><input id={`utc-minute-${id}`} className="utc-time-input" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={2} value={minutes} onChange={event => setMinutes(event.target.value.replace(/\D/g, '').slice(0, 2))} onBlur={() => setMinutes(padded(clamp(Number(minutes) || 0, 0, 59)))} onKeyDown={event => adjustTime(event, minutes, 59, setMinutes)} aria-label="Minute, UTC, 0 to 59" /><small>UTC</small></div></div>
        <p className="utc-range-hint" id={helpId}>Cached dates: {shortDate.format(minimum)} – {shortDate.format(maximum)}. Arrow keys move between days. Times interpolate between hourly NASA samples.</p>
        <div className="utc-actions"><button type="button" className="utc-cancel" onClick={() => close(true)}>Cancel</button><button type="submit" className="utc-apply"><Check size={16} />Apply date</button></div>
      </form>
    </div>, document.body)}
  </div>;
}
