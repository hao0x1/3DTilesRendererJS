import type { Mission, ObservatoryData, Site, SiteAnalysis, SkySample } from './types';

const HOUR_MS = 3_600_000;
const EPSILON = 1e-9;

interface Geometry {
  timeMs: number;
  sunAz: number;
  sunEl: number;
  earthAz: number;
  earthEl: number;
}

/** Intervals are estimates from linearly interpolated ephemerides and horizon data. */
export interface VisibilitySegment {
  startUtc: string;
  endUtc: string;
  sunVisible: boolean;
  earthVisible: boolean;
}

export interface MissionWindow {
  startIndex: number;
  analysis: SiteAnalysis;
  candidatesChecked: number;
  stepHours: number;
}

interface WindowResult {
  samples: SkySample[];
  segments: VisibilitySegment[];
  requestedHours: number;
  coveredHours: number;
  complete: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

/** The short angular arc prevents a 359° -> 1° transition crossing 180°. */
function angularDelta(from: number, to: number): number {
  return ((normalizeDegrees(to) - normalizeDegrees(from) + 540) % 360) - 180;
}

function horizonDefinition(site: Site): { values: number[]; step: number; count: number } {
  const values = site.horizon.elevationDeg;
  const step = site.horizon.azimuthStepDeg;
  if (!values.length || !Number.isFinite(step) || step <= 0 || values.some(value => !Number.isFinite(value))) {
    throw new RangeError('The terrain horizon requires a finite, complete azimuth profile.');
  }

  if (values.length === 1) return { values, step: 360, count: 1 };

  // Accept both N samples without 360° and N+1 samples with a closing 360° value.
  const closed = Math.abs(step * (values.length - 1) - 360) < 1e-5;
  const count = closed ? values.length - 1 : values.length;
  if (Math.abs(step * count - 360) > 1e-5) {
    throw new RangeError('The terrain horizon must cover the full 360 degrees.');
  }
  if (closed && Math.abs(values[0] - values[values.length - 1]) > 1e-5) {
    throw new RangeError('The terrain horizon has inconsistent 0 and 360 degree values.');
  }
  return { values, step, count };
}

/** Terrain elevations may be negative; do not clamp a physical horizon to zero. */
export function horizonAt(site: Site, azimuthDeg: number, terrainEnabled = true): number {
  if (!Number.isFinite(azimuthDeg)) throw new RangeError('Azimuth must be finite.');
  if (!terrainEnabled) return 0;
  const { values, step, count } = horizonDefinition(site);
  if (count === 1) return values[0];
  const position = normalizeDegrees(azimuthDeg) / step;
  const lower = Math.floor(position) % count;
  const fraction = position - Math.floor(position);
  const upper = (lower + 1) % count;
  return values[lower] + (values[upper] - values[lower]) * fraction;
}

function timeline(site: Site): number[] {
  const result = site.ephemeris.timesUtc.map(time => Date.parse(time));
  if (result.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= result[index - 1]))) {
    throw new RangeError('Ephemeris timestamps must be finite and strictly increasing.');
  }
  return result;
}

function rowAt(site: Site, times: number[], index: number): Geometry | null {
  const ephemeris = site.ephemeris;
  const row = {
    timeMs: times[index],
    sunAz: ephemeris.sunAzDeg[index],
    sunEl: ephemeris.sunElDeg[index],
    earthAz: ephemeris.earthAzDeg[index],
    earthEl: ephemeris.earthElDeg[index],
  };
  return Object.values(row).every(Number.isFinite) ? row : null;
}

function interpolate(a: Geometry, b: Geometry, fraction: number): Geometry {
  return {
    timeMs: a.timeMs + (b.timeMs - a.timeMs) * fraction,
    sunAz: normalizeDegrees(a.sunAz + angularDelta(a.sunAz, b.sunAz) * fraction),
    sunEl: a.sunEl + (b.sunEl - a.sunEl) * fraction,
    earthAz: normalizeDegrees(a.earthAz + angularDelta(a.earthAz, b.earthAz) * fraction),
    earthEl: a.earthEl + (b.earthEl - a.earthEl) * fraction,
  };
}

function toSkySample(site: Site, geometry: Geometry, terrainEnabled: boolean): SkySample {
  const sunHorizon = horizonAt(site, geometry.sunAz, terrainEnabled);
  const earthHorizon = horizonAt(site, geometry.earthAz, terrainEnabled);
  return {
    timeUtc: new Date(geometry.timeMs).toISOString(),
    sunAz: normalizeDegrees(geometry.sunAz),
    sunEl: geometry.sunEl,
    earthAz: normalizeDegrees(geometry.earthAz),
    earthEl: geometry.earthEl,
    sunHorizon,
    earthHorizon,
    // These flags use body centres, not upper limbs, irradiance, or ground stations.
    sunVisible: geometry.sunEl > sunHorizon,
    earthVisible: geometry.earthEl > earthHorizon,
  };
}

function sampleAtTimeWithTimeline(site: Site, times: number[], timeMs: number, terrainEnabled: boolean): SkySample {
  if (!times.length || !Number.isFinite(timeMs)) throw new RangeError('No valid ephemeris samples are available.');
  const clampedTime = clamp(timeMs, times[0], times[times.length - 1]);
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle] < clampedTime) low = middle + 1;
    else high = middle;
  }
  const upper = low;
  if (times[upper] === clampedTime || upper === 0) {
    const row = rowAt(site, times, upper);
    if (!row) throw new RangeError('The selected ephemeris sample is missing.');
    return toSkySample(site, row, terrainEnabled);
  }
  const a = rowAt(site, times, upper - 1);
  const b = rowAt(site, times, upper);
  if (!a || !b) throw new RangeError('Cannot interpolate across missing ephemeris data.');
  return toSkySample(site, interpolate(a, b, (clampedTime - a.timeMs) / (b.timeMs - a.timeMs)), terrainEnabled);
}

/** Index may be fractional for a smooth UI; outside indices clamp to the cache. */
export function sampleAt(site: Site, index: number, terrainEnabled = true): SkySample {
  const times = timeline(site);
  if (!times.length) throw new RangeError('No valid ephemeris samples are available.');
  const position = clamp(Number.isFinite(index) ? index : 0, 0, times.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, times.length - 1);
  const timeMs = times[lower] + (times[upper] - times[lower]) * (position - lower);
  return sampleAtTimeWithTimeline(site, times, timeMs, terrainEnabled);
}

export function sampleAtTime(site: Site, timeUtcMs: number, terrainEnabled = true): SkySample {
  return sampleAtTimeWithTimeline(site, timeline(site), timeUtcMs, terrainEnabled);
}

/** Horizon knot crossings keep narrow terrain features from disappearing between samples. */
function azimuthKnotFractions(from: number, to: number, step: number): number[] {
  const delta = angularDelta(from, to);
  if (Math.abs(delta) < EPSILON || step >= 360) return [];
  const start = normalizeDegrees(from);
  const end = start + delta;
  const lower = Math.min(start, end);
  const upper = Math.max(start, end);
  const fractions: number[] = [];
  for (let knot = Math.floor(lower / step) + 1; knot * step < upper - EPSILON; knot++) {
    const fraction = (knot * step - start) / delta;
    if (fraction > EPSILON && fraction < 1 - EPSILON) fractions.push(fraction);
  }
  return fractions;
}

function uniqueFractions(values: number[]): number[] {
  return values.sort((a, b) => a - b).filter((value, index, array) => index === 0 || value - array[index - 1] > EPSILON);
}

function clearance(site: Site, row: Geometry, body: 'sun' | 'earth', terrainEnabled: boolean): number {
  return body === 'sun'
    ? row.sunEl - horizonAt(site, row.sunAz, terrainEnabled)
    : row.earthEl - horizonAt(site, row.earthAz, terrainEnabled);
}

function intervalSegments(site: Site, a: Geometry, b: Geometry, terrainEnabled: boolean): VisibilitySegment[] {
  const step = terrainEnabled ? horizonDefinition(site).step : 360;
  const knots = uniqueFractions([
    0,
    ...azimuthKnotFractions(a.sunAz, b.sunAz, step),
    ...azimuthKnotFractions(a.earthAz, b.earthAz, step),
    1,
  ]);
  const crossings = [...knots];
  for (let index = 0; index < knots.length - 1; index++) {
    const left = knots[index];
    const right = knots[index + 1];
    const leftRow = interpolate(a, b, left);
    const rightRow = interpolate(a, b, right);
    for (const body of ['sun', 'earth'] as const) {
      const leftClearance = clearance(site, leftRow, body, terrainEnabled);
      const rightClearance = clearance(site, rightRow, body, terrainEnabled);
      if (leftClearance * rightClearance < 0) {
        crossings.push(left + (right - left) * (-leftClearance / (rightClearance - leftClearance)));
      }
    }
  }

  const partitions = uniqueFractions(crossings);
  return partitions.slice(0, -1).map((left, index) => {
    const right = partitions[index + 1];
    const middle = interpolate(a, b, (left + right) / 2);
    return {
      startUtc: new Date(a.timeMs + (b.timeMs - a.timeMs) * left).toISOString(),
      endUtc: new Date(a.timeMs + (b.timeMs - a.timeMs) * right).toISOString(),
      sunVisible: clearance(site, middle, 'sun', terrainEnabled) > 0,
      earthVisible: clearance(site, middle, 'earth', terrainEnabled) > 0,
    };
  });
}

function calculateWindow(site: Site, mission: Mission): WindowResult {
  const empty = { samples: [], segments: [], requestedHours: 0, coveredHours: 0, complete: false };
  if (!Number.isFinite(mission.durationHours) || mission.durationHours <= 0) return empty;
  let times: number[];
  try {
    times = timeline(site);
    if (mission.terrainEnabled) horizonDefinition(site);
  } catch {
    return empty;
  }
  if (times.length < 2) return empty;

  const startIndex = clamp(Number.isFinite(mission.startIndex) ? mission.startIndex : 0, 0, times.length - 1);
  const lower = Math.floor(startIndex);
  const upper = Math.min(lower + 1, times.length - 1);
  const startMs = times[lower] + (times[upper] - times[lower]) * (startIndex - lower);
  const requestedEndMs = startMs + mission.durationHours * HOUR_MS;
  const endMs = Math.min(requestedEndMs, times[times.length - 1]);
  const segments: VisibilitySegment[] = [];
  const samples: SkySample[] = [];
  let coveredMs = 0;

  for (let index = lower; index < times.length - 1 && times[index] < endMs; index++) {
    const a = rowAt(site, times, index);
    const b = rowAt(site, times, index + 1);
    const intervalStart = Math.max(startMs, times[index]);
    const intervalEnd = Math.min(endMs, times[index + 1]);
    if (!a || !b || intervalEnd <= intervalStart) continue;
    const clippedA = interpolate(a, b, (intervalStart - a.timeMs) / (b.timeMs - a.timeMs));
    const clippedB = interpolate(a, b, (intervalEnd - a.timeMs) / (b.timeMs - a.timeMs));
    const sampleA = toSkySample(site, clippedA, mission.terrainEnabled);
    const sampleB = toSkySample(site, clippedB, mission.terrainEnabled);
    if (!samples.length || samples[samples.length - 1].timeUtc !== sampleA.timeUtc) samples.push(sampleA);
    samples.push(sampleB);
    segments.push(...intervalSegments(site, clippedA, clippedB, mission.terrainEnabled));
    coveredMs += intervalEnd - intervalStart;
  }

  return {
    samples,
    segments,
    requestedHours: mission.durationHours,
    coveredHours: coveredMs / HOUR_MS,
    complete: requestedEndMs <= times[times.length - 1] && Math.abs(coveredMs / HOUR_MS - mission.durationHours) < 1e-6,
  };
}

/** Use these intervals for timeline bars instead of counting coloured sample dots. */
export function visibilitySegments(site: Site, mission: Mission): VisibilitySegment[] {
  return calculateWindow(site, mission).segments;
}

export function analyzeSite(site: Site, mission: Mission): SiteAnalysis {
  const window = calculateWindow(site, mission);
  let solarHours = 0;
  let earthHours = 0;
  let overlapHours = 0;
  let darkRun = 0;
  let earthGapRun = 0;
  let longestDarkHours = 0;
  let longestEarthGapHours = 0;
  let lastEndMs = Number.NaN;
  for (const interval of window.segments) {
    const startMs = Date.parse(interval.startUtc);
    const endMs = Date.parse(interval.endUtc);
    const hours = (endMs - startMs) / HOUR_MS;
    if (!Number.isFinite(lastEndMs) || Math.abs(startMs - lastEndMs) > 2) {
      darkRun = 0;
      earthGapRun = 0;
    }
    if (interval.sunVisible) solarHours += hours;
    if (interval.earthVisible) earthHours += hours;
    if (interval.sunVisible && interval.earthVisible) overlapHours += hours;
    darkRun = interval.sunVisible ? 0 : darkRun + hours;
    earthGapRun = interval.earthVisible ? 0 : earthGapRun + hours;
    longestDarkHours = Math.max(longestDarkHours, darkRun);
    longestEarthGapHours = Math.max(longestEarthGapHours, earthGapRun);
    lastEndMs = endMs;
  }

  const denominator = window.coveredHours;
  const percent = (hours: number) => denominator > 0 ? clamp(100 * hours / denominator, 0, 100) : 0;
  const validLimits = mission.maxDarkHours >= 0 && mission.maxEarthGapHours >= 0;
  return {
    siteId: site.id,
    solarPercent: percent(solarHours),
    earthPercent: percent(earthHours),
    overlapPercent: percent(overlapHours),
    longestDarkHours,
    longestEarthGapHours,
    actualDurationHours: denominator,
    fits: window.complete && validLimits && longestDarkHours <= mission.maxDarkHours + EPSILON && longestEarthGapHours <= mission.maxEarthGapHours + EPSILON,
    samples: window.samples,
  };
}

export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours)) return '—';
  const minutes = Math.max(0, Math.round(hours * 60));
  if (!minutes) return '0 h';
  const days = Math.floor(minutes / 1440);
  const remainingHours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  return [days ? `${days} d` : '', remainingHours ? `${remainingHours} h` : '', remainingMinutes ? `${remainingMinutes} min` : ''].filter(Boolean).join(' ');
}

function indexForTime(times: number[], timeMs: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle] < timeMs) low = middle + 1;
    else high = middle;
  }
  const upper = low;
  if (times[upper] === timeMs || upper === 0) return upper;
  return upper - 1 + (timeMs - times[upper - 1]) / (times[upper] - times[upper - 1]);
}

function normalizedExceedance(analysis: SiteAnalysis, mission: Mission): number {
  // A one-hour floor makes a zero-hour tolerance meaningful without division by zero.
  const excess = (gap: number, limit: number) => limit === Infinity ? 0 : Math.max(0, gap - limit) / Math.max(1, limit);
  return excess(analysis.longestDarkHours, mission.maxDarkHours) + excess(analysis.longestEarthGapHours, mission.maxEarthGapHours);
}

/**
 * Chooses the best complete window among elapsed-time grid starts, not a global optimum.
 * Grid starts are anchored to the cache beginning, independent of array sampling density.
 * Rank: fits; summed normalized limit exceedance; overlap; solar + Earth coverage; earliest.
 */
export function findMissionWindow(site: Site, mission: Mission, stepHours = 6): MissionWindow | null {
  if (!Number.isFinite(stepHours) || stepHours <= 0 || !Number.isFinite(mission.durationHours) || mission.durationHours <= 0 || !(mission.maxDarkHours >= 0) || !(mission.maxEarthGapHours >= 0)) {
    return null;
  }
  let times: number[];
  try {
    times = timeline(site);
  } catch {
    return null;
  }
  if (times.length < 2) return null;
  const stepMs = stepHours * HOUR_MS;
  const lastStartMs = times[times.length - 1] - mission.durationHours * HOUR_MS;
  if (!Number.isFinite(stepMs) || lastStartMs < times[0]) return null;

  let candidatesChecked = 0;
  let best: { startIndex: number; analysis: SiteAnalysis; excess: number } | null = null;
  // An integer grid counter avoids accumulating timestamp drift with fractional steps.
  const count = Math.floor((lastStartMs - times[0]) / stepMs) + 1;
  for (let gridIndex = 0; gridIndex < count; gridIndex++) {
    const startMs = times[0] + gridIndex * stepMs;
    const startIndex = indexForTime(times, startMs);
    const analysis = analyzeSite(site, { ...mission, startIndex });
    candidatesChecked++;
    if (Math.abs(analysis.actualDurationHours - mission.durationHours) > 1e-6) continue;
    const excess = normalizedExceedance(analysis, mission);
    let better = !best;
    if (best) {
      if (analysis.fits !== best.analysis.fits) better = analysis.fits;
      else if (Math.abs(excess - best.excess) > EPSILON) better = excess < best.excess;
      else if (Math.abs(analysis.overlapPercent - best.analysis.overlapPercent) > EPSILON) better = analysis.overlapPercent > best.analysis.overlapPercent;
      else better = analysis.solarPercent + analysis.earthPercent > best.analysis.solarPercent + best.analysis.earthPercent + EPSILON;
      // Equal candidates keep the earlier grid start, since the search is chronological.
    }
    if (better) best = { startIndex, analysis, excess };
  }
  return best ? { startIndex: best.startIndex, analysis: best.analysis, candidatesChecked, stepHours } : null;
}

/** Finds a contrasting example window for the initial UI, not a mission recommendation. */
export function suggestMissionStart(data: ObservatoryData): number {
  const sites = data.sites.filter(site => site.ephemeris.timesUtc.length > 1);
  if (!sites.length) return 0;
  const sourceTimes = sites[0].ephemeris.timesUtc.map(time => Date.parse(time));
  let bestIndex = 0;
  let bestContrast = -Infinity;
  for (let index = 0; index < sourceTimes.length; index += 6) {
    if (sourceTimes[index] + 48 * HOUR_MS > sourceTimes[sourceTimes.length - 1]) break;
    const metrics = sites.flatMap(site => {
      const ownTimes = site.ephemeris.timesUtc;
      const ownIndex = ownTimes.findIndex(time => Date.parse(time) >= sourceTimes[index]);
      if (ownIndex < 0 || Date.parse(ownTimes[ownIndex]) !== sourceTimes[index]) return [];
      return [analyzeSite(site, { startIndex: ownIndex, durationHours: 48, maxDarkHours: 12, maxEarthGapHours: 12, terrainEnabled: true })];
    }).filter(result => result.actualDurationHours >= 48 - EPSILON);
    if (!metrics.length) continue;
    const spread = (key: 'solarPercent' | 'earthPercent' | 'overlapPercent') => Math.max(...metrics.map(result => result[key])) - Math.min(...metrics.map(result => result[key]));
    const contrast = spread('solarPercent') + spread('earthPercent') + spread('overlapPercent');
    if (contrast > bestContrast) {
      bestContrast = contrast;
      bestIndex = index;
    }
  }
  return bestIndex;
}
