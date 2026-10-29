import { analyzeSite, horizonAt, indexForTime, sampleAtTime, visibilitySegments } from './science';
import type { VisibilitySegment } from './science';
import { DEFAULT_SOLAR_DISC_RAYS, estimateEnergy, finiteSolarDisc } from './energy';
import type { EnergyModel, EnergyResult, SolarPowerInterval } from './energy';
import type { Site, SiteAnalysis, SkySample } from './types';

export interface ScenarioDefinition {
  id: string;
  regionId: string;
  pointId: string;
  startUtc: string;
  durationHours: number;
  panelHeightM: number;
  antennaHeightM: number;
  maxDarkHours: number;
  maxEarthGapHours: number;
  terrainEnabled: boolean;
}

export type ScenarioConfig = ScenarioDefinition;

/** All quantities in this block are measured at the SOLAR PANEL receiver. */
export interface ScenarioBodyGeometry {
  timesUtc: string[];
  sunDistanceAu: number[];
  sunAngularRadiusDeg: number[];
  earthAngularRadiusDeg: number[];
  sunRangeM?: number[];
  earthRangeM?: number[];
}

/** Each prepared request has its own UTC axis; A and B do not share array indices. */
export interface PreparedScenario {
  scenarioId: string;
  regionId: string;
  pointId: string;
  latitudeDeg: number;
  longitudeDeg: number;
  surfaceElevationM: number;
  modelVersion: string;
  panelSite: Site;
  antennaSite: Site;
  bodyGeometry: ScenarioBodyGeometry;
}

export interface ScenarioAnalysis {
  scenarioId: string;
  pointId: string;
  regionId: string;
  startUtc: string;
  endUtc: string;
  status: 'complete' | 'invalid' | 'unsupported' | 'incomplete';
  message: string | null;
  visibility: SiteAnalysis | null;
  energy: EnergyResult | null;
  assumptions: string[];
  visibilitySegments: VisibilitySegment[];
}

export interface ScenarioAnalysisOptions {
  /** Solar power quadrature only; source geometry retains its own documented cadence. */
  maxEnergyStepMinutes?: number;
  solarDiscRays?: number;
}

export const DEFAULT_ENERGY_STEP_MINUTES = 1;

export interface ScenarioComparison {
  a: ScenarioAnalysis;
  b: ScenarioAnalysis;
  bothComplete: boolean;
  /** Every delta is B minus A; no scalar "best landing site" score is manufactured. */
  delta: {
    solarPercent: number;
    earthPercent: number;
    overlapPercent: number;
    longestDarkHours: number;
    longestEarthGapHours: number;
    generatedWh: number | null;
    minBatteryWh: number | null;
    unmetLoadWh: number | null;
  } | null;
}

const HOUR_MS = 3_600_000;
const EPS = 1e-7;

function parseUtc(value: string): number {
  const time = Date.parse(value);
  if (!/Z$/i.test(value) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new RangeError('Use a valid ISO UTC timestamp ending in Z.');
  }
  return time;
}

function sameLongitude(a: number, b: number): boolean {
  const normalizedA = ((a % 360) + 360) % 360;
  const normalizedB = ((b % 360) + 360) % 360;
  return Math.abs(((normalizedA - normalizedB + 540) % 360) - 180) < EPS;
}

function requirePreparedPoint(prepared: PreparedScenario, scenario?: ScenarioDefinition): void {
  if (!Number.isFinite(prepared.latitudeDeg) || !Number.isFinite(prepared.longitudeDeg) || !Number.isFinite(prepared.surfaceElevationM)) throw new RangeError('Prepared point coordinates and elevation must be finite.');
  if (!prepared.modelVersion) throw new RangeError('Prepared geometry must identify its model version.');
  for (const site of [prepared.panelSite, prepared.antennaSite]) {
    if (![site.latitudeDeg, site.longitudeDeg, site.observerHeightM].every(Number.isFinite)) throw new RangeError('Component point and receiver height must be finite.');
    if (Math.abs(site.latitudeDeg - prepared.latitudeDeg) > EPS || !sameLongitude(site.longitudeDeg, prepared.longitudeDeg)) throw new RangeError('Component geometry belongs to a different landing point.');
  }
  if (scenario && (prepared.scenarioId !== scenario.id || prepared.regionId !== scenario.regionId || prepared.pointId !== scenario.pointId)) throw new RangeError('Prepared geometry belongs to a different scenario or point.');
  if (scenario && (Math.abs(prepared.panelSite.observerHeightM - scenario.panelHeightM) > EPS || Math.abs(prepared.antennaSite.observerHeightM - scenario.antennaHeightM) > EPS)) throw new RangeError('Receiver height changed; prepare new component horizons and geometry before analysis.');
}

function validateSiteAxis(site: Site): number[] {
  const axis = site.ephemeris.timesUtc.map(parseUtc);
  if (axis.length < 2 || axis.some((time, index) => index > 0 && time <= axis[index - 1])) throw new RangeError('Component geometry requires an increasing UTC axis.');
  for (const values of [site.ephemeris.sunAzDeg, site.ephemeris.sunElDeg, site.ephemeris.earthAzDeg, site.ephemeris.earthElDeg]) {
    if (values.length !== axis.length || values.some(value => !Number.isFinite(value))) throw new RangeError('Component ephemeris coverage is incomplete.');
  }
  return axis;
}

function requireCoverage(prepared: PreparedScenario, startMs: number, endMs: number): number[] {
  const panel = validateSiteAxis(prepared.panelSite);
  const antenna = validateSiteAxis(prepared.antennaSite);
  if (panel.length !== antenna.length || panel.some((time, index) => time !== antenna[index])) throw new RangeError('Panel and antenna geometry must use a shared UTC axis within a scenario.');
  if (startMs < panel[0] || endMs > panel[panel.length - 1]) throw new RangeError('Requested mission extends outside prepared date coverage; prepare that exact window.');
  return panel;
}

/** A physically coherent view of both sky bodies at one selected receiver height. */
export function componentSamplesAtTime(prepared: PreparedScenario, timeUtcMs: number, terrainEnabled = true): { panel: SkySample; antenna: SkySample; combined: SkySample } {
  if (!Number.isFinite(timeUtcMs)) throw new RangeError('Requested sky time must be a finite UTC instant.');
  requirePreparedPoint(prepared);
  requireCoverage(prepared, timeUtcMs, timeUtcMs);
  const panel = sampleAtTime(prepared.panelSite, timeUtcMs, terrainEnabled);
  const antenna = sampleAtTime(prepared.antennaSite, timeUtcMs, terrainEnabled);
  return {
    panel,
    antenna,
    // Suitable for separate numerical cards, not a single-height 3D observer view.
    combined: { ...panel, earthAz: antenna.earthAz, earthEl: antenna.earthEl, earthHorizon: antenna.earthHorizon, earthVisible: antenna.earthVisible },
  };
}

export function sampleScenarioAt(prepared: PreparedScenario, timeUtcMs: number, terrainEnabled = true): SkySample {
  return componentSamplesAtTime(prepared, timeUtcMs, terrainEnabled).combined;
}

function missionFor(site: Site, startMs: number, scenario: ScenarioDefinition) {
  return {
    startIndex: indexForTime(site.ephemeris.timesUtc.map(parseUtc), startMs),
    durationHours: scenario.durationHours,
    maxDarkHours: scenario.maxDarkHours,
    maxEarthGapHours: scenario.maxEarthGapHours,
    terrainEnabled: scenario.terrainEnabled,
  };
}

/** Sun visibility comes from the panel receiver; Earth visibility from the antenna receiver. */
export function scenarioVisibilitySegments(prepared: PreparedScenario, scenario: ScenarioDefinition): VisibilitySegment[] {
  const startMs = parseUtc(scenario.startUtc);
  requirePreparedPoint(prepared, scenario);
  requireCoverage(prepared, startMs, startMs + scenario.durationHours * HOUR_MS);
  const solar = visibilitySegments(prepared.panelSite, missionFor(prepared.panelSite, startMs, scenario));
  const earth = visibilitySegments(prepared.antennaSite, missionFor(prepared.antennaSite, startMs, scenario));
  const result: VisibilitySegment[] = [];
  let solarIndex = 0;
  let earthIndex = 0;
  while (solarIndex < solar.length && earthIndex < earth.length) {
    const a = solar[solarIndex];
    const b = earth[earthIndex];
    const aEnd = Date.parse(a.endUtc);
    const bEnd = Date.parse(b.endUtc);
    const start = Math.max(Date.parse(a.startUtc), Date.parse(b.startUtc));
    const end = Math.min(aEnd, bEnd);
    if (end > start) result.push({ startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), sunVisible: a.sunVisible, earthVisible: b.earthVisible });
    if (aEnd <= bEnd) solarIndex++;
    if (bEnd <= aEnd) earthIndex++;
  }
  return result;
}

function validateBodyGeometry(prepared: PreparedScenario, times: number[]): void {
  const geometry = prepared.bodyGeometry;
  if (geometry.timesUtc.length !== times.length || geometry.timesUtc.some((time, index) => parseUtc(time) !== times[index])) throw new RangeError('Solar-body metadata does not match the panel receiver UTC axis.');
  for (const values of [geometry.sunDistanceAu, geometry.sunAngularRadiusDeg, geometry.earthAngularRadiusDeg]) {
    if (values.length !== times.length || values.some(value => !Number.isFinite(value) || value <= 0)) throw new RangeError('Energy estimation requires real Sun range and Sun/Earth angular-radius coverage.');
  }
}

function bodyAtTime(prepared: PreparedScenario, times: number[], timeMs: number): { sunDistanceAu: number; sunAngularRadiusDeg: number; earthAngularRadiusDeg: number } {
  const index = indexForTime(times, timeMs);
  const lower = Math.floor(index);
  const upper = Math.min(lower + 1, times.length - 1);
  const fraction = index - lower;
  const interpolate = (values: number[]) => values[lower] + (values[upper] - values[lower]) * fraction;
  return { sunDistanceAu: interpolate(prepared.bodyGeometry.sunDistanceAu), sunAngularRadiusDeg: interpolate(prepared.bodyGeometry.sunAngularRadiusDeg), earthAngularRadiusDeg: interpolate(prepared.bodyGeometry.earthAngularRadiusDeg) };
}

function panelAnglesAtTime(prepared: PreparedScenario, times: number[], timeMs: number) {
  const index = indexForTime(times, timeMs);
  const lower = Math.floor(index);
  const upper = Math.min(lower + 1, times.length - 1);
  const fraction = index - lower;
  const ephemeris = prepared.panelSite.ephemeris;
  const linear = (values: number[]) => values[lower] + (values[upper] - values[lower]) * fraction;
  const angle = (values: number[]) => {
    const from = ((values[lower] % 360) + 360) % 360;
    const to = ((values[upper] % 360) + 360) % 360;
    return ((from + (((to - from + 540) % 360) - 180) * fraction) % 360 + 360) % 360;
  };
  return { sunAz: angle(ephemeris.sunAzDeg), sunEl: linear(ephemeris.sunElDeg), earthAz: angle(ephemeris.earthAzDeg), earthEl: linear(ephemeris.earthElDeg) };
}

function horizonSampler(site: Site, enabled: boolean): (azimuth: number) => number {
  // Validate once, then avoid revalidating hundreds of elevations for every solar-disc ray.
  horizonAt(site, 0, enabled);
  if (!enabled) return () => 0;
  const values = site.horizon.elevationDeg;
  const step = site.horizon.azimuthStepDeg;
  if (values.length === 1) return () => values[0];
  const closed = Math.abs(step * (values.length - 1) - 360) < 1e-5;
  const count = closed ? values.length - 1 : values.length;
  return azimuth => {
    const position = (((azimuth % 360) + 360) % 360) / step;
    const lower = Math.floor(position) % count;
    const fraction = position - Math.floor(position);
    return values[lower] + (values[(lower + 1) % count] - values[lower]) * fraction;
  };
}

function solarPowerIntervals(prepared: PreparedScenario, scenario: ScenarioDefinition, model: EnergyModel, times: number[], options: ScenarioAnalysisOptions): SolarPowerInterval[] {
  validateBodyGeometry(prepared, times);
  const stepMinutes = options.maxEnergyStepMinutes ?? DEFAULT_ENERGY_STEP_MINUTES;
  if (!Number.isFinite(stepMinutes) || stepMinutes <= 0) throw new RangeError('Energy integration step must be positive minutes.');
  const start = parseUtc(scenario.startUtc);
  const end = start + scenario.durationHours * HOUR_MS;
  const sampleBounds = [start, ...times.filter(time => time > start && time < end), end];
  const terrain = horizonSampler(prepared.panelSite, scenario.terrainEnabled);
  const intervals: SolarPowerInterval[] = [];
  for (let index = 0; index < sampleBounds.length - 1; index++) {
    const left = sampleBounds[index];
    const right = sampleBounds[index + 1];
    const steps = Math.max(1, Math.ceil((right - left) / (stepMinutes * 60_000)));
    for (let step = 0; step < steps; step++) {
      const segmentStart = left + (right - left) * step / steps;
      const segmentEnd = left + (right - left) * (step + 1) / steps;
      const middle = (segmentStart + segmentEnd) / 2;
      const sky = panelAnglesAtTime(prepared, times, middle);
      const body = bodyAtTime(prepared, times, middle);
      const disc = finiteSolarDisc({
        sunAzDeg: sky.sunAz, sunElDeg: sky.sunEl, sunAngularRadiusDeg: body.sunAngularRadiusDeg,
        earthAzDeg: sky.earthAz, earthElDeg: sky.earthEl, earthAngularRadiusDeg: body.earthAngularRadiusDeg,
        horizonAtAzimuth: terrain, panel: model.panel, rayCount: options.solarDiscRays ?? DEFAULT_SOLAR_DISC_RAYS,
      });
      intervals.push({ startUtc: new Date(segmentStart).toISOString(), endUtc: new Date(segmentEnd).toISOString(), sunAzDeg: sky.sunAz, sunElDeg: sky.sunEl, sunVisible: sky.sunEl > terrain(sky.sunAz), sunDistanceAu: body.sunDistanceAu, effectiveIncidenceFactor: disc.effectiveIncidenceFactor });
    }
  }
  return intervals;
}

/** A/B configuration uses exact UTC times; it never recycles one scenario's sample indices. */
export function analyzeScenario(prepared: PreparedScenario, scenario: ScenarioDefinition, energyModel?: EnergyModel, options: ScenarioAnalysisOptions = {}): ScenarioAnalysis {
  const result: ScenarioAnalysis = {
    scenarioId: scenario.id, pointId: scenario.pointId, regionId: scenario.regionId,
    startUtc: scenario.startUtc, endUtc: '', status: 'invalid', message: null,
    visibility: null, energy: null, visibilitySegments: [], assumptions: [],
  };
  let startMs: number;
  let endMs: number;
  try {
    startMs = parseUtc(scenario.startUtc);
    if (!Number.isFinite(scenario.durationHours) || scenario.durationHours <= 0 || !Number.isFinite(scenario.panelHeightM) || scenario.panelHeightM < 0 || !Number.isFinite(scenario.antennaHeightM) || scenario.antennaHeightM < 0 || !(scenario.maxDarkHours >= 0) || !(scenario.maxEarthGapHours >= 0)) throw new RangeError('Mission duration, receiver heights and gap limits must be valid nonnegative quantities.');
    endMs = startMs + scenario.durationHours * HOUR_MS;
    result.endUtc = new Date(endMs).toISOString();
  } catch (error) {
    result.message = error instanceof Error ? error.message : 'Invalid scenario request.';
    return result;
  }
  try {
    requirePreparedPoint(prepared, scenario);
  } catch (error) {
    result.status = 'unsupported';
    result.message = error instanceof Error ? error.message : 'Scenario geometry does not match the request.';
    return result;
  }
  let times: number[];
  try {
    times = requireCoverage(prepared, startMs, endMs);
    const solar = analyzeSite(prepared.panelSite, missionFor(prepared.panelSite, startMs, scenario));
    const earth = analyzeSite(prepared.antennaSite, missionFor(prepared.antennaSite, startMs, scenario));
    if (Math.abs(solar.actualDurationHours - scenario.durationHours) > EPS || Math.abs(earth.actualDurationHours - scenario.durationHours) > EPS) throw new RangeError('Prepared geometry does not cover the complete mission.');
    const segments = scenarioVisibilitySegments(prepared, scenario);
    const overlapHours = segments.reduce((total, segment) => total + (segment.sunVisible && segment.earthVisible ? (Date.parse(segment.endUtc) - Date.parse(segment.startUtc)) / HOUR_MS : 0), 0);
    const antennaSamples = new Map(earth.samples.map(sample => [sample.timeUtc, sample]));
    const samples = solar.samples.map(panel => {
      const antenna = antennaSamples.get(panel.timeUtc);
      if (!antenna) throw new RangeError('Receiver samples are not aligned on their shared UTC axis.');
      return { ...panel, earthAz: antenna.earthAz, earthEl: antenna.earthEl, earthHorizon: antenna.earthHorizon, earthVisible: antenna.earthVisible };
    });
    result.visibilitySegments = segments;
    result.visibility = {
      siteId: prepared.pointId,
      solarPercent: solar.solarPercent,
      earthPercent: earth.earthPercent,
      overlapPercent: 100 * overlapHours / scenario.durationHours,
      longestDarkHours: solar.longestDarkHours,
      longestEarthGapHours: earth.longestEarthGapHours,
      actualDurationHours: scenario.durationHours,
      fits: solar.longestDarkHours <= scenario.maxDarkHours + EPS && earth.longestEarthGapHours <= scenario.maxEarthGapHours + EPS,
      samples,
    };
    result.status = 'complete';
    result.assumptions = [
      'Sun-centre horizon clearance uses the solar-panel receiver and its height-specific terrain horizon; Earth-centre horizon clearance uses the antenna receiver and its separate horizon.',
      'Sun horizon-clearance percentages, terrain-obstruction gaps and their fit constraints exclude Earth eclipses; the energy estimate separately includes opaque-Earth solar occultation.',
      'Visibility timelines describe body centres, not guaranteed solar power or an operational ground-station radio link.',
      `Prepared science model: ${prepared.modelVersion}.`,
      ...prepared.panelSite.limitations,
      ...prepared.antennaSite.limitations,
    ];
  } catch (error) {
    result.status = 'incomplete';
    result.message = error instanceof Error ? error.message : 'Mission data coverage is incomplete.';
    return result;
  }
  if (energyModel) {
    try {
      const intervals = solarPowerIntervals(prepared, scenario, energyModel, times, options);
      result.energy = estimateEnergy(intervals, energyModel, { startUtc: scenario.startUtc, endUtc: result.endUtc });
      result.energy.assumptions.push(
        `Uniform-brightness finite Sun disc, ${options.solarDiscRays ?? DEFAULT_SOLAR_DISC_RAYS} deterministic rays; terrain and opaque spherical Earth masks are combined per ray. Earth's atmosphere and solar limb darkening are excluded.`,
        `Midpoint energy integration at no more than ${options.maxEnergyStepMinutes ?? DEFAULT_ENERGY_STEP_MINUTES} minutes; this does not increase the source ephemeris or terrain resolution.`,
        'The power estimate uses partial-disc illumination; the visibility timeline separately uses Sun-centre visibility.',
      );
    } catch (error) {
      result.status = 'incomplete';
      result.message = error instanceof Error ? error.message : 'Energy estimation is unsupported for the supplied geometry.';
    }
  }
  return result;
}

/** Clones all scientific settings; only the scenario ID and arrival UTC change. */
export function delayedScenario(base: ScenarioDefinition, delayHours = 72, id = 'B'): ScenarioDefinition {
  if (!Number.isFinite(delayHours)) throw new RangeError('Arrival delay must be finite elapsed hours.');
  return { ...base, id, startUtc: new Date(parseUtc(base.startUtc) + delayHours * HOUR_MS).toISOString() };
}

/** A single shared EnergyModel keeps A/B equipment assumptions identical. */
export function compareScenarios(preparedA: PreparedScenario, scenarioA: ScenarioDefinition, preparedB: PreparedScenario, scenarioB: ScenarioDefinition, sharedEnergyModel?: EnergyModel, options: ScenarioAnalysisOptions = {}): ScenarioComparison {
  const a = analyzeScenario(preparedA, scenarioA, sharedEnergyModel, options);
  const b = analyzeScenario(preparedB, scenarioB, sharedEnergyModel, options);
  const bothComplete = a.status === 'complete' && b.status === 'complete';
  return {
    a, b, bothComplete,
    delta: bothComplete && a.visibility && b.visibility ? {
      solarPercent: b.visibility.solarPercent - a.visibility.solarPercent,
      earthPercent: b.visibility.earthPercent - a.visibility.earthPercent,
      overlapPercent: b.visibility.overlapPercent - a.visibility.overlapPercent,
      longestDarkHours: b.visibility.longestDarkHours - a.visibility.longestDarkHours,
      longestEarthGapHours: b.visibility.longestEarthGapHours - a.visibility.longestEarthGapHours,
      generatedWh: a.energy && b.energy ? b.energy.generatedWh - a.energy.generatedWh : null,
      minBatteryWh: a.energy && b.energy ? b.energy.minBatteryWh - a.energy.minBatteryWh : null,
      unmetLoadWh: a.energy && b.energy ? b.energy.unmetLoadWh - a.energy.unmetLoadWh : null,
    } : null,
  };
}
