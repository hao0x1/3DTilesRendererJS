/** Transparent, assumption-based electrical energy estimates. Units are W, Wh and hours. */
export const DEFAULT_REFERENCE_IRRADIANCE_WM2 = 1361;
export const DEFAULT_SOLAR_DISC_RAYS = 512;

export interface PanelModel {
  areaM2: number;
  efficiency: number;
  deratingFactor: number;
  mode: 'fixed' | 'sun-tracking';
  /** Tilt of the panel plane from the local horizontal: 0 faces up, 90 is vertical. */
  tiltDeg: number;
  /** Bearing of the panel normal, clockwise from local north. */
  azimuthDeg: number;
}

export interface BatteryModel {
  capacityWh: number;
  initialChargeWh: number;
  /** Warning threshold, not an artificial discharge stop. */
  reserveWh: number;
  chargeEfficiency: number;
  dischargeEfficiency: number;
  /** Maximum power entering the battery from the electrical bus. */
  maxChargeW?: number;
  /** Maximum battery power delivered to the electrical bus. */
  maxDischargeW?: number;
}

export interface EnergyModel {
  panel: PanelModel;
  battery: BatteryModel;
  loadW: number;
  referenceIrradianceWm2?: number;
}

export interface SolarPowerInterval {
  startUtc: string;
  endUtc: string;
  sunAzDeg: number;
  sunElDeg: number;
  sunVisible: boolean;
  sunDistanceAu?: number;
  /** Combined finite-disc occlusion AND panel incidence, normalized to normal-plane irradiance. */
  effectiveIncidenceFactor?: number;
}

export interface EnergyPoint {
  timeUtc: string;
  /** Power held over the preceding interval; use EnergyResult.intervals for a step chart. */
  generationW: number;
  batteryWh: number;
  /** Cumulative requested bus-load energy that was not supplied. */
  unmetLoadWh: number;
}

export interface EnergyIntervalResult {
  startUtc: string;
  endUtc: string;
  generationW: number;
  batteryStartWh: number;
  batteryEndWh: number;
  generatedWh: number;
  suppliedLoadWh: number;
  unmetLoadWh: number;
  spilledWh: number;
  chargeLossWh: number;
  dischargeLossWh: number;
}

export interface EnergyResult {
  complete: boolean;
  coveredHours: number;
  generatedWh: number;
  loadWh: number;
  suppliedLoadWh: number;
  unmetLoadWh: number;
  spilledWh: number;
  chargeLossWh: number;
  dischargeLossWh: number;
  endingBatteryWh: number;
  minBatteryWh: number;
  reserveBreached: boolean;
  energyConservationErrorWh: number;
  assumptions: string[];
  series: EnergyPoint[];
  intervals: EnergyIntervalResult[];
}

export interface EnergyWindow {
  startUtc: string;
  endUtc: string;
}

export interface FiniteSolarDiscInput {
  sunAzDeg: number;
  sunElDeg: number;
  sunAngularRadiusDeg: number;
  /** Earth geometry must be measured from the SOLAR PANEL receiver, not the antenna. */
  earthAzDeg: number;
  earthElDeg: number;
  earthAngularRadiusDeg: number;
  horizonAtAzimuth: (azimuthDeg: number) => number;
  panel: Pick<PanelModel, 'mode' | 'tiltDeg' | 'azimuthDeg'>;
  rayCount?: number;
}

export interface FiniteSolarDiscResult {
  effectiveIncidenceFactor: number;
  visibleDiscFraction: number;
  terrainBlockedFraction: number;
  earthBlockedFraction: number;
  combinedBlockedFraction: number;
  rayCount: number;
}

type Vector = [number, number, number];
const HOUR_MS = 3_600_000;
const RAD = Math.PI / 180;
const EPS = 1e-9;

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function nonnegative(value: number, label: string): void {
  finite(value, label);
  if (value < 0) throw new RangeError(`${label} cannot be negative.`);
}

function fraction(value: number, label: string, allowZero = true): void {
  finite(value, label);
  if (value > 1 || (allowZero ? value < 0 : value <= 0)) throw new RangeError(`${label} must be ${allowZero ? 'between 0 and 1' : 'greater than 0 and at most 1'}.`);
}

function direction(azimuthDeg: number, elevationDeg: number): Vector {
  const az = azimuthDeg * RAD;
  const el = elevationDeg * RAD;
  // Local east, north, up.
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
}

function dot(a: Vector, b: Vector): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function cross(a: Vector, b: Vector): Vector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(a: Vector): Vector {
  const norm = Math.hypot(...a);
  return [a[0] / norm, a[1] / norm, a[2] / norm];
}

function panelNormal(panel: Pick<PanelModel, 'mode' | 'tiltDeg' | 'azimuthDeg'>, sun: Vector): Vector {
  return panel.mode === 'sun-tracking' ? sun : direction(panel.azimuthDeg, 90 - panel.tiltDeg);
}

/** The same local ENU unit normal used by both power paths, for physical scene orientation. */
export function panelNormalEnu(panel: Pick<PanelModel, 'mode' | 'tiltDeg' | 'azimuthDeg'>, sunAzDeg: number, sunElDeg: number): { east: number; north: number; up: number } {
  for (const [label, value] of Object.entries({ tiltDeg: panel.tiltDeg, azimuthDeg: panel.azimuthDeg, sunAzDeg, sunElDeg })) finite(value, label);
  const [east, north, up] = panelNormal(panel, direction(sunAzDeg, sunElDeg));
  return { east, north, up };
}

/**
 * Uniform-brightness solar-disc quadrature. Each ray is masked by the UNION of
 * terrain and the opaque spherical Earth; independent visible fractions are not multiplied.
 * Limb darkening, Earth's atmosphere, scattered light and physical panel self-shadowing are excluded.
 */
export function finiteSolarDisc(input: FiniteSolarDiscInput): FiniteSolarDiscResult {
  for (const [label, value] of Object.entries({ sunAzDeg: input.sunAzDeg, sunElDeg: input.sunElDeg, sunAngularRadiusDeg: input.sunAngularRadiusDeg, earthAzDeg: input.earthAzDeg, earthElDeg: input.earthElDeg, earthAngularRadiusDeg: input.earthAngularRadiusDeg, tiltDeg: input.panel.tiltDeg, azimuthDeg: input.panel.azimuthDeg })) finite(value, label);
  if (input.sunAngularRadiusDeg < 0 || input.sunAngularRadiusDeg >= 90 || input.earthAngularRadiusDeg < 0 || input.earthAngularRadiusDeg >= 90) throw new RangeError('Angular disc radii must be at least zero and less than 90 degrees.');
  const requestedRays = input.rayCount ?? DEFAULT_SOLAR_DISC_RAYS;
  if (!Number.isInteger(requestedRays) || requestedRays < 1 || requestedRays > 16384) throw new RangeError('rayCount must be an integer from 1 through 16384.');
  const sun = direction(input.sunAzDeg, input.sunElDeg);
  const earth = direction(input.earthAzDeg, input.earthElDeg);
  const normal = panelNormal(input.panel, sun);
  const basisX = unit(cross(Math.abs(sun[2]) < 0.99 ? [0, 0, 1] : [0, 1, 0], sun));
  const basisY = cross(sun, basisX);
  const sineRadius = Math.sin(input.sunAngularRadiusDeg * RAD);
  const earthLimb = Math.cos(input.earthAngularRadiusDeg * RAD);
  let visible = 0;
  let terrainBlocked = 0;
  let earthBlocked = 0;
  let incidence = 0;

  for (let index = 0; index < requestedRays; index++) {
    // Uniform area in the Sun-normal projected disc, with deterministic golden-angle sampling.
    const radial = Math.sqrt((index + 0.5) / requestedRays) * sineRadius;
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    const x = radial * Math.cos(angle);
    const y = radial * Math.sin(angle);
    const axial = Math.sqrt(Math.max(0, 1 - radial * radial));
    const ray: Vector = [0, 1, 2].map(axis => sun[axis] * axial + basisX[axis] * x + basisY[axis] * y) as Vector;
    const azimuth = ((Math.atan2(ray[0], ray[1]) / RAD) % 360 + 360) % 360;
    const elevation = Math.asin(Math.max(-1, Math.min(1, ray[2]))) / RAD;
    const horizon = input.horizonAtAzimuth(azimuth);
    finite(horizon, 'Terrain horizon');
    const blockedByTerrain = elevation <= horizon;
    const blockedByEarth = input.earthAngularRadiusDeg > 0 && dot(ray, earth) >= earthLimb;
    if (blockedByTerrain) terrainBlocked++;
    if (blockedByEarth) earthBlocked++;
    if (!blockedByTerrain && !blockedByEarth) {
      visible++;
      // Projected-disc sampling already includes cos(ray, Sun). Divide it out to
      // integrate a differently oriented panel against the same normal irradiance.
      incidence += Math.max(0, dot(normal, ray)) / axial;
    }
  }
  return {
    effectiveIncidenceFactor: incidence / requestedRays,
    visibleDiscFraction: visible / requestedRays,
    terrainBlockedFraction: terrainBlocked / requestedRays,
    earthBlockedFraction: earthBlocked / requestedRays,
    combinedBlockedFraction: 1 - visible / requestedRays,
    rayCount: requestedRays,
  };
}

function validateModel(model: EnergyModel): void {
  nonnegative(model.panel.areaM2, 'Panel area');
  fraction(model.panel.efficiency, 'Panel efficiency');
  fraction(model.panel.deratingFactor, 'Panel derating factor');
  finite(model.panel.tiltDeg, 'Panel tilt');
  finite(model.panel.azimuthDeg, 'Panel azimuth');
  if (model.panel.tiltDeg < 0 || model.panel.tiltDeg > 180) throw new RangeError('Panel tilt must be between 0 and 180 degrees.');
  if (!['fixed', 'sun-tracking'].includes(model.panel.mode)) throw new RangeError('Unknown solar panel mode.');
  nonnegative(model.battery.capacityWh, 'Battery capacity');
  nonnegative(model.battery.initialChargeWh, 'Initial battery charge');
  nonnegative(model.battery.reserveWh, 'Battery reserve');
  if (model.battery.initialChargeWh > model.battery.capacityWh || model.battery.reserveWh > model.battery.capacityWh) throw new RangeError('Initial charge and reserve cannot exceed capacity.');
  fraction(model.battery.chargeEfficiency, 'Charge efficiency', false);
  fraction(model.battery.dischargeEfficiency, 'Discharge efficiency', false);
  if (model.battery.maxChargeW !== undefined) nonnegative(model.battery.maxChargeW, 'Charge power limit');
  if (model.battery.maxDischargeW !== undefined) nonnegative(model.battery.maxDischargeW, 'Discharge power limit');
  nonnegative(model.loadW, 'Electrical load');
  nonnegative(model.referenceIrradianceWm2 ?? DEFAULT_REFERENCE_IRRADIANCE_WM2, 'Reference irradiance');
}

export function panelGenerationW(input: SolarPowerInterval, model: EnergyModel): number {
  validateModel(model);
  finite(input.sunAzDeg, 'Sun azimuth');
  finite(input.sunElDeg, 'Sun elevation');
  const distance = input.sunDistanceAu ?? 1;
  if (!Number.isFinite(distance) || distance <= 0) throw new RangeError('Sun distance must be positive in AU.');
  let incidence: number;
  if (input.effectiveIncidenceFactor !== undefined) {
    nonnegative(input.effectiveIncidenceFactor, 'Effective incidence factor');
    if (input.effectiveIncidenceFactor > 1.01) throw new RangeError('Effective incidence factor is outside the supported solar-disc range.');
    incidence = input.effectiveIncidenceFactor;
  } else {
    const sun = direction(input.sunAzDeg, input.sunElDeg);
    incidence = input.sunVisible ? Math.max(0, dot(panelNormal(model.panel, sun), sun)) : 0;
  }
  return (model.referenceIrradianceWm2 ?? DEFAULT_REFERENCE_IRRADIANCE_WM2) / (distance * distance) * model.panel.areaM2 * model.panel.efficiency * model.panel.deratingFactor * incidence;
}

/**
 * Integrates piecewise-constant generation supplied at interval midpoints.
 * Missing/overlapping coverage is rejected; it is not converted into invented zero generation.
 */
export function estimateEnergy(inputs: SolarPowerInterval[], model: EnergyModel, window?: EnergyWindow): EnergyResult {
  validateModel(model);
  if (!inputs.length) throw new RangeError('Energy estimation requires complete solar interval coverage.');
  for (const input of inputs) {
    const start = Date.parse(input.startUtc);
    const end = Date.parse(input.endUtc);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new RangeError('Solar intervals require finite, increasing UTC bounds.');
  }
  const startMs = Date.parse(window?.startUtc ?? inputs[0].startUtc);
  const endMs = Date.parse(window?.endUtc ?? inputs[inputs.length - 1].endUtc);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new RangeError('Energy window must have finite, increasing UTC bounds.');
  const clipped = inputs.map(input => ({ input, start: Math.max(startMs, Date.parse(input.startUtc)), end: Math.min(endMs, Date.parse(input.endUtc)) })).filter(interval => interval.end > interval.start);
  let cursor = startMs;
  for (const interval of clipped) {
    if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || Math.abs(interval.start - cursor) > 1) throw new RangeError('Solar intervals must cover the energy window without gaps or overlaps.');
    cursor = interval.end;
  }
  if (Math.abs(cursor - endMs) > 1) throw new RangeError('Solar intervals do not cover the complete energy window.');
  let batteryWh = model.battery.initialChargeWh;
  let generatedWh = 0;
  let suppliedLoadWh = 0;
  let unmetLoadWh = 0;
  let spilledWh = 0;
  let chargeLossWh = 0;
  let dischargeLossWh = 0;
  let minBatteryWh = batteryWh;
  const intervals: EnergyIntervalResult[] = [];
  const series: EnergyPoint[] = [{ timeUtc: new Date(startMs).toISOString(), generationW: panelGenerationW(clipped[0].input, model), batteryWh, unmetLoadWh: 0 }];

  for (const { input, start, end } of clipped) {
    const hours = (end - start) / HOUR_MS;
    const generationW = panelGenerationW(input, model);
    const generation = generationW * hours;
    const demand = model.loadW * hours;
    const before = batteryWh;
    const interval: EnergyIntervalResult = { startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), generationW, batteryStartWh: before, batteryEndWh: before, generatedWh: generation, suppliedLoadWh: demand, unmetLoadWh: 0, spilledWh: 0, chargeLossWh: 0, dischargeLossWh: 0 };
    let changeEvent: EnergyPoint | null = null;
    if (generationW >= model.loadW) {
      const surplusW = generationW - model.loadW;
      const chargingW = Math.min(surplusW, model.battery.maxChargeW ?? Infinity);
      const acceptedInputWh = Math.min(chargingW * hours, Math.max(0, model.battery.capacityWh - before) / model.battery.chargeEfficiency);
      batteryWh = Math.min(model.battery.capacityWh, before + acceptedInputWh * model.battery.chargeEfficiency);
      interval.chargeLossWh = acceptedInputWh * (1 - model.battery.chargeEfficiency);
      interval.spilledWh = Math.max(0, surplusW * hours - acceptedInputWh);
      if (chargingW > 0) {
        const fullHours = (model.battery.capacityWh - before) / (chargingW * model.battery.chargeEfficiency);
        if (fullHours > EPS && fullHours < hours - EPS) changeEvent = { timeUtc: new Date(start + fullHours * HOUR_MS).toISOString(), generationW, batteryWh: model.battery.capacityWh, unmetLoadWh };
      }
    } else {
      const deficitW = model.loadW - generationW;
      const dischargingW = Math.min(deficitW, model.battery.maxDischargeW ?? Infinity);
      const deliveredWh = Math.min(dischargingW * hours, before * model.battery.dischargeEfficiency);
      const withdrawnWh = deliveredWh / model.battery.dischargeEfficiency;
      batteryWh = Math.max(0, before - withdrawnWh);
      interval.dischargeLossWh = withdrawnWh - deliveredWh;
      interval.unmetLoadWh = Math.max(0, deficitW * hours - deliveredWh);
      interval.suppliedLoadWh = demand - interval.unmetLoadWh;
      if (dischargingW > 0) {
        const emptyHours = before * model.battery.dischargeEfficiency / dischargingW;
        if (emptyHours > EPS && emptyHours < hours - EPS) changeEvent = { timeUtc: new Date(start + emptyHours * HOUR_MS).toISOString(), generationW, batteryWh: 0, unmetLoadWh: unmetLoadWh + (deficitW - dischargingW) * emptyHours };
      }
    }
    interval.batteryEndWh = batteryWh;
    generatedWh += generation;
    suppliedLoadWh += interval.suppliedLoadWh;
    unmetLoadWh += interval.unmetLoadWh;
    spilledWh += interval.spilledWh;
    chargeLossWh += interval.chargeLossWh;
    dischargeLossWh += interval.dischargeLossWh;
    minBatteryWh = Math.min(minBatteryWh, batteryWh);
    intervals.push(interval);
    if (changeEvent) series.push(changeEvent);
    series.push({ timeUtc: new Date(end).toISOString(), generationW, batteryWh, unmetLoadWh });
  }
  const assumptions = [
    'An illustrative electrical energy balance, not a flight-qualified survival assessment.',
    'Constant user-specified electrical load, efficiency, derating and battery efficiencies; thermal control, degradation, dust and physical lander self-shadowing are not dynamically modeled.',
    model.panel.mode === 'sun-tracking' ? 'Ideal two-axis Sun tracking without slew, articulation or tracking-power limits.' : 'Fixed panel tilt and azimuth in the locked solar receiver local tangent frame.',
    'Reserve is a warning threshold; discharge continues toward zero and unmet load is reported explicitly.',
    `Reference solar irradiance is ${model.referenceIrradianceWm2 ?? DEFAULT_REFERENCE_IRRADIANCE_WM2} W/m² at 1 AU.`,
    clipped.every(({ input }) => input.sunDistanceAu !== undefined) ? 'Solar intensity varies with supplied Sun distance using inverse-square scaling.' : 'At least part of the window assumes a Sun distance of 1 AU.',
    clipped.every(({ input }) => input.effectiveIncidenceFactor !== undefined) ? 'Generation uses supplied combined solar-disc obstruction and per-ray panel-incidence factors; inspect the scenario mask method.' : 'At least part of the window uses rough binary Sun-centre visibility and centre-ray incidence; partial-disc and eclipse behavior are not established for those intervals.',
    'Power is held constant within each supplied integration interval.',
  ];
  return {
    complete: true,
    coveredHours: (endMs - startMs) / HOUR_MS,
    generatedWh,
    loadWh: model.loadW * (endMs - startMs) / HOUR_MS,
    suppliedLoadWh,
    unmetLoadWh,
    spilledWh,
    chargeLossWh,
    dischargeLossWh,
    endingBatteryWh: batteryWh,
    minBatteryWh,
    reserveBreached: minBatteryWh < model.battery.reserveWh - EPS,
    energyConservationErrorWh: model.battery.initialChargeWh + generatedWh - batteryWh - suppliedLoadWh - spilledWh - chargeLossWh - dischargeLossWh,
    assumptions,
    series,
    intervals,
  };
}
