import type { Ephemeris, Site, Terrain } from './types';
import type { PreparedScenario as AnalysisPreparedScenario } from './scenarios';

const DEG = Math.PI / 180;
const AU_M = 149_597_870_700;
const SUN_RADIUS_M = 695_700_000;
const EARTH_RADIUS_M = 6_378_137;
const DEFAULT_RADIUS_M = 1_737_400;

export interface ScenarioPoint {
  regionId: string;
  eastM: number;
  northM: number;
  panelHeightM: number;
  antennaHeightM: number;
}

export interface ScenarioRequest {
  scenarioId?: string;
  pointId?: string;
  point: ScenarioPoint;
  startUtc: string;
  endUtc: string;
  cadenceMinutes?: number;
  azimuthStepDeg?: number;
}

export interface DataChunk {
  url: string;
  rowStart?: number;
  rowCount?: number;
  encoding?: 'gzip' | 'identity';
  byteLength?: number;
  uncompressedBytes?: number;
  sha256?: string;
  uncompressedSha256?: string;
}

export interface RasterDescriptor extends Partial<DataChunk> {
  dtype: 'int16-le' | 'float32-le';
  width: number;
  height: number;
  /** Pixel-corner affine: x=a*column+b*row+c; y=d*column+e*row+f. */
  affine: [number, number, number, number, number, number];
  scale: number;
  offsetM: number;
  nodata?: number | 'NaN' | null;
  validProjectedRadiusM?: number;
  chunks?: DataChunk[];
  sourceUrl?: string;
  source?: { title?: string; url?: string; detail?: string };
}

export interface ScenarioRegion {
  id: string;
  name: string;
  origin: { latitudeDeg: number; longitudeDeg: number; surfaceHeightM?: number };
  supportedDomain: {
    type: 'azimuthal-equidistant-square';
    bounds: { eastMinM: number; eastMaxM: number; northMinM: number; northMaxM: number };
  };
  nearRaster: RasterDescriptor;
  source?: { title?: string; url?: string; detail?: string };
}

export interface ScenarioManifest {
  schemaVersion: number;
  frame: string;
  referenceRadiusM: number;
  heightDatum: string;
  modelVersion?: string;
  dataHash?: string;
  regions: Record<string, ScenarioRegion>;
  farField: RasterDescriptor;
  ephemeris?: string | { url: string };
  ephemerisManifestUrl?: string;
  horizonSampling?: {
    radialIntervals: { fromM: number; toExclusiveM?: number; toInclusiveM?: number; stepM: number }[];
    observerHeightRangeM?: { min: number; max: number };
  };
  [key: string]: unknown;
}

export interface EphemerisManifest {
  frame: string;
  startUtc: string;
  endUtc: string;
  stepSeconds: number;
  stride: number;
  dtype: 'float64-le';
  epochsUtc: string[];
  chunks: DataChunk[];
  correction?: string;
  [key: string]: unknown;
}

export interface LoadedRaster {
  descriptor: RasterDescriptor;
  values: Int16Array | Float32Array;
}

export interface VectorState {
  position: [number, number, number];
  velocity: [number, number, number];
}

export interface ScenarioEphemeris extends Ephemeris {
  sunRangeM: number[];
  earthRangeM: number[];
  sunAngularRadiusDeg: number[];
  earthAngularRadiusDeg: number[];
  sunEarthSeparationDeg: number[];
}

export interface ScenarioQuality {
  horizonStepDeg: number;
  rangeM: number;
  nearNativeResolutionM: number;
  farNativeResolutionM: number;
  radialSampling: string;
  radialCoarseningMaxDeltaDeg: number;
  angularCoarseningMaxDeltaDeg: number;
  halfStepCheckMaxDeltaDeg: number;
  halfStepCheckBearings: number;
  note: string;
}

export interface PreparedScenario extends AnalysisPreparedScenario {
  pointId: string;
  pointKey: string;
  point: ScenarioPoint;
  regionId: string;
  latitudeDeg: number;
  longitudeDeg: number;
  surfaceElevationM: number;
  surfaceHeightM: number;
  modelVersion: string;
  panelSite: Site & { ephemeris: ScenarioEphemeris };
  antennaSite: Site & { ephemeris: ScenarioEphemeris };
  bodyGeometry: {
    timesUtc: string[];
    sunDistanceAu: number[];
    sunRangeM: number[];
    earthRangeM: number[];
    antennaEarthRangeM: number[];
    sunAngularRadiusDeg: number[];
    earthAngularRadiusDeg: number[];
    sunEarthSeparationDeg: number[];
  };
  coverage: {
    startUtc: string;
    endUtc: string;
    cacheStartUtc: string;
    cacheEndUtc: string;
    cadenceMinutes: number;
    complete: true;
    frame: string;
  };
  provenance: Site['provenance'];
  quality: ScenarioQuality;
}

export type ScenarioProgress = { stage: 'data' | 'horizon' | 'ephemeris'; fraction: number; message: string };
export interface PreparationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ScenarioProgress) => void;
  yieldControl?: () => Promise<void>;
}

export class ScenarioDataError extends Error {
  constructor(public readonly code: 'BOUNDS' | 'COVERAGE' | 'MISSING_DATA' | 'MANIFEST' | 'INTEGRITY' | 'CANCELLED', message: string) {
    super(message);
    this.name = 'ScenarioDataError';
  }
}

const normalizeLongitude = (angle: number) => ((angle + 540) % 360) - 180;
const normalizeAzimuth = (angle: number) => ((angle % 360) + 360) % 360;
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ScenarioDataError('CANCELLED', 'Scenario preparation was cancelled.');
}
function finite(values: number[], description: string) {
  if (!values.every(Number.isFinite)) throw new ScenarioDataError('MISSING_DATA', `${description} must be finite.`);
}

/** A physical spherical destination, with east/north offsets defined at the region origin. */
export function destinationFromOffset(latitudeDeg: number, longitudeDeg: number, eastM: number, northM: number, radiusM = DEFAULT_RADIUS_M) {
  finite([latitudeDeg, longitudeDeg, eastM, northM, radiusM], 'Point coordinates');
  if (radiusM <= 0 || Math.abs(latitudeDeg) > 90) throw new ScenarioDataError('BOUNDS', 'Invalid lunar coordinate or radius.');
  const distance = Math.hypot(eastM, northM);
  if (!distance) return { latitudeDeg, longitudeDeg: normalizeLongitude(longitudeDeg) };
  const bearing = Math.atan2(eastM, northM), delta = distance / radiusM;
  const latitude = latitudeDeg * DEG, longitude = longitudeDeg * DEG;
  const lat = Math.asin(clamp(Math.sin(latitude) * Math.cos(delta) + Math.cos(latitude) * Math.sin(delta) * Math.cos(bearing), -1, 1));
  const lon = longitude + Math.atan2(Math.sin(bearing) * Math.sin(delta) * Math.cos(latitude), Math.cos(delta) - Math.sin(latitude) * Math.sin(lat));
  return { latitudeDeg: lat / DEG, longitudeDeg: normalizeLongitude(lon / DEG) };
}

export function projectSouthPolar(latitudeDeg: number, longitudeDeg: number, radiusM = DEFAULT_RADIUS_M) {
  const latitude = latitudeDeg * DEG, longitude = longitudeDeg * DEG;
  const rho = 2 * radiusM * Math.tan((Math.PI / 2 + latitude) / 2);
  return { x: rho * Math.sin(longitude), y: rho * Math.cos(longitude) };
}

function rasterCoordinates(raster: LoadedRaster, x: number, y: number) {
  const [a, b, c, d, e, f] = raster.descriptor.affine;
  const determinant = a * e - b * d;
  if (!Number.isFinite(determinant) || !determinant) throw new ScenarioDataError('MANIFEST', 'DEM affine transform is singular.');
  return { column: (e * (x - c) - b * (y - f)) / determinant - .5, row: (-d * (x - c) + a * (y - f)) / determinant - .5 };
}

export function rasterContains(raster: LoadedRaster, x: number, y: number): boolean {
  const { column, row } = rasterCoordinates(raster, x, y);
  return column >= 0 && row >= 0 && column <= raster.descriptor.width - 1 && row <= raster.descriptor.height - 1;
}

/** Bilinear sampling is registered at pixel centres, never at GeoTIFF pixel corners. */
export function sampleRaster(raster: LoadedRaster, x: number, y: number): number {
  const descriptor = raster.descriptor;
  const { column, row } = rasterCoordinates(raster, x, y);
  if (column < 0 || row < 0 || column > descriptor.width - 1 || row > descriptor.height - 1 || !Number.isFinite(column + row)) {
    throw new ScenarioDataError('COVERAGE', 'Requested terrain lies outside the native DEM coverage.');
  }
  if (descriptor.validProjectedRadiusM && Math.hypot(x, y) > descriptor.validProjectedRadiusM) {
    throw new ScenarioDataError('COVERAGE', 'Requested terrain lies outside the DEM valid polar radius.');
  }
  const left = Math.min(Math.floor(column), descriptor.width - 2), top = Math.min(Math.floor(row), descriptor.height - 2);
  const dc = column - left, dr = row - top;
  const indices = [top * descriptor.width + left, top * descriptor.width + left + 1, (top + 1) * descriptor.width + left, (top + 1) * descriptor.width + left + 1];
  const weights = [(1 - dc) * (1 - dr), dc * (1 - dr), (1 - dc) * dr, dc * dr];
  let value = 0;
  for (let index = 0; index < indices.length; index++) {
    if (weights[index] === 0) continue;
    const raw = raster.values[indices[index]];
    if (!Number.isFinite(raw) || (typeof descriptor.nodata === 'number' && raw === descriptor.nodata)) {
      throw new ScenarioDataError('MISSING_DATA', 'A native DEM sample is missing; no synthetic terrain was substituted.');
    }
    value += raw * weights[index];
  }
  const result = value * descriptor.scale + descriptor.offsetM;
  finite([result], 'Interpolated DEM height');
  return result;
}

function terrainSampler(near: LoadedRaster, far: LoadedRaster) {
  return (x: number, y: number) => sampleRaster(rasterContains(near, x, y) ? near : far, x, y);
}

/** Exact mission endpoints; no silent clipping to ephemeris coverage. */
export function createTimeAxis(startUtc: string, endUtc: string, cadenceMinutes = 5): string[] {
  const utc = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/.exec(value);
    const time = Date.parse(value), date = new Date(time);
    if (!match || !Number.isFinite(time) || date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2])
      || date.getUTCDate() !== Number(match[3]) || date.getUTCHours() !== Number(match[4]) || date.getUTCMinutes() !== Number(match[5])
      || date.getUTCSeconds() !== Number(match[6] ?? 0)) throw new ScenarioDataError('BOUNDS', 'Use an existing UTC date and time with an explicit Z suffix.');
    return time;
  };
  const start = utc(startUtc), end = utc(endUtc), step = cadenceMinutes * 60_000;
  if (!Number.isFinite(start + end + step) || end <= start || step <= 0 || cadenceMinutes > 60) {
    throw new ScenarioDataError('BOUNDS', 'Use a valid increasing UTC interval and a cadence greater than zero and at most sixty minutes.');
  }
  const count = Math.ceil((end - start) / step);
  if (count > 250_000) throw new ScenarioDataError('BOUNDS', 'This mission has too many time samples; shorten the interval.');
  const result = Array.from({ length: count }, (_, index) => new Date(start + index * step).toISOString());
  result.push(new Date(end).toISOString());
  return result;
}

/** Cubic Hermite uses the SPICE rotating-frame velocity, not a reused site's azimuth. */
export function hermiteState(a: VectorState, b: VectorState, fraction: number, seconds: number): VectorState {
  if (fraction < 0 || fraction > 1 || !Number.isFinite(fraction) || !Number.isFinite(seconds) || seconds <= 0) {
    throw new ScenarioDataError('COVERAGE', 'State interpolation requires a covered ephemeris interval.');
  }
  const t = fraction, t2 = t * t, t3 = t2 * t;
  const position = [0, 1, 2].map(index => (2 * t3 - 3 * t2 + 1) * a.position[index] + (t3 - 2 * t2 + t) * seconds * a.velocity[index]
    + (-2 * t3 + 3 * t2) * b.position[index] + (t3 - t2) * seconds * b.velocity[index]) as [number, number, number];
  const velocity = [0, 1, 2].map(index => (6 * t2 - 6 * t) / seconds * a.position[index] + (3 * t2 - 4 * t + 1) * a.velocity[index]
    + (-6 * t2 + 6 * t) / seconds * b.position[index] + (3 * t2 - 2 * t) * b.velocity[index]) as [number, number, number];
  finite([...position, ...velocity], 'Interpolated SPICE state');
  return { position, velocity };
}

export function lunarAxes(latitudeDeg: number, longitudeDeg: number) {
  const lat = latitudeDeg * DEG, lon = longitudeDeg * DEG, clat = Math.cos(lat), slat = Math.sin(lat), clon = Math.cos(lon), slon = Math.sin(lon);
  return { up: [clat * clon, clat * slon, slat], east: [-slon, clon, 0], north: [-slat * clon, -slat * slon, clat] };
}

export function topocentricGeometry(positionM: readonly number[], latitudeDeg: number, longitudeDeg: number, radialHeightM: number, radiusM = DEFAULT_RADIUS_M) {
  const axes = lunarAxes(latitudeDeg, longitudeDeg);
  const translated = positionM.map((value, index) => value - axes.up[index] * (radiusM + radialHeightM));
  const rangeM = Math.hypot(...translated);
  if (!Number.isFinite(rangeM) || rangeM <= 0) throw new ScenarioDataError('MISSING_DATA', 'Invalid topocentric body range.');
  const dot = (axis: number[]) => translated.reduce((sum, value, index) => sum + value * axis[index], 0);
  return { azimuthDeg: normalizeAzimuth(Math.atan2(dot(axes.east), dot(axes.north)) / DEG), elevationDeg: Math.asin(clamp(dot(axes.up) / rangeM, -1, 1)) / DEG,
    rangeM, direction: translated.map(value => value / rangeM) };
}

export function defaultHorizonRanges(): number[] {
  const result: number[] = [];
  for (const [from, to, step] of [[.25, 100, .25], [100, 500, 1], [500, 1_000, 2.5], [1_000, 24_000, 5], [24_000, 200_001, 80]]) {
    for (let range = from; range < to; range += step) result.push(range);
  }
  return result;
}

function manifestHorizonRanges(manifest: ScenarioManifest): number[] {
  const intervals = manifest.horizonSampling?.radialIntervals;
  if (!intervals) return defaultHorizonRanges();
  const values: number[] = [];
  for (const interval of intervals) {
    const inclusive = interval.toInclusiveM !== undefined, end = interval.toInclusiveM ?? interval.toExclusiveM;
    if (end === undefined || !Number.isFinite(interval.fromM + end + interval.stepM) || interval.fromM <= 0 || interval.stepM <= 0 || end <= interval.fromM) {
      throw new ScenarioDataError('MANIFEST', 'Invalid horizon range-sampling interval.');
    }
    for (let value = interval.fromM; inclusive ? value <= end : value < end; value += interval.stepM) values.push(value);
  }
  if (values.at(-1) !== 200_000 || values.length > 100_000 || values.some((value, index) => index > 0 && value <= values[index - 1])) {
    throw new ScenarioDataError('MANIFEST', 'Horizon ranges must increase and include the full 200 km endpoint.');
  }
  return values;
}

interface HorizonPair {
  panel: number[];
  antenna: number[];
  radialCoarseningMaxDeltaDeg: number;
  angularCoarseningMaxDeltaDeg: number;
  halfStepCheckMaxDeltaDeg: number;
  halfStepCheckBearings: number;
}

/** Reuses physical DEM samples for two heights while retaining independent horizons. */
export async function generateHorizons(
  latitudeDeg: number, longitudeDeg: number, surfaceHeightM: number, panelHeightM: number, antennaHeightM: number,
  sample: (x: number, y: number) => number, radiusM = DEFAULT_RADIUS_M, azimuthStepDeg = .25,
  options: PreparationOptions = {}, ranges = defaultHorizonRanges(),
): Promise<HorizonPair> {
  if (!Number.isFinite(azimuthStepDeg) || azimuthStepDeg <= 0 || Math.abs(360 / azimuthStepDeg - Math.round(360 / azimuthStepDeg)) > 1e-8) {
    throw new ScenarioDataError('BOUNDS', 'The horizon bearing step must divide 360 degrees.');
  }
  finite([surfaceHeightM, panelHeightM, antennaHeightM], 'Observer heights');
  if (panelHeightM < 0 || antennaHeightM < 0 || ranges.length < 2 || ranges.some((value, index) => !Number.isFinite(value) || value <= 0 || (index > 0 && value <= ranges[index - 1]))) {
    throw new ScenarioDataError('BOUNDS', 'Observer heights and horizon ranges must be physically valid.');
  }
  const axes = lunarAxes(latitudeDeg, longitudeDeg), count = Math.round(360 / azimuthStepDeg);
  const cosRanges = ranges.map(range => Math.cos(range / radiusM)), sinRanges = ranges.map(range => Math.sin(range / radiusM));
  const panelRadius = radiusM + surfaceHeightM + panelHeightM, antennaRadius = radiusM + surfaceHeightM + antennaHeightM;
  let radialDelta = 0;
  const ray = (bearing: number, diagnostics: boolean): [number, number] => {
    const sine = Math.sin(bearing * DEG), cosine = Math.cos(bearing * DEG);
    const direction = axes.east.map((value, index) => value * sine + axes.north[index] * cosine);
    let panel = -Infinity, antenna = -Infinity, coarsePanel = -Infinity, coarseAntenna = -Infinity;
    for (let index = 0; index < ranges.length; index++) {
      const c = cosRanges[index], s = sinRanges[index];
      const tx = axes.up[0] * c + direction[0] * s, ty = axes.up[1] * c + direction[1] * s, tz = axes.up[2] * c + direction[2] * s;
      const denominator = 1 - tz;
      const height = sample(2 * radiusM * ty / denominator, 2 * radiusM * tx / denominator);
      const targetRadius = radiusM + height, horizontal = targetRadius * s;
      const p = (targetRadius * c - panelRadius) / horizontal, a = (targetRadius * c - antennaRadius) / horizontal;
      panel = Math.max(panel, p); antenna = Math.max(antenna, a);
      if (diagnostics && (index % 2 === 0 || index === ranges.length - 1)) { coarsePanel = Math.max(coarsePanel, p); coarseAntenna = Math.max(coarseAntenna, a); }
    }
    const p = Math.atan(panel) / DEG, a = Math.atan(antenna) / DEG;
    if (diagnostics) radialDelta = Math.max(radialDelta, p - Math.atan(coarsePanel) / DEG, a - Math.atan(coarseAntenna) / DEG);
    finite([p, a], 'Computed terrain horizon');
    return [p, a];
  };
  const panel: number[] = [], antenna: number[] = [];
  for (let index = 0; index < count; index++) {
    cancelled(options.signal);
    const result = ray(index * azimuthStepDeg, true);
    panel.push(result[0]); antenna.push(result[1]);
    if (index % 16 === 15) {
      options.onProgress?.({ stage: 'horizon', fraction: .9 * (index + 1) / count, message: `Computing terrain horizon ${index + 1}/${count}` });
      await (options.yieldControl ?? yieldTask)();
    }
  }
  let angularDelta = 0;
  if (count % 2 === 0) for (const values of [panel, antenna]) {
    for (let index = 1; index < count; index += 2) angularDelta = Math.max(angularDelta, Math.abs(values[index] - .5 * (values[index - 1] + values[(index + 1) % count])));
  }
  let halfStepDelta = 0, halfStepCount = 0;
  // Distributed .125-degree checks at the default resolution detect additional
  // angular structure, without pretending that sparse checks are error bounds.
  const checkStride = Math.max(1, Math.round(5 / azimuthStepDeg));
  for (let index = 0; index < count; index += checkStride) {
    cancelled(options.signal);
    const result = ray((index + .5) * azimuthStepDeg, false);
    halfStepDelta = Math.max(halfStepDelta, Math.abs(result[0] - .5 * (panel[index] + panel[(index + 1) % count])), Math.abs(result[1] - .5 * (antenna[index] + antenna[(index + 1) % count])));
    halfStepCount++;
    if (halfStepCount % 8 === 0) await (options.yieldControl ?? yieldTask)();
  }
  options.onProgress?.({ stage: 'horizon', fraction: 1, message: 'Terrain profiles and sampling diagnostics ready' });
  return { panel, antenna, radialCoarseningMaxDeltaDeg: radialDelta, angularCoarseningMaxDeltaDeg: angularDelta, halfStepCheckMaxDeltaDeg: halfStepDelta, halfStepCheckBearings: halfStepCount };
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

function dataUrl(url: string, manifestUrl: string): string {
  // Published manifests use app-root ./scenarios paths; bare file names are
  // relative to the manifest, supporting fixtures and relocatable deployments.
  const absoluteManifest = new URL(manifestUrl, typeof location === 'undefined' ? 'http://localhost/' : location.href);
  if (url.startsWith('./scenarios/')) {
    const marker = absoluteManifest.pathname.lastIndexOf('/scenarios/');
    const appRoot = marker >= 0 ? new URL(absoluteManifest.pathname.slice(0, marker + 1), absoluteManifest) : new URL('./', absoluteManifest);
    return new URL(url.slice(2), appRoot).href;
  }
  return new URL(url, absoluteManifest).href;
}

export class ScenarioEngine {
  private manifestPromise?: Promise<{ manifest: ScenarioManifest; hash: string }>;
  private rasters = new Map<string, Promise<LoadedRaster>>();
  private ephemerisPromise?: Promise<{ manifest: EphemerisManifest; values: Float64Array; times: number[] }>;
  private horizonCache = new Map<string, HorizonPair>();

  constructor(private readonly manifestUrl = './scenarios/manifest.json', private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  private async json<T>(url: string): Promise<{ value: T; hash: string }> {
    const response = await this.fetcher(url);
    if (!response.ok) throw new ScenarioDataError('MISSING_DATA', `Cannot load scenario metadata (${response.status}).`);
    const text = await response.text();
    return { value: JSON.parse(text) as T, hash: await sha256(new TextEncoder().encode(text).buffer) };
  }

  async getManifest(): Promise<ScenarioManifest> { return (await this.loadManifest()).manifest; }

  private loadManifest() {
    if (!this.manifestPromise) this.manifestPromise = this.json<ScenarioManifest>(this.manifestUrl).then(({ value: manifest, hash }) => {
      if (manifest.schemaVersion !== 1 || manifest.frame !== 'MOON_ME_DE421' || manifest.referenceRadiusM !== DEFAULT_RADIUS_M || !manifest.regions || !manifest.farField) {
        throw new ScenarioDataError('MANIFEST', 'The scenario manifest must use the pinned MOON_ME_DE421 lunar datum.');
      }
      return { manifest, hash };
    }).catch(error => { this.manifestPromise = undefined; throw error; });
    return this.manifestPromise;
  }

  private async chunk(chunk: DataChunk, contextUrl: string): Promise<ArrayBuffer> {
    const response = await this.fetcher(dataUrl(chunk.url, contextUrl));
    if (!response.ok) throw new ScenarioDataError('MISSING_DATA', `Cannot load a required scenario data file (${response.status}).`);
    const validLength = (value: number | undefined): value is number => Number.isSafeInteger(value) && value! > 0;
    const validHash = (value: string | undefined): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
    if (!validLength(chunk.byteLength) || !validHash(chunk.sha256)) {
      throw new ScenarioDataError('MANIFEST', 'Every scenario data file requires a pinned byte length and SHA-256 hash.');
    }
    const received = await response.arrayBuffer();
    const receivedHash = await sha256(received);
    const compressedMatches = received.byteLength === chunk.byteLength && receivedHash === chunk.sha256.toLowerCase();
    if (chunk.encoding === 'gzip') {
      if (!validLength(chunk.uncompressedBytes) || !validHash(chunk.uncompressedSha256)) {
        throw new ScenarioDataError('MANIFEST', 'Gzip scenario files require pinned decoded byte lengths and SHA-256 hashes.');
      }
      // A server may send the explicit .gz file with Content-Encoding: gzip.
      // Fetch then exposes decoded bytes; other hosts expose the gzip bytes.
      // Match the pinned content in either representation, never trust headers
      // or a plausible byte length as a substitute for integrity verification.
      if (!compressedMatches) {
        if (received.byteLength === chunk.uncompressedBytes && receivedHash === chunk.uncompressedSha256.toLowerCase()) return received;
        throw new ScenarioDataError('INTEGRITY', 'A scenario data file matches neither its compressed nor decoded SHA-256 and byte length.');
      }
      let decoded: ArrayBuffer;
      try { decoded = await new Response(new Blob([received]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); }
      catch { throw new ScenarioDataError('INTEGRITY', 'A verified gzip scenario file could not be decoded.'); }
      if (decoded.byteLength !== chunk.uncompressedBytes || await sha256(decoded) !== chunk.uncompressedSha256.toLowerCase()) {
        throw new ScenarioDataError('INTEGRITY', 'A decoded scenario data file failed its pinned SHA-256 or byte length check.');
      }
      return decoded;
    }
    if (!compressedMatches) throw new ScenarioDataError('INTEGRITY', 'A scenario data file failed its pinned SHA-256 or byte length check.');
    return received;
  }

  private loadRaster(descriptor: RasterDescriptor, key: string): Promise<LoadedRaster> {
    let promise = this.rasters.get(key);
    if (!promise) {
      promise = (async () => {
        if (!Number.isInteger(descriptor.width) || !Number.isInteger(descriptor.height) || descriptor.width < 2 || descriptor.height < 2
          || !['float32-le', 'int16-le'].includes(descriptor.dtype) || !descriptor.affine || descriptor.affine.length !== 6
          || !Number.isFinite(descriptor.scale + descriptor.offsetM)) throw new ScenarioDataError('MANIFEST', 'Invalid native DEM metadata.');
        const output = descriptor.dtype === 'int16-le' ? new Int16Array(descriptor.width * descriptor.height) : new Float32Array(descriptor.width * descriptor.height);
        const chunks = descriptor.chunks ?? (descriptor.url ? [descriptor as DataChunk] : []);
        let nextRow = 0;
        for (const part of chunks) {
          const rowStart = part.rowStart ?? 0, rowCount = part.rowCount ?? descriptor.height;
          if (rowStart !== nextRow || rowCount <= 0 || rowStart + rowCount > descriptor.height) throw new ScenarioDataError('MANIFEST', 'DEM chunks must cover every row exactly once.');
          const bytes = await this.chunk(part, this.manifestUrl), count = rowCount * descriptor.width;
          const expectedBytes = count * output.BYTES_PER_ELEMENT;
          if (bytes.byteLength !== expectedBytes) throw new ScenarioDataError('INTEGRITY', 'Native DEM dimensions do not match its binary data.');
          const view = new DataView(bytes), base = rowStart * descriptor.width;
          for (let index = 0; index < count; index++) output[base + index] = descriptor.dtype === 'int16-le' ? view.getInt16(index * 2, true) : view.getFloat32(index * 4, true);
          nextRow += rowCount;
        }
        if (nextRow !== descriptor.height) throw new ScenarioDataError('MANIFEST', 'Native DEM row coverage is incomplete.');
        return { descriptor, values: output };
      })().catch(error => { this.rasters.delete(key); throw error; });
      this.rasters.set(key, promise);
    }
    return promise;
  }

  private loadEphemeris(manifest: ScenarioManifest) {
    if (!this.ephemerisPromise) this.ephemerisPromise = (async () => {
      const path = manifest.ephemerisManifestUrl ?? (typeof manifest.ephemeris === 'string' ? manifest.ephemeris : manifest.ephemeris?.url) ?? './ephemeris/manifest.json';
      const url = dataUrl(path, this.manifestUrl);
      const { value: ephemeris } = await this.json<EphemerisManifest>(url);
      if (ephemeris.frame !== manifest.frame || ephemeris.dtype !== 'float64-le' || ephemeris.stride !== 13 || ephemeris.epochsUtc.length < 2) {
        throw new ScenarioDataError('MANIFEST', 'Ephemeris states must use the same pinned Moon frame and 13-value layout.');
      }
      const times = ephemeris.epochsUtc.map(Date.parse);
      if (times.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= times[index - 1]))) throw new ScenarioDataError('MANIFEST', 'Ephemeris epochs must increase strictly.');
      if (times[0] !== Date.parse(ephemeris.startUtc) || times[times.length - 1] !== Date.parse(ephemeris.endUtc)) throw new ScenarioDataError('MANIFEST', 'Ephemeris declared coverage differs from its epochs.');
      const values = new Float64Array(times.length * 13);
      let nextRow = 0;
      for (const part of ephemeris.chunks) {
        const rowStart = part.rowStart ?? 0, rowCount = part.rowCount ?? times.length;
        if (rowStart !== nextRow || rowCount <= 0 || rowStart + rowCount > times.length) throw new ScenarioDataError('MANIFEST', 'Ephemeris chunks must cover every epoch exactly once.');
        const bytes = await this.chunk(part, url);
        if (bytes.byteLength !== rowCount * 13 * 8) throw new ScenarioDataError('INTEGRITY', 'Ephemeris binary dimensions are inconsistent.');
        const view = new DataView(bytes);
        for (let index = 0; index < rowCount * 13; index++) {
          const value = view.getFloat64(index * 8, true);
          if (!Number.isFinite(value)) throw new ScenarioDataError('MISSING_DATA', 'A required SPICE state is missing.');
          values[rowStart * 13 + index] = value;
        }
        nextRow += rowCount;
      }
      if (nextRow !== times.length) throw new ScenarioDataError('MANIFEST', 'Ephemeris row coverage is incomplete.');
      for (let index = 1; index < times.length; index++) if (values[index * 13] <= values[(index - 1) * 13]) throw new ScenarioDataError('MANIFEST', 'SPICE ET epochs must increase strictly.');
      return { manifest: ephemeris, values, times };
    })().catch(error => { this.ephemerisPromise = undefined; throw error; });
    return this.ephemerisPromise;
  }

  async prepare(request: ScenarioRequest, options: PreparationOptions = {}): Promise<PreparedScenario> {
    cancelled(options.signal);
    const { manifest, hash } = await this.loadManifest(), region = manifest.regions[request.point.regionId];
    if (!region) throw new ScenarioDataError('BOUNDS', 'Choose a documented lunar scenario region.');
    const point = request.point, bounds = region.supportedDomain.bounds, radius = manifest.referenceRadiusM;
    finite([point.eastM, point.northM, point.panelHeightM, point.antennaHeightM], 'Scenario point and heights');
    const heightRange = manifest.horizonSampling?.observerHeightRangeM ?? { min: 0, max: 100 };
    if (point.eastM < bounds.eastMinM || point.eastM > bounds.eastMaxM || point.northM < bounds.northMinM || point.northM > bounds.northMaxM
      || point.panelHeightM < heightRange.min || point.antennaHeightM < heightRange.min || point.panelHeightM > heightRange.max || point.antennaHeightM > heightRange.max) {
      throw new ScenarioDataError('BOUNDS', `Point or component height lies outside the supported scenario domain (heights ${heightRange.min}–${heightRange.max} m).`);
    }
    const cadence = request.cadenceMinutes ?? 5, step = request.azimuthStepDeg ?? .25;
    if (step < .125 || step > 1) throw new ScenarioDataError('BOUNDS', 'Supported horizon steps range from 0.125 to 1 degree.');
    const timeAxis = createTimeAxis(request.startUtc, request.endUtc, cadence);
    options.onProgress?.({ stage: 'data', fraction: 0, message: 'Loading and verifying native NASA terrain and SPICE states' });
    const [near, far, ephemeris] = await Promise.all([this.loadRaster(region.nearRaster, `${hash}:${region.id}`), this.loadRaster(manifest.farField, `${hash}:far`), this.loadEphemeris(manifest)]);
    cancelled(options.signal);
    if (Date.parse(timeAxis[0]) < ephemeris.times[0] || Date.parse(timeAxis[timeAxis.length - 1]) > ephemeris.times[ephemeris.times.length - 1]) {
      throw new ScenarioDataError('COVERAGE', 'The complete requested mission must lie within the published SPICE cache.');
    }
    const coordinates = destinationFromOffset(region.origin.latitudeDeg, region.origin.longitudeDeg, point.eastM, point.northM, radius);
    const projected = projectSouthPolar(coordinates.latitudeDeg, coordinates.longitudeDeg, radius);
    // A selectable point must be in its native 5 m region. Far-field fallback is
    // only for the surrounding 200 km terrain used by horizon rays.
    const surfaceHeight = sampleRaster(near, projected.x, projected.y), sample = terrainSampler(near, far);
    const pointKey = `${region.id}:${point.eastM}:${point.northM}`;
    const key = `${hash}:${pointKey}:${point.panelHeightM}:${point.antennaHeightM}:${step}:rays-v1`;
    let horizons = this.horizonCache.get(key);
    if (!horizons) {
      horizons = await generateHorizons(coordinates.latitudeDeg, coordinates.longitudeDeg, surfaceHeight, point.panelHeightM, point.antennaHeightM, sample, radius, step, options, manifestHorizonRanges(manifest));
      cancelled(options.signal);
      this.horizonCache.set(key, horizons);
      if (this.horizonCache.size > 32) this.horizonCache.delete(this.horizonCache.keys().next().value!);
    }
    options.onProgress?.({ stage: 'ephemeris', fraction: 0, message: 'Translating SPICE vectors to the actual component observers' });
    const emptyEphemeris = (): ScenarioEphemeris => ({ timesUtc: timeAxis, sunAzDeg: [], sunElDeg: [], earthAzDeg: [], earthElDeg: [], sunRangeM: [], earthRangeM: [], sunAngularRadiusDeg: [], earthAngularRadiusDeg: [], sunEarthSeparationDeg: [] });
    const panel = emptyEphemeris(), antenna = emptyEphemeris();
    let bracket = 0;
    const stateAt = (index: number, body: 'sun' | 'earth'): VectorState => {
      const offset = index * 13 + (body === 'sun' ? 1 : 7);
      return { position: Array.from(ephemeris.values.slice(offset, offset + 3)) as [number, number, number], velocity: Array.from(ephemeris.values.slice(offset + 3, offset + 6)) as [number, number, number] };
    };
    for (let index = 0; index < timeAxis.length; index++) {
      cancelled(options.signal);
      const time = Date.parse(timeAxis[index]);
      while (bracket < ephemeris.times.length - 2 && time > ephemeris.times[bracket + 1]) bracket++;
      const fraction = (time - ephemeris.times[bracket]) / (ephemeris.times[bracket + 1] - ephemeris.times[bracket]);
      const etSeconds = ephemeris.values[(bracket + 1) * 13] - ephemeris.values[bracket * 13];
      const sunState = hermiteState(stateAt(bracket, 'sun'), stateAt(bracket + 1, 'sun'), fraction, etSeconds);
      const earthState = hermiteState(stateAt(bracket, 'earth'), stateAt(bracket + 1, 'earth'), fraction, etSeconds);
      for (const [output, height] of [[panel, point.panelHeightM], [antenna, point.antennaHeightM]] as const) {
        const sun = topocentricGeometry(sunState.position, coordinates.latitudeDeg, coordinates.longitudeDeg, surfaceHeight + height, radius);
        const earth = topocentricGeometry(earthState.position, coordinates.latitudeDeg, coordinates.longitudeDeg, surfaceHeight + height, radius);
        output.sunAzDeg.push(sun.azimuthDeg); output.sunElDeg.push(sun.elevationDeg); output.earthAzDeg.push(earth.azimuthDeg); output.earthElDeg.push(earth.elevationDeg);
        output.sunRangeM.push(sun.rangeM); output.earthRangeM.push(earth.rangeM);
        output.sunAngularRadiusDeg.push(Math.asin(SUN_RADIUS_M / sun.rangeM) / DEG); output.earthAngularRadiusDeg.push(Math.asin(EARTH_RADIUS_M / earth.rangeM) / DEG);
        output.sunEarthSeparationDeg.push(Math.acos(clamp(sun.direction.reduce((sum, value, axis) => sum + value * earth.direction[axis], 0), -1, 1)) / DEG);
      }
      if (index % 256 === 255) { options.onProgress?.({ stage: 'ephemeris', fraction: index / timeAxis.length, message: 'Preparing component ephemerides' }); await (options.yieldControl ?? yieldTask)(); }
    }
    const provenance: Site['provenance'] = [
      { title: region.nearRaster.source?.title ?? region.source?.title ?? 'NASA LOLA native regional DEM', url: region.nearRaster.sourceUrl ?? region.nearRaster.source?.url ?? region.source?.url ?? 'https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/', detail: `Pixel-centre bilinear height; ${manifest.heightDatum}.` },
      { title: 'NASA LOLA 80 m south-polar far field', url: manifest.farField.sourceUrl ?? manifest.farField.source?.url ?? 'https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/JP2/LDEM_80S_80M.JP2', detail: 'Terrain rays extend to 200 km with lunar curvature.' },
      { title: 'NAIF SPICE pinned Moon frame state cache', url: 'https://naif.jpl.nasa.gov/naif/data.html', detail: `${manifest.frame}; rotating-frame position/velocity Hermite interpolation; actual point translation. Manifest SHA-256 ${hash}.` },
      { title: 'Finite-disc spherical-body inputs', url: 'https://naif.jpl.nasa.gov/naif/data.html', detail: `Sun radius ${SUN_RADIUS_M} m; opaque spherical Earth radius ${EARTH_RADIUS_M} m. Angular radii use actual panel-receiver ranges; Earth's atmosphere and oblateness are not modeled.` },
    ];
    const limitations = [
      'NASA DEM interpolation is a terrain model; sub-pixel boulders, relief and DEM uncertainty are not resolved.',
      'Finite bearing and range samples may miss narrow terrain. Convergence diagnostics are sampled comparisons, not error bounds.',
      'Hourly cached SPICE states are interpolated at mission cadence and translated from the Moon centre; no live SPICE or Horizons service is used.',
      ...(typeof ephemeris.manifest.approximation === 'string' ? [ephemeris.manifest.approximation] : []),
      ...(typeof ephemeris.manifest.leapSeconds === 'string' ? [ephemeris.manifest.leapSeconds] : []),
      'Centre visibility flags are distinct from finite-disc solar flux and do not establish a radio link or mission safety.',
    ];
    const terrain: Terrain = { size: 33, bounds: { eastMinM: -4_096, eastMaxM: 4_096, northMinM: -4_096, northMaxM: 4_096 }, heightsM: [], centerHeightM: surfaceHeight, referenceRadiusM: radius };
    for (let row = 0; row < terrain.size; row++) for (let column = 0; column < terrain.size; column++) {
      const offset = destinationFromOffset(coordinates.latitudeDeg, coordinates.longitudeDeg, -4_096 + column * 256, 4_096 - row * 256, radius);
      const projected = projectSouthPolar(offset.latitudeDeg, offset.longitudeDeg, radius);
      terrain.heightsM.push(sample(projected.x, projected.y));
    }
    const site = (height: number, elevationDeg: number[], output: ScenarioEphemeris): Site & { ephemeris: ScenarioEphemeris } => ({
      id: region.id, name: region.name, ...coordinates, observerHeightM: height,
      description: `Selected native-DEM point ${point.eastM} m east, ${point.northM} m north of the regional origin.`,
      horizon: { azimuthStepDeg: step, elevationDeg, maxRangeKm: 200, terrainResolutionM: 5, method: 'Native 5 m/80 m DEM bilinear samples, spherical curvature, independent component observer height.' },
      terrain, ephemeris: output, provenance, limitations,
    });
    options.onProgress?.({ stage: 'ephemeris', fraction: 1, message: 'Scenario ready' });
    return {
      scenarioId: request.scenarioId ?? pointKey, pointId: request.pointId ?? pointKey, pointKey, point: { ...point }, regionId: region.id, ...coordinates, surfaceElevationM: surfaceHeight, surfaceHeightM: surfaceHeight,
      modelVersion: manifest.modelVersion ?? `scenario-v1-${hash.slice(0, 12)}`,
      panelSite: site(point.panelHeightM, horizons.panel, panel), antennaSite: site(point.antennaHeightM, horizons.antenna, antenna),
      bodyGeometry: { timesUtc: timeAxis, sunDistanceAu: panel.sunRangeM.map(range => range / AU_M), sunRangeM: panel.sunRangeM, earthRangeM: panel.earthRangeM,
        antennaEarthRangeM: antenna.earthRangeM, sunAngularRadiusDeg: panel.sunAngularRadiusDeg, earthAngularRadiusDeg: panel.earthAngularRadiusDeg, sunEarthSeparationDeg: panel.sunEarthSeparationDeg },
      coverage: { startUtc: timeAxis[0], endUtc: timeAxis[timeAxis.length - 1], cacheStartUtc: ephemeris.manifest.startUtc, cacheEndUtc: ephemeris.manifest.endUtc, cadenceMinutes: cadence, complete: true, frame: manifest.frame },
      provenance,
      quality: { horizonStepDeg: step, rangeM: 200_000, nearNativeResolutionM: 5, farNativeResolutionM: 80,
        radialSampling: manifest.horizonSampling?.radialIntervals.map(interval => `${interval.stepM} m steps from ${interval.fromM} m ${interval.toInclusiveM !== undefined ? 'through' : 'below'} ${interval.toInclusiveM ?? interval.toExclusiveM} m`).join('; ')
          ?? 'Published default radial sampling through 200 km',
        radialCoarseningMaxDeltaDeg: horizons.radialCoarseningMaxDeltaDeg, angularCoarseningMaxDeltaDeg: horizons.angularCoarseningMaxDeltaDeg,
        halfStepCheckMaxDeltaDeg: horizons.halfStepCheckMaxDeltaDeg, halfStepCheckBearings: horizons.halfStepCheckBearings,
        note: 'Radial 2× and angular 2× coarsening comparisons plus distributed half-bearing checks; not formal accuracy or uncertainty bounds.' },
    };
  }
}
