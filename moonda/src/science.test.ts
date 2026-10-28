import { describe, expect, it } from 'vitest';
import { analyzeSite, findMissionWindow, formatDuration, horizonAt, sampleAt, sampleAtTime, visibilitySegments } from './science';
import type { Mission, Site } from './types';

const start = Date.parse('2026-11-01T00:00:00Z');
const hour = 3_600_000;

function siteWith(options: {
  hours?: number[];
  sunAz?: number[];
  sunEl?: number[];
  earthAz?: number[];
  earthEl?: number[];
  horizon?: number[];
} = {}): Site {
  const hours = options.hours ?? [0, 1, 2];
  return {
    id: 'test-location', name: 'Test location', latitudeDeg: -89, longitudeDeg: 0,
    observerHeightM: 2, description: 'Synthetic test inputs, not a NASA site.',
    horizon: { azimuthStepDeg: 360 / (options.horizon?.length ?? 4), elevationDeg: options.horizon ?? [0, 0, 0, 0], maxRangeKm: 200, terrainResolutionM: 60, method: 'Test fixture' },
    terrain: { size: 1, bounds: { eastMinM: 0, eastMaxM: 0, northMinM: 0, northMaxM: 0 }, heightsM: [0], referenceRadiusM: 1737400 },
    ephemeris: {
      timesUtc: hours.map(value => new Date(start + value * hour).toISOString()),
      sunAzDeg: options.sunAz ?? hours.map(() => 0), sunElDeg: options.sunEl ?? hours.map(() => 1),
      earthAzDeg: options.earthAz ?? hours.map(() => 90), earthElDeg: options.earthEl ?? hours.map(() => 1),
    }, provenance: [], limitations: [],
  };
}

const mission: Mission = { startIndex: 0, durationHours: 2, maxDarkHours: 2, maxEarthGapHours: 2, terrainEnabled: true };

describe('horizon and angle interpolation', () => {
  it('wraps the horizon cyclically and preserves a depressed terrain horizon', () => {
    const site = siteWith({ horizon: [0, 10, -2, 10] });
    expect(horizonAt(site, 359)).toBeCloseTo(10 / 90);
    expect(horizonAt(site, -1)).toBeCloseTo(horizonAt(site, 359));
    expect(horizonAt(site, 180)).toBe(-2);
    expect(horizonAt(site, 90, false)).toBe(0);
  });

  it('interpolates Sun azimuth through north instead of around the long arc', () => {
    const site = siteWith({ hours: [0, 2], sunAz: [359, 1] });
    expect(sampleAt(site, 0.5).sunAz).toBeCloseTo(0);
    expect(sampleAtTime(site, start + hour).sunAz).toBeCloseTo(0);
    expect(sampleAt(site, -10).timeUtc).toBe(new Date(start).toISOString());
  });

  it('accepts a complete profile with a repeated 360 degree endpoint', () => {
    const site = siteWith();
    site.horizon = { ...site.horizon, elevationDeg: [1, 2, 3, 2, 1], azimuthStepDeg: 90 };
    expect(horizonAt(site, 315)).toBeCloseTo(1.5);
  });

  it('does not substitute invented positions for missing data', () => {
    const empty = siteWith({ hours: [] });
    expect(() => sampleAt(empty, 0)).toThrow(/No valid ephemeris/);
    expect(analyzeSite(empty, mission).fits).toBe(false);
    expect(analyzeSite(empty, mission).actualDurationHours).toBe(0);
  });
});

describe('duration-weighted mission analysis', () => {
  it('uses elapsed duration rather than the number of samples on an irregular grid', () => {
    const site = siteWith({ hours: [0, 1, 4], sunEl: [-1, 1, 1] });
    const result = analyzeSite(site, { ...mission, durationHours: 4 });
    expect(result.solarPercent).toBeCloseTo(87.5);
    expect(result.longestDarkHours).toBeCloseTo(0.5);
    expect(result.actualDurationHours).toBe(4);
  });

  it('clips an interval at the exact requested mission end', () => {
    const site = siteWith({ hours: [0, 2], sunEl: [-1, 1] });
    const result = analyzeSite(site, { ...mission, durationHours: 1.5 });
    expect(result.actualDurationHours).toBe(1.5);
    expect(result.solarPercent).toBeCloseTo(100 / 3);
    expect(result.longestDarkHours).toBeCloseTo(1);
    expect(result.samples.at(-1)?.timeUtc).toBe(new Date(start + 1.5 * hour).toISOString());
  });

  it('computes simultaneous visibility from overlapping intervals', () => {
    const site = siteWith({ hours: [0, 2], sunEl: [-1, 1], earthEl: [1, -1] });
    const result = analyzeSite(site, mission);
    expect(result.solarPercent).toBeCloseTo(50);
    expect(result.earthPercent).toBeCloseTo(50);
    expect(result.overlapPercent).toBeCloseTo(0);
    expect(result.longestEarthGapHours).toBeCloseTo(1);
  });

  it('checks terrain knots between ephemeris samples, including a ridge hidden by endpoint flags', () => {
    const site = siteWith({ hours: [0, 2], sunAz: [0, 180], horizon: [0, 4, 0, 0] });
    // The 180 degree ambiguity chooses the western short arc, so use an unambiguous 160 degree path.
    site.ephemeris.sunAzDeg = [10, 170];
    const result = analyzeSite(site, mission);
    expect(result.solarPercent).toBeLessThan(25);
    expect(result.longestDarkHours).toBeGreaterThan(1.5);
  });

  it('does not declare a truncated cache window to satisfy the mission', () => {
    const result = analyzeSite(siteWith(), { ...mission, durationHours: 6 });
    expect(result.actualDurationHours).toBe(2);
    expect(result.solarPercent).toBe(100);
    expect(result.fits).toBe(false);
  });

  it('does not bridge missing angles or mark partial coverage as a fit', () => {
    const site = siteWith({ hours: [0, 1, 2, 3], sunEl: [1, 1, Number.NaN, 1] });
    const result = analyzeSite(site, { ...mission, durationHours: 3 });
    expect(result.actualDurationHours).toBe(1);
    expect(result.fits).toBe(false);
  });

  it('keeps darkness runs continuous across adjacent cache intervals', () => {
    const result = analyzeSite(siteWith({ sunEl: [-1, -1, -1] }), { ...mission, maxDarkHours: 1.5 });
    expect(result.longestDarkHours).toBe(2);
    expect(result.fits).toBe(false);
  });

  it('returns interval boundaries suitable for a timeline and rejects invalid requests', () => {
    const site = siteWith({ hours: [0, 2], sunEl: [-1, 1] });
    const segments = visibilitySegments(site, mission);
    expect(segments).toHaveLength(2);
    expect(segments[0].sunVisible).toBe(false);
    expect(segments[1].sunVisible).toBe(true);
    expect(segments[0].endUtc).toBe(new Date(start + hour).toISOString());
    expect(analyzeSite(site, { ...mission, durationHours: -1 }).fits).toBe(false);
    expect(analyzeSite(site, { ...mission, maxDarkHours: -1 }).fits).toBe(false);
  });
});

describe('duration display', () => {
  it('keeps sub-hour and multi-day durations readable', () => {
    expect(formatDuration(0.5)).toBe('30 min');
    expect(formatDuration(26.5)).toBe('1 d 2 h 30 min');
    expect(formatDuration(-1)).toBe('0 h');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('candidate mission-window search', () => {
  it('searches six elapsed-hour starts on an irregular cache grid', () => {
    const site = siteWith({ hours: [0, 3, 8, 11, 18], sunEl: [-2, -2, -1, 1, 1] });
    const result = findMissionWindow(site, { ...mission, durationHours: 6 });
    expect(result).not.toBeNull();
    expect(result!.stepHours).toBe(6);
    expect(result!.candidatesChecked).toBe(3); // Starts at 0h, 6h, and 12h, not indices 0 and 6.
    expect(sampleAt(site, result!.startIndex).timeUtc).toBe(new Date(start + 12 * hour).toISOString());
    expect(result!.analysis.actualDurationHours).toBe(6);
  });

  it('ranks fitting windows ahead of a brighter window with an excessive darkness gap', () => {
    const hours = Array.from({ length: 13 }, (_, index) => index);
    const site = siteWith({ hours, sunEl: [-1, 1, -1, 1, -1, 1, -1, -1, -1, 10, 10, 10, 10] });
    const request = { ...mission, durationHours: 6, maxDarkHours: 1.1 };
    const later = analyzeSite(site, { ...request, startIndex: 6 });
    const result = findMissionWindow(site, request)!;
    expect(later.solarPercent).toBeGreaterThan(result.analysis.solarPercent);
    expect(later.fits).toBe(false);
    expect(result.analysis.fits).toBe(true);
    expect(result.startIndex).toBe(0);
  });

  it('minimizes normalized constraint exceedance when no candidate fits', () => {
    const hours = Array.from({ length: 13 }, (_, index) => index);
    const site = siteWith({ hours, sunEl: [-1, 1, -1, 1, -1, 1, -1, -1, -1, 10, 10, 10, 10] });
    const result = findMissionWindow(site, { ...mission, durationHours: 6, maxDarkHours: 0 })!;
    expect(result.analysis.fits).toBe(false);
    expect(result.startIndex).toBe(0);
    expect(result.analysis.longestDarkHours).toBe(1);
  });

  it('breaks fitting ties by overlap, then chooses the earliest equal candidate', () => {
    const hours = Array.from({ length: 13 }, (_, index) => index);
    const site = siteWith({ hours, sunEl: [-1, -1, -1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] });
    expect(findMissionWindow(site, { ...mission, durationHours: 6, maxDarkHours: 6 })!.startIndex).toBe(6);
    const allVisible = siteWith({ hours: [0, 6, 12, 18] });
    const tied = findMissionWindow(allVisible, { ...mission, durationHours: 6 })!;
    expect(tied.startIndex).toBe(0);
    expect(tied.candidatesChecked).toBe(3);
  });

  it('returns null when no complete window is available or the request is invalid', () => {
    expect(findMissionWindow(siteWith(), { ...mission, durationHours: 3 })).toBeNull();
    expect(findMissionWindow(siteWith({ hours: [] }), mission)).toBeNull();
    expect(findMissionWindow(siteWith(), mission, 0)).toBeNull();
    expect(findMissionWindow(siteWith(), { ...mission, maxEarthGapHours: -1 })).toBeNull();
    const missing = siteWith({ hours: [0, 1, 2, 3], sunEl: [1, Number.NaN, 1, 1] });
    expect(findMissionWindow(missing, { ...mission, durationHours: 2 })).toBeNull();
  });
});
