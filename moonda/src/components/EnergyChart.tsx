import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';

export interface EnergyChartPoint {
  timeUtc: string;
  /** Midpoint power estimate for the preceding interval ending at timeUtc. */
  generationW: number;
  batteryWh: number;
  /** Cumulative unmet load through this sample, in watt-hours. */
  unmetLoadWh: number;
}

export interface EnergyGenerationInterval {
  startUtc: string;
  endUtc: string;
  generationW: number;
}

interface EnergyChartProps {
  points: readonly EnergyChartPoint[];
  generationIntervals?: readonly EnergyGenerationInterval[];
  capacityWh: number;
  reserveWh: number;
  currentTimeUtc?: string;
  onSelectTime?: (iso: string) => void;
  label?: string;
}

interface TimedPoint extends EnergyChartPoint { timestamp: number; segment: number }
interface TimedGenerationInterval { startMs: number; endMs: number; generationW: number }
const number = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat('en', { maximumFractionDigits: 1, notation: 'compact' });
const utc = new Intl.DateTimeFormat('en', { timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function nearestSample(points: readonly TimedPoint[], timestamp: number) {
  if (!points.length || !Number.isFinite(timestamp)) return 0;
  let low = 0, high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && Math.abs(points[low - 1].timestamp - timestamp) <= Math.abs(points[low].timestamp - timestamp)) return low - 1;
  return low;
}

function elapsedLabel(hours: number) {
  if (hours > 0 && hours < 1) return `${number.format(hours * 60)}m`;
  return hours >= 48 ? `${number.format(hours / 24)}d` : `${number.format(hours)}h`;
}

/** Draws actual timestamped energy samples, with no extrapolation past their domain. */
export default function EnergyChart({ points, generationIntervals, capacityWh, reserveWh, currentTimeUtc, onSelectTime, label = 'Mission energy over time' }: EnergyChartProps) {
  const container = useRef<HTMLElement>(null);
  const scrubbing = useRef(false);
  const [width, setWidth] = useState(640);
  const [selectedTimestamp, setSelectedTimestamp] = useState<number | null>(null);
  const id = useId().replace(/:/g, '');
  const sliderId = `energy-time-${id}`;
  const titleId = `energy-title-${id}`;
  const descriptionId = `energy-description-${id}`;

  const samples = useMemo(() => {
    // The runtime guard also handles absent/null samples from an interrupted
    // calculation. Duplicate timestamps resolve to the last complete sample.
    const unique = new Map<number, TimedPoint>();
    let segment = 0;
    for (const point of Array.isArray(points) ? points : []) {
      if (!point || typeof point.timeUtc !== 'string') { segment++; continue; }
      const timestamp = Date.parse(point.timeUtc);
      if (!Number.isFinite(timestamp) || !finiteNonnegative(point.generationW) || !finiteNonnegative(point.batteryWh) || !finiteNonnegative(point.unmetLoadWh)) { segment++; continue; }
      unique.set(timestamp, { ...point, timestamp, segment });
    }
    return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
  }, [points]);

  const suppliedPowerIntervals = useMemo(() => {
    if (generationIntervals === undefined) return null;
    const intervals: TimedGenerationInterval[] = [];
    for (const interval of Array.isArray(generationIntervals) ? generationIntervals : []) {
      if (!interval || !finiteNonnegative(interval.generationW)) continue;
      const startMs = Date.parse(interval.startUtc), endMs = Date.parse(interval.endUtc);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      intervals.push({ startMs, endMs, generationW: interval.generationW });
    }
    return intervals.sort((a, b) => a.startMs - b.startMs);
  }, [generationIntervals]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const next = element.getBoundingClientRect().width;
      if (next >= 180) setWidth(Math.round(next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A linked scene owns the timestamp. Read it in this render so a time or A/B
  // change never paints the previous scenario's cursor before an effect runs.
  const controlledTimestamp = currentTimeUtc ? Date.parse(currentTimeUtc) : NaN;
  const selectedIndex = nearestSample(samples, Number.isFinite(controlledTimestamp) ? controlledTimestamp : selectedTimestamp ?? NaN);
  const selected = samples[selectedIndex];
  const chooseSample = (index: number) => {
    const sample = samples[clamp(Math.round(index), 0, samples.length - 1)];
    if (!sample) return;
    setSelectedTimestamp(sample.timestamp);
    onSelectTime?.(sample.timeUtc);
  };

  if (!selected) return <figure className="energy-chart" ref={container} aria-label={label}>
    <figcaption className="energy-chart-caption">{label}</figcaption>
    <div className="energy-chart-empty" role="status">Energy samples are unavailable for this period.</div>
  </figure>;

  const firstTime = samples[0].timestamp;
  const lastTime = samples[samples.length - 1].timestamp;
  const timeSpan = lastTime - firstTime;
  const left = width < 360 ? 43 : 49;
  const right = width - 16;
  const plotWidth = Math.max(1, right - left);
  const generationTop = 27, generationBottom = 88;
  const batteryTop = 132, batteryBottom = 203;
  const validCapacity = finiteNonnegative(capacityWh) && capacityWh > 0;
  const validReserve = finiteNonnegative(reserveWh);
  const containingInterval = suppliedPowerIntervals?.find(interval => interval.startMs <= selected.timestamp && selected.timestamp < interval.endMs);
  const finalInterval = suppliedPowerIntervals?.at(-1);
  const selectedPower = suppliedPowerIntervals === null ? selected.generationW : containingInterval?.generationW
    ?? (finalInterval?.endMs === selected.timestamp ? finalInterval.generationW : null);
  const selectedPowerDescription = selectedPower === null ? 'interval power unavailable' : `${suppliedPowerIntervals === null ? 'preceding sampled interval power' : 'interval power'} ${number.format(selectedPower)} watts`;
  const powerIntervals = suppliedPowerIntervals === null
    ? samples.flatMap((point, index): TimedGenerationInterval[] => index > 0 && point.segment === samples[index - 1].segment
      ? [{ startMs: samples[index - 1].timestamp, endMs: point.timestamp, generationW: point.generationW }]
      : [])
    : suppliedPowerIntervals.flatMap(interval => {
      const startMs = Math.max(firstTime, interval.startMs), endMs = Math.min(lastTime, interval.endMs);
      return endMs > startMs ? [{ ...interval, startMs, endMs }] : [];
    });
  const generationMax = Math.max(selectedPower ?? 0, samples.reduce((max, point) => Math.max(max, point.generationW), 1), powerIntervals.reduce((max, interval) => Math.max(max, interval.generationW), 1));
  const batteryMax = Math.max(1, validCapacity ? capacityWh : 0, validReserve ? reserveWh : 0, ...samples.map(point => point.batteryWh));
  const xFor = (timestamp: number) => timeSpan > 0 ? left + (timestamp - firstTime) / timeSpan * plotWidth : left + plotWidth / 2;
  const generationY = (value: number) => generationBottom - value / generationMax * (generationBottom - generationTop);
  const batteryY = (value: number) => batteryBottom - value / batteryMax * (batteryBottom - batteryTop);
  let precedingIntervalEnd: number | null = null;
  const generationPath = powerIntervals.map(interval => {
    const y = generationY(interval.generationW).toFixed(2);
    // Power is constant over an explicitly supplied interval (or, for point
    // input, the preceding sample interval). A gap starts a new path.
    const start = precedingIntervalEnd === interval.startMs ? `V${y}` : `M${xFor(interval.startMs).toFixed(2)},${y}`;
    precedingIntervalEnd = interval.endMs;
    return `${start} H${xFor(interval.endMs).toFixed(2)}`;
  }).join(' ');
  const batteryPath = samples.map((point, index) => `${index && point.segment === samples[index - 1].segment ? 'L' : 'M'}${xFor(point.timestamp).toFixed(2)},${batteryY(point.batteryWh).toFixed(2)}`).join(' ');
  const tickCount = width >= 560 ? 5 : 3;
  const ticks = timeSpan > 0 ? Array.from({ length: tickCount }, (_, index) => firstTime + timeSpan * index / (tickCount - 1)) : [firstTime];
  const guideX = xFor(selected.timestamp);
  const sceneTime = currentTimeUtc ? Date.parse(currentTimeUtc) : NaN;
  const sceneOutsideMission = Number.isFinite(sceneTime) && (sceneTime < firstTime || sceneTime > lastTime);

  const selectAtPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const svgX = (event.clientX - bounds.left) / bounds.width * width;
    const fraction = clamp((svgX - left) / plotWidth, 0, 1);
    chooseSample(nearestSample(samples, firstTime + fraction * timeSpan));
  };

  return <figure className="energy-chart" ref={container} aria-labelledby={titleId}>
    <figcaption className="energy-chart-caption"><span id={titleId}>{label}</span><small className="energy-chart-sample-note">{suppliedPowerIntervals === null ? 'Sampled midpoint power' : 'Midpoint power'} · battery states</small></figcaption>
    <div className="energy-chart-readout" aria-live="off">
      <span className="energy-chart-time"><strong>{utc.format(selected.timestamp)}</strong><small>UTC · +{elapsedLabel((selected.timestamp - firstTime) / 3_600_000)}</small></span>
      <span className="energy-chart-metric energy-chart-generation-readout" title={selectedPower === null ? 'No computed power interval contains this timestamp' : suppliedPowerIntervals === null ? 'Midpoint power estimate for the preceding sampled interval' : 'Midpoint power estimate for the model interval containing this timestamp'}><small>Interval power</small><strong>{selectedPower === null ? '—' : number.format(selectedPower)} <span>W</span></strong></span>
      <span className={`energy-chart-metric energy-chart-battery-readout ${validReserve && selected.batteryWh < reserveWh ? 'is-below-reserve' : ''}`}><small>Battery</small><strong>{number.format(selected.batteryWh)} <span>Wh</span></strong></span>
      <span className="energy-chart-metric energy-chart-unmet-readout"><small>Unmet load, cumulative</small><strong>{number.format(selected.unmetLoadWh)} <span>Wh</span></strong></span>
    </div>
    <svg className="energy-chart-svg" width="100%" height="244" viewBox={`0 0 ${width} 244`} role="img" aria-labelledby={titleId} aria-describedby={descriptionId} onPointerDown={event => {
      scrubbing.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      selectAtPointer(event);
    }} onPointerMove={event => { if (scrubbing.current) selectAtPointer(event); }} onPointerUp={() => { scrubbing.current = false; }} onPointerCancel={() => { scrubbing.current = false; }} onLostPointerCapture={() => { scrubbing.current = false; }}>
      <desc id={descriptionId}>Piecewise constant interval power in watts, estimated at interval midpoints, above battery state in watt-hours at sample timestamps. Both plots share elapsed mission time. No power connection is drawn across unavailable intervals. Select a sample by clicking or dragging; the slider below supports keyboard selection.</desc>
      <text x={left} y="13" className="energy-chart-plot-label energy-chart-generation-label" fontSize="11">Interval power · W</text>
      <text x={left} y="116" className="energy-chart-plot-label energy-chart-battery-label" fontSize="11">Battery · Wh</text>
      {[0, .5, 1].map(fraction => <g key={`generation-${fraction}`}>
        <line className="energy-chart-grid" x1={left} x2={right} y1={generationY(generationMax * fraction)} y2={generationY(generationMax * fraction)} />
        <text className="energy-chart-axis" x={left - 8} y={generationY(generationMax * fraction) + 4} textAnchor="end" fontSize="11">{compact.format(generationMax * fraction)}</text>
      </g>)}
      {[0, .5, 1].map(fraction => <g key={`battery-${fraction}`}>
        <line className="energy-chart-grid" x1={left} x2={right} y1={batteryY(batteryMax * fraction)} y2={batteryY(batteryMax * fraction)} />
        <text className="energy-chart-axis" x={left - 8} y={batteryY(batteryMax * fraction) + 4} textAnchor="end" fontSize="11">{compact.format(batteryMax * fraction)}</text>
      </g>)}
      {ticks.map((timestamp, index) => <g key={timestamp}>
        <line className="energy-chart-time-grid" x1={xFor(timestamp)} x2={xFor(timestamp)} y1={generationTop} y2={batteryBottom} />
        <text className="energy-chart-axis" x={xFor(timestamp)} y="225" textAnchor={ticks.length === 1 ? 'middle' : index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'} fontSize="11">+{elapsedLabel((timestamp - firstTime) / 3_600_000)}</text>
      </g>)}
      {validCapacity && <line className="energy-chart-capacity-line" x1={left} x2={right} y1={batteryY(capacityWh)} y2={batteryY(capacityWh)} />}
      {validReserve && <line className="energy-chart-reserve-line" x1={left} x2={right} y1={batteryY(reserveWh)} y2={batteryY(reserveWh)} />}
      <path className="energy-chart-generation-line" d={generationPath} fill="none" />
      <path className="energy-chart-battery-line" d={batteryPath} fill="none" />
      <line className="energy-chart-selection-line" x1={guideX} x2={guideX} y1={generationTop} y2={batteryBottom} />
      {selectedPower !== null && <circle className="energy-chart-generation-point" cx={guideX} cy={generationY(selectedPower)} r="4"><title>{utc.format(selected.timestamp)} UTC: {selectedPowerDescription}, estimated at the interval midpoint</title></circle>}
      <circle className="energy-chart-battery-point" cx={guideX} cy={batteryY(selected.batteryWh)} r="4"><title>{utc.format(selected.timestamp)} UTC: {number.format(selected.batteryWh)} Wh battery</title></circle>
      <text x={right} y="241" className="energy-chart-axis-title" textAnchor="end" fontSize="11">Elapsed mission time</text>
    </svg>
    <label className="sr-only" htmlFor={sliderId}>Select a computed mission energy sample</label>
    <input className="energy-chart-scrubber" id={sliderId} type="range" min="0" max={Math.max(0, samples.length - 1)} step="1" value={selectedIndex} disabled={samples.length < 2} onChange={event => chooseSample(Number(event.target.value))} aria-valuetext={`${utc.format(selected.timestamp)} UTC; ${selectedPowerDescription}; battery ${number.format(selected.batteryWh)} watt-hours${selected.unmetLoadWh > 0 ? `; cumulative unmet load ${number.format(selected.unmetLoadWh)} watt-hours` : ''}`} />
    <div className="energy-chart-legend">{validCapacity && <span><i className="energy-chart-key-capacity" aria-hidden="true" />Capacity {number.format(capacityWh)} Wh</span>}{validReserve && <span><i className="energy-chart-key-reserve" aria-hidden="true" />Reserve {number.format(reserveWh)} Wh</span>}<span className="energy-chart-sample-count">{samples.length} computed {samples.length === 1 ? 'sample' : 'samples'}</span></div>
    {sceneOutsideMission && <p className="energy-chart-domain-note">The scene time is outside this mission. The chart shows its nearest computed sample.</p>}
  </figure>;
}
