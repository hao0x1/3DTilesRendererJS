import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SOLAR_DISC_RAYS, finiteSolarDisc, type EnergyModel, type EnergyResult } from './energy';
import { horizonAt } from './science';
import { ScenarioEngine, type ScenarioManifest } from './scenarioData';
import { analyzeScenario, componentSamplesAtTime, DEFAULT_ENERGY_STEP_MINUTES, type ScenarioDefinition } from './scenarios';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const origin = 'http://localhost/energy-validation/';
const fetchLocal = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, origin);
  if (!url.pathname.startsWith('/energy-validation/')) return new Response('bad subpath', { status: 404 });
  try { return new Response(await readFile(path.join(publicRoot, url.pathname.slice('/energy-validation/'.length)))); }
  catch { return new Response('missing', { status: 404 }); }
}) as typeof fetch;

interface Case {
  id: string;
  regionId: string;
  startUtc: string;
  durationHours: number;
  mode: 'fixed' | 'sun-tracking';
  azimuthDeg?: number;
  initialChargeWh?: number;
  applicationDefaults?: boolean;
}

const cases: Case[] = [
  { id: 'default-A', regionId: 'connecting-ridge', startUtc: '2026-11-04T00:00:00Z', durationHours: 48, mode: 'sun-tracking' },
  { id: 'default-B-plus72h', regionId: 'connecting-ridge', startUtc: '2026-11-07T00:00:00Z', durationHours: 48, mode: 'sun-tracking' },
  { id: 'sunrise-Nov5', regionId: 'connecting-ridge', startUtc: '2026-11-05T00:00:00Z', durationHours: 48, mode: 'sun-tracking' },
  { id: 'sunrise-Nov6', regionId: 'connecting-ridge', startUtc: '2026-11-06T00:00:00Z', durationHours: 48, mode: 'sun-tracking' },
  { id: 'sunrise-Nov5-fixed', regionId: 'connecting-ridge', startUtc: '2026-11-05T00:00:00Z', durationHours: 48, mode: 'fixed', azimuthDeg: 90 },
  { id: 'March3-eclipse', regionId: 'shackleton-peak', startUtc: '2026-03-03T10:00:00Z', durationHours: 3, mode: 'sun-tracking', initialChargeWh: 50 },
  { id: 'March3-eclipse-fixed', regionId: 'shackleton-peak', startUtc: '2026-03-03T10:00:00Z', durationHours: 3, mode: 'fixed', azimuthDeg: 240, initialChargeWh: 50 },
  { id: 'March3-eclipse-high-charge', regionId: 'shackleton-peak', startUtc: '2026-03-03T10:00:00Z', durationHours: 3, mode: 'sun-tracking', initialChargeWh: 1_000 },
  { id: 'application-default-A', regionId: 'connecting-ridge', startUtc: '2026-11-04T00:00:00Z', durationHours: 48, mode: 'sun-tracking', applicationDefaults: true },
];

function equipment(entry: Case): EnergyModel {
  if (entry.applicationDefaults) return {
    panel: { areaM2: 2, efficiency: .28, deratingFactor: .75, mode: 'sun-tracking', tiltDeg: 80, azimuthDeg: 0 },
    battery: { capacityWh: 2_000, initialChargeWh: 1_600, reserveWh: 400, chargeEfficiency: .95, dischargeEfficiency: .95 },
    loadW: 80,
  };
  return {
    panel: { areaM2: 2, efficiency: .28, deratingFactor: .8, mode: entry.mode, tiltDeg: 80, azimuthDeg: entry.azimuthDeg ?? 0 },
    battery: { capacityWh: 2_000, initialChargeWh: entry.initialChargeWh ?? 1_000, reserveWh: 200, chargeEfficiency: .9, dischargeEfficiency: .9 },
    loadW: 100,
  };
}

function summary(result: EnergyResult) {
  return {
    generatedWh: result.generatedWh, minBatteryWh: result.minBatteryWh, unmetLoadWh: result.unmetLoadWh,
    endingBatteryWh: result.endingBatteryWh, spilledWh: result.spilledWh,
    conservationResidualWh: result.energyConservationErrorWh,
  };
}

function difference(actual: EnergyResult, reference: EnergyResult, model: EnergyModel) {
  const relative = (a: number, b: number) => Math.abs(b) > 1e-9 ? 100 * Math.abs(a - b) / Math.abs(b) : null;
  return {
    generatedWh: actual.generatedWh - reference.generatedWh,
    generatedRelativePercent: relative(actual.generatedWh, reference.generatedWh),
    minBatteryWh: actual.minBatteryWh - reference.minBatteryWh,
    minBatteryRelativePercent: relative(actual.minBatteryWh, reference.minBatteryWh),
    minBatteryPercentCapacity: 100 * Math.abs(actual.minBatteryWh - reference.minBatteryWh) / model.battery.capacityWh,
    unmetLoadWh: actual.unmetLoadWh - reference.unmetLoadWh,
    unmetLoadRelativePercent: relative(actual.unmetLoadWh, reference.unmetLoadWh),
    unmetLoadPercentDemand: 100 * Math.abs(actual.unmetLoadWh - reference.unmetLoadWh) / reference.loadWh,
  };
}

describe('real native-data solar-energy convergence', () => {
  it('checks default dates, terrain sunrise, a real eclipse and fixed panels against finer quadrature', async () => {
    const manifestBytes = await readFile(path.join(publicRoot, 'scenarios/manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString()) as ScenarioManifest;
    const engine = new ScenarioEngine(`${origin}scenarios/manifest.json`, fetchLocal);
    const legacy = { cadenceMinutes: 5, maxEnergyStepMinutes: 5, solarDiscRays: 256 };
    const production = { cadenceMinutes: 5, maxEnergyStepMinutes: DEFAULT_ENERGY_STEP_MINUTES, solarDiscRays: DEFAULT_SOLAR_DISC_RAYS };
    const reference = { cadenceMinutes: .5, maxEnergyStepMinutes: .5, solarDiscRays: 4096 };
    const referenceCheck = { cadenceMinutes: .25, maxEnergyStepMinutes: .25, solarDiscRays: 8192 };
    const measurements = [];
    for (const entry of cases) {
      const model = equipment(entry);
      const scenario: ScenarioDefinition = {
        id: entry.id, regionId: entry.regionId, pointId: `${entry.regionId}:0:0`,
        startUtc: entry.startUtc, durationHours: entry.durationHours,
        panelHeightM: 2, antennaHeightM: 2, maxDarkHours: 12, maxEarthGapHours: 12, terrainEnabled: true,
      };
      const request = {
        scenarioId: scenario.id, pointId: scenario.pointId,
        point: { regionId: entry.regionId, eastM: 0, northM: 0, panelHeightM: 2, antennaHeightM: 2 },
        startUtc: scenario.startUtc,
        endUtc: new Date(Date.parse(entry.startUtc) + entry.durationHours * 3_600_000).toISOString(),
      };
      const coarseData = await engine.prepare({ ...request, cadenceMinutes: production.cadenceMinutes }, { yieldControl: async () => {} });
      const fineData = await engine.prepare({ ...request, cadenceMinutes: reference.cadenceMinutes }, { yieldControl: async () => {} });
      let began = performance.now();
      const coarse = analyzeScenario(coarseData, scenario, model, legacy);
      const legacyMs = performance.now() - began;
      began = performance.now();
      // Omitted options deliberately exercise the defaults shipped to users.
      const refined = analyzeScenario(coarseData, scenario, model);
      const productionMs = performance.now() - began;
      began = performance.now();
      const fine = analyzeScenario(fineData, scenario, model, reference);
      const referenceMs = performance.now() - began;
      expect(coarse.status, `${entry.id}: ${coarse.message}`).toBe('complete');
      expect(refined.status, `${entry.id}: ${refined.message}`).toBe('complete');
      expect(fine.status, `${entry.id}: ${fine.message}`).toBe('complete');
      const actual = coarse.energy!;
      const proposed = refined.energy!;
      const expected = fine.energy!;
      expect(Math.abs(actual.energyConservationErrorWh)).toBeLessThan(1e-7);
      expect(Math.abs(expected.energyConservationErrorWh)).toBeLessThan(1e-7);
      let eclipseCheck: null | { utc: string; sunCentreHorizonClearanceDeg: number; visibleDiscFraction: number; terrainOnlyVisibleDiscFraction: number } = null;
      if (entry.id.startsWith('March3')) {
        const utc = '2026-03-03T11:30:00.000Z';
        const sky = componentSamplesAtTime(fineData, Date.parse(utc)).panel;
        const index = fineData.bodyGeometry.timesUtc.indexOf(utc);
        expect(index).toBeGreaterThanOrEqual(0);
        const discInput = {
          sunAzDeg: sky.sunAz, sunElDeg: sky.sunEl,
          earthAzDeg: sky.earthAz, earthElDeg: sky.earthEl,
          sunAngularRadiusDeg: fineData.bodyGeometry.sunAngularRadiusDeg[index],
          earthAngularRadiusDeg: fineData.bodyGeometry.earthAngularRadiusDeg[index],
          horizonAtAzimuth: (azimuth: number) => horizonAt(fineData.panelSite, azimuth, true),
          panel: model.panel, rayCount: reference.solarDiscRays,
        };
        const masked = finiteSolarDisc(discInput);
        const terrainOnly = finiteSolarDisc({ ...discInput, earthAngularRadiusDeg: 0 });
        eclipseCheck = { utc, sunCentreHorizonClearanceDeg: sky.sunEl - sky.sunHorizon, visibleDiscFraction: masked.visibleDiscFraction, terrainOnlyVisibleDiscFraction: terrainOnly.visibleDiscFraction };
        expect(eclipseCheck.sunCentreHorizonClearanceDeg).toBeGreaterThan(.25);
        expect(masked.effectiveIncidenceFactor).toBe(0);
        expect(terrainOnly.visibleDiscFraction).toBe(1);
      }
      const legacyDelta = difference(actual, expected, model);
      const delta = difference(proposed, expected, model);
      let referenceConvergence = null;
      if (entry.id === 'default-A' || entry.id === 'March3-eclipse') {
        const checkData = await engine.prepare({ ...request, cadenceMinutes: referenceCheck.cadenceMinutes }, { yieldControl: async () => {} });
        const check = analyzeScenario(checkData, scenario, model, referenceCheck);
        expect(check.status, `${entry.id}: finer reference: ${check.message}`).toBe('complete');
        referenceConvergence = { reference: summary(check.energy!), delta: difference(expected, check.energy!, model) };
        expect(referenceConvergence.delta.generatedRelativePercent, `${entry.id}: reference generation convergence`).toBeLessThan(.25);
        expect(referenceConvergence.delta.unmetLoadRelativePercent, `${entry.id}: reference unmet-load convergence`).toBeLessThan(.25);
      }
      if (entry.id === 'March3-eclipse-high-charge') {
        expect(expected.minBatteryWh).toBeGreaterThan(0);
        expect(expected.minBatteryWh).toBeLessThan(model.battery.initialChargeWh);
      }
      const measurement = {
        ...entry, point: request.point, equipment: model,
        sourceModel: coarseData.modelVersion, sourceUtcStart: request.startUtc, sourceUtcEnd: request.endUtc,
        sunCentreHorizonPercent: coarse.visibility!.solarPercent,
        legacy: summary(actual), production: summary(proposed), reference: summary(expected), legacyDelta, delta, eclipseCheck,
        timingMs: { legacy: legacyMs, production: productionMs, reference: referenceMs }, referenceConvergence,
      };
      measurements.push(measurement);
      console.log(`Energy convergence ${entry.id}: ${JSON.stringify(delta)}`);
      console.log(`Energy convergence legacy ${entry.id}: ${JSON.stringify(legacyDelta)}`);
    }
    const report = {
      schemaVersion: 1, generatedAt: new Date().toISOString(),
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), datasetId: manifest.datasetId,
      purpose: 'Numerical convergence at selected native-data scenarios, not physical accuracy, terrain uncertainty, or flight qualification.',
      legacy, production, reference, referenceCheck,
      acceptance: 'Production generated energy, minimum battery and unmet load within 1% of nonzero reference, or 0.01 Wh for zero reference. Legacy settings remain reported for comparison. Two sensitive cases also compare the reference with 15-second/8192-ray quadrature.',
      limitations: [
        'Both runs share the same 0.25-degree finite-bearing terrain model and hourly SPICE cache; this does not validate their physical errors.',
        'Reference uses 30-second component ephemerides, 30-second midpoint quadrature and 4096 projected solar-disc rays. It is a finer numerical comparison, not an exact solution.',
        'Production 1-minute/512-ray power quadrature retains the prepared 5-minute component geometry axis; it does not introduce new NASA observations.',
        'Timing is a single Node.js run on this development machine, excluding native terrain preparation; it is not a browser performance guarantee.',
        'The March case intentionally uses a low initial battery charge to exercise unmet-load accounting.',
        'Sun-centre horizon clearance excludes Earth eclipse; per-ray electrical generation includes opaque-Earth eclipse.',
      ],
      cases: measurements,
    };
    if (process.env.MOONDA_UPDATE_ENERGY_REPORT === '1') await writeFile(path.join(publicRoot, 'scenarios/energy-convergence.json'), `${JSON.stringify(report, null, 2)}\n`);
    for (const measurement of measurements) {
      expect(measurement.delta.generatedRelativePercent ?? 100 * Math.abs(measurement.delta.generatedWh), `${measurement.id}: generated energy`).toBeLessThanOrEqual(1);
      expect(measurement.delta.minBatteryRelativePercent ?? 100 * Math.abs(measurement.delta.minBatteryWh), `${measurement.id}: minimum battery`).toBeLessThanOrEqual(1);
      expect(measurement.delta.unmetLoadRelativePercent ?? 100 * Math.abs(measurement.delta.unmetLoadWh), `${measurement.id}: unmet load`).toBeLessThanOrEqual(1);
    }
  }, 120_000);
});
