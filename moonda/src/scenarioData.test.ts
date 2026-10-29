import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  createTimeAxis, defaultHorizonRanges, destinationFromOffset, generateHorizons, hermiteState,
  projectSouthPolar, sampleRaster, ScenarioDataError, ScenarioEngine, topocentricGeometry,
  type EphemerisManifest, type LoadedRaster, type ScenarioManifest,
} from './scenarioData';

const radius = 1_737_400;
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const origin = 'http://localhost/demo/';
const fetchLocal = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, origin);
  if (!url.pathname.startsWith('/demo/')) return new Response('bad subpath', { status: 404 });
  try { return new Response(await readFile(path.join(publicRoot, url.pathname.slice('/demo/'.length)))); }
  catch { return new Response('missing', { status: 404 }); }
}) as typeof fetch;

it('keeps the browser worker receiver when using the default fetch transport', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return fetchLocal(input, init);
  };
  try {
    const manifest = await new ScenarioEngine(`${origin}scenarios/manifest.json`).getManifest();
    expect(manifest.frame).toBe('MOON_ME_DE421');
  } finally { globalThis.fetch = original; }
});

describe('native terrain and lunar point geometry', () => {
  const raster: LoadedRaster = {
    descriptor: { dtype: 'float32-le', width: 2, height: 2, affine: [5, 0, 100, 0, -5, 200], scale: 1, offsetM: 0, nodata: 'NaN' },
    values: new Float32Array([10, 20, 30, 40]),
  };
  it('samples pixel centres and the bilinear interior without an extra datum offset', () => {
    expect(sampleRaster(raster, 102.5, 197.5)).toBe(10);
    expect(sampleRaster(raster, 107.5, 192.5)).toBe(40);
    expect(sampleRaster(raster, 105, 195)).toBe(25);
    expect(sampleRaster({ ...raster, descriptor: { ...raster.descriptor, scale: .5, offsetM: 0 } }, 105, 195)).toBe(12.5);
  });
  it('rejects unsupported positions and missing contributing data instead of inventing heights', () => {
    expect(() => sampleRaster(raster, 100, 195)).toThrow('outside');
    const missing = { ...raster, values: new Float32Array([10, NaN, 30, 40]) };
    expect(() => sampleRaster(missing, 105, 195)).toThrow('missing');
    expect(sampleRaster(missing, 102.5, 197.5)).toBe(10);
  });
  it('preserves spherical distance and rotates local east/north correctly near the pole', () => {
    const source = { latitudeDeg: -89.5, longitudeDeg: 170 };
    const target = destinationFromOffset(source.latitudeDeg, source.longitudeDeg, 1_500, -2_000);
    const lat1 = source.latitudeDeg * Math.PI / 180, lat2 = target.latitudeDeg * Math.PI / 180;
    const dlat = lat2 - lat1, dlon = (target.longitudeDeg - source.longitudeDeg) * Math.PI / 180;
    const distance = 2 * radius * Math.asin(Math.sqrt(Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2));
    expect(distance).toBeCloseTo(2_500, 6);
    expect(destinationFromOffset(-89, 0, 0, 100).latitudeDeg).toBeGreaterThan(-89);
    expect(projectSouthPolar(-90, 125)).toEqual({ x: 0, y: -0 });
  });
  it('starts near enough to resolve native-grid terrain and includes the full 200 km endpoint', () => {
    const ranges = defaultHorizonRanges();
    expect(ranges).toHaveLength(7_800);
    expect(ranges[0]).toBe(.25);
    expect(ranges.at(-1)).toBe(200_000);
    expect(new Set(ranges).size).toBe(ranges.length);
  });
  it('reproduces a smooth spherical horizon dip and responds independently to each component height', async () => {
    const result = await generateHorizons(-89, 20, 0, 2, 20, () => 0, radius, 90, { yieldControl: async () => {} });
    const panelDip = -Math.acos(radius / (radius + 2)) * 180 / Math.PI;
    const antennaDip = -Math.acos(radius / (radius + 20)) * 180 / Math.PI;
    expect(result.panel.every(value => Math.abs(value - panelDip) < .00001)).toBe(true);
    expect(result.antenna.every(value => Math.abs(value - antennaDip) < .00001)).toBe(true);
    expect(result.antenna[0]).toBeLessThan(result.panel[0]);
  });
  it('rejects an aborted calculation cooperatively', async () => {
    const controller = new AbortController();
    let samples = 0;
    await expect(generateHorizons(-89, 0, 0, 2, 4, () => { samples++; return 0; }, radius, 1, {
      signal: controller.signal, yieldControl: async () => { controller.abort(); },
    }, [5, 10, 20])).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(samples).toBeLessThan(360 * 3);
  });
});

describe('actual observer ephemerides', () => {
  it('uses position and velocity in Hermite interpolation, including both endpoints', () => {
    const a = { position: [0, 0, 0] as [number, number, number], velocity: [0, 2, 0] as [number, number, number] };
    const b = { position: [8, 4, 0] as [number, number, number], velocity: [12, 2, 0] as [number, number, number] };
    expect(hermiteState(a, b, .5, 2).position).toEqual([1, 2, 0]);
    expect(hermiteState(a, b, 0, 2)).toEqual(a);
    expect(hermiteState(a, b, 1, 2)).toEqual(b);
  });
  it('subtracts the physical observer position and reports actual range', () => {
    const east = topocentricGeometry([radius + 500, 10_000, 0], 0, 0, 500);
    expect(east.azimuthDeg).toBe(90);
    expect(east.elevationDeg).toBe(0);
    expect(east.rangeM).toBe(10_000);
    const raised = topocentricGeometry([radius + 500, 10_000, 0], 0, 0, 600);
    expect(raised.elevationDeg).toBeLessThan(0);
    expect(raised.rangeM).toBeGreaterThan(east.rangeM);
  });
  it('includes exact non-grid mission endpoints rather than stretching a five-minute axis', () => {
    const times = createTimeAxis('2026-11-01T00:02:00Z', '2026-11-01T00:14:30Z');
    expect(times).toEqual(['2026-11-01T00:02:00.000Z', '2026-11-01T00:07:00.000Z', '2026-11-01T00:12:00.000Z', '2026-11-01T00:14:30.000Z']);
    expect(() => createTimeAxis('invalid', '2026-01-01')).toThrow(ScenarioDataError);
    expect(() => createTimeAxis('2026-02-30T00:00:00Z', '2026-03-03T00:00:00Z')).toThrow('existing UTC');
    expect(() => createTimeAxis('2026-11-01T00:00:00', '2026-11-02T00:00:00Z')).toThrow('explicit Z');
  });

  it('matches independent Python/SPICE cache vectors at withheld surface points and eclipse epochs', async () => {
    const manifest: EphemerisManifest = JSON.parse(await readFile(path.join(publicRoot, 'scenarios/ephemeris/manifest.json'), 'utf8'));
    const bytes = await readFile(path.join(publicRoot, 'scenarios/ephemeris/states.f64le'));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = Array.from({ length: bytes.byteLength / 8 }, (_, index) => view.getFloat64(index * 8, true));
    const times = manifest.epochsUtc.map(Date.parse);
    const fixtures = JSON.parse(await readFile(path.join(publicRoot, 'scenarios/ephemeris/reference-fixtures.json'), 'utf8')).fixtures;
    for (const fixture of fixtures) {
      const time = Date.parse(fixture.utc);
      let lower = Math.min(times.length - 2, Math.max(0, Math.floor((time - times[0]) / 3_600_000)));
      while (times[lower + 1] < time) lower++;
      const fraction = (time - times[lower]) / (times[lower + 1] - times[lower]);
      for (const body of ['sun', 'earth'] as const) {
        const offset = body === 'sun' ? 1 : 7;
        const state = (row: number) => ({ position: values.slice(row * 13 + offset, row * 13 + offset + 3) as [number, number, number], velocity: values.slice(row * 13 + offset + 3, row * 13 + offset + 6) as [number, number, number] });
        const interpolated = hermiteState(state(lower), state(lower + 1), fraction, values[(lower + 1) * 13] - values[lower * 13]);
        const geometry = topocentricGeometry(interpolated.position, fixture.latitudeDeg, fixture.longitudeDeg, fixture.surfaceHeightM + fixture.observerHeightM);
        const expectedVector = fixture.cacheInterpolatedVectorsM[body];
        const expectedRange = Math.hypot(...expectedVector);
        expect(Math.abs(geometry.rangeM - expectedRange)).toBeLessThan(.0002);
        const expected = topocentricGeometry(expectedVector.map((value: number, axis: number) => value + fixture.observerPositionM[axis]), fixture.latitudeDeg, fixture.longitudeDeg, fixture.surfaceHeightM + fixture.observerHeightM);
        expect(Math.abs(geometry.elevationDeg - expected.elevationDeg)).toBeLessThan(1e-9);
        expect(Math.abs(geometry.azimuthDeg - expected.azimuthDeg)).toBeLessThan(1e-9);
      }
    }
  });
});

describe('published scenario integration', () => {
  it('accepts HTTP-decoded gzip only after checking its decoded size and hash', async () => {
    let decodedFiles = 0;
    const browserFetch = (async (input: RequestInfo | URL) => {
      const response = await fetchLocal(input);
      const url = String(input);
      if (!response.ok || !url.endsWith('.bin.gz')) return response;
      const compressed = await response.arrayBuffer();
      const decoded = gunzipSync(new Uint8Array(compressed));
      decodedFiles++;
      // This is what browser fetch exposes after the HTTP content-coding has
      // been decoded, while the response retains its original coding header.
      return new Response(decoded, { headers: { 'Content-Encoding': 'gzip', 'Content-Length': String(compressed.byteLength) } });
    }) as typeof fetch;
    const engine = new ScenarioEngine(`${origin}scenarios/manifest.json`, browserFetch);
    const prepared = await engine.prepare({ scenarioId: 'A', pointId: 'http-decoded', point: { regionId: 'connecting-ridge', eastM: 0, northM: 0, panelHeightM: 2, antennaHeightM: 10 }, startUtc: '2026-11-14T00:00:00Z', endUtc: '2026-11-14T00:05:00Z', azimuthStepDeg: 1 }, { yieldControl: async () => {} });
    expect(decodedFiles).toBe(5); // One native region and four shared far-field stripes.
    const fixtures = JSON.parse(await readFile(path.join(publicRoot, 'scenarios/terrain/reference-fixtures.json'), 'utf8')).points;
    const reference = fixtures.find((point: any) => point.regionId === 'connecting-ridge' && point.eastM === 0 && point.northM === 0);
    expect(prepared.surfaceElevationM).toBeCloseTo(reference.surfaceHeightM, 6);
    const horizon = reference.components.find((component: any) => component.heightAboveGroundM === 2).horizonElevationDeg;
    expect(Math.max(...prepared.panelSite.horizon.elevationDeg.map((value, index) => Math.abs(value - horizon[index * 4])))).toBeLessThan(.000001);
  }, 30_000);

  it('rejects modified HTTP-decoded bytes even when the decoded length and gzip header are plausible', async () => {
    const browserFetch = (async (input: RequestInfo | URL) => {
      const response = await fetchLocal(input);
      if (!response.ok || !String(input).endsWith('.bin.gz')) return response;
      const decoded = gunzipSync(new Uint8Array(await response.arrayBuffer()));
      if (String(input).includes('Site01-')) decoded[0] ^= 1;
      return new Response(decoded, { headers: { 'Content-Encoding': 'gzip' } });
    }) as typeof fetch;
    const engine = new ScenarioEngine(`${origin}scenarios/manifest.json`, browserFetch);
    await expect(engine.prepare({ point: { regionId: 'connecting-ridge', eastM: 0, northM: 0, panelHeightM: 2, antennaHeightM: 10 }, startUtc: '2026-11-14T00:00:00Z', endUtc: '2026-11-14T00:05:00Z', azimuthStepDeg: 1 })).rejects.toMatchObject({ code: 'INTEGRITY' });
  }, 30_000);

  it('loads and hashes compressed native DEMs, matches three independent Python horizons, and preserves component geometry', async () => {
    const manifest: ScenarioManifest = JSON.parse(await readFile(path.join(publicRoot, 'scenarios/manifest.json'), 'utf8'));
    const fixtures = JSON.parse(await readFile(path.join(publicRoot, 'scenarios/terrain/reference-fixtures.json'), 'utf8')).points;
    const engine = new ScenarioEngine(`${origin}scenarios/manifest.json`, fetchLocal);
    for (const region of Object.values(manifest.regions)) {
      const fixture = fixtures.find((point: any) => point.regionId === region.id && point.eastM === 0 && point.northM === 0);
      const prepared = await engine.prepare({ scenarioId: 'A', pointId: `chosen-${region.id}`, point: { regionId: region.id, eastM: 0, northM: 0, panelHeightM: 2, antennaHeightM: 10 }, startUtc: '2026-03-03T11:30:00Z', endUtc: '2026-03-03T11:35:00Z' }, { yieldControl: async () => {} });
      expect(prepared.scenarioId).toBe('A');
      expect(prepared.pointId).toBe(`chosen-${region.id}`);
      expect(prepared.surfaceElevationM).toBeCloseTo(fixture.surfaceHeightM, 6);
      const expected = fixture.components.find((component: any) => component.heightAboveGroundM === 2).horizonElevationDeg;
      expect(prepared.panelSite.horizon.elevationDeg).toHaveLength(1_440);
      const delta = Math.max(...expected.map((value: number, index: number) => Math.abs(value - prepared.panelSite.horizon.elevationDeg[index])));
      expect(delta).toBeLessThan(.000001);
      const expectedAntenna = fixture.components.find((component: any) => component.heightAboveGroundM === 10).horizonElevationDeg;
      expect(Math.max(...expectedAntenna.map((value: number, index: number) => Math.abs(value - prepared.antennaSite.horizon.elevationDeg[index])))).toBeLessThan(.000001);
      expect(prepared.panelSite.ephemeris.timesUtc).toEqual(prepared.antennaSite.ephemeris.timesUtc);
      expect(prepared.antennaSite.horizon.elevationDeg.some((value, index) => value < prepared.panelSite.horizon.elevationDeg[index])).toBe(true);
      const geometry = prepared.bodyGeometry;
      expect(geometry.sunRangeM[0]).toBeGreaterThan(1e11);
      expect(geometry.sunEarthSeparationDeg[0] + geometry.sunAngularRadiusDeg[0]).toBeLessThan(geometry.earthAngularRadiusDeg[0]);
      expect(prepared.quality.halfStepCheckBearings).toBe(72);
      if (region.id === 'connecting-ridge') {
        const movedFixture = fixtures.find((point: any) => point.regionId === region.id && point.eastM === 2_560 && point.northM === 2_560);
        const moved = await engine.prepare({ scenarioId: 'B', pointId: 'corner', point: { regionId: region.id, eastM: 2_560, northM: 2_560, panelHeightM: 2, antennaHeightM: 10 }, startUtc: '2026-03-03T11:30:00Z', endUtc: '2026-03-03T11:35:00Z' }, { yieldControl: async () => {} });
        expect(moved.surfaceElevationM).toBeCloseTo(movedFixture.surfaceHeightM, 6);
        const movedProfile = movedFixture.components.find((component: any) => component.heightAboveGroundM === 2).horizonElevationDeg;
        expect(Math.max(...movedProfile.map((value: number, index: number) => Math.abs(value - moved.panelSite.horizon.elevationDeg[index])))).toBeLessThan(.000001);
        expect(moved.panelSite.ephemeris.sunAzDeg[0]).not.toBe(prepared.panelSite.ephemeris.sunAzDeg[0]);
        expect(moved.panelSite.horizon.elevationDeg).not.toEqual(prepared.panelSite.horizon.elevationDeg);
      }
      await expect(engine.prepare({ point: { regionId: region.id, eastM: 2_561, northM: 0, panelHeightM: 2, antennaHeightM: 2 }, startUtc: '2026-01-01T00:00:00Z', endUtc: '2026-01-01T00:05:00Z' })).rejects.toMatchObject({ code: 'BOUNDS' });
      await expect(engine.prepare({ point: { regionId: region.id, eastM: 0, northM: 0, panelHeightM: 2, antennaHeightM: 2 }, startUtc: '2027-12-31T23:59:00Z', endUtc: '2028-01-01T00:01:00Z' })).rejects.toMatchObject({ code: 'COVERAGE' });
    }
  }, 90_000);
});
