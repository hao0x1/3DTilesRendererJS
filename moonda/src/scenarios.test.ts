import { describe, expect, it } from 'vitest';
import { analyzeScenario, compareScenarios, componentSamplesAtTime, delayedScenario } from './scenarios';
import type { PreparedScenario, ScenarioDefinition } from './scenarios';
import type { EnergyModel } from './energy';
import type { Site } from './types';

const origin = Date.parse('2026-11-29T00:00:00Z');
const utc = (hour: number) => new Date(origin + hour * 3_600_000).toISOString();

function component(height: number, horizon: number, shiftHours = 0): Site {
  return {
    id: `synthetic-${height}`, name: 'Synthetic component fixture', latitudeDeg: -89, longitudeDeg: 10,
    observerHeightM: height, description: 'Synthetic plumbing test, not a NASA observation.',
    horizon: { azimuthStepDeg: 90, elevationDeg: [horizon, horizon, horizon, horizon], maxRangeKm: 200, terrainResolutionM: 80, method: 'Synthetic' },
    terrain: { size: 1, bounds: { eastMinM: 0, eastMaxM: 0, northMinM: 0, northMaxM: 0 }, heightsM: [0], referenceRadiusM: 1737400 },
    ephemeris: { timesUtc: [0, 1, 2].map(hour => utc(hour + shiftHours)), sunAzDeg: [0, 0, 0], sunElDeg: [2, 2, 2], earthAzDeg: [180, 180, 180], earthElDeg: [2, 2, 2] },
    provenance: [], limitations: [],
  };
}

function fixture(id = 'A', shiftHours = 0): { prepared: PreparedScenario; scenario: ScenarioDefinition } {
  const panelSite = component(1, 0, shiftHours);
  const antennaSite = component(10, 5, shiftHours);
  return {
    prepared: { scenarioId: id, pointId: 'point-1', regionId: 'test-region', latitudeDeg: -89, longitudeDeg: 10, surfaceElevationM: 0, modelVersion: 'synthetic-test', panelSite, antennaSite, bodyGeometry: { timesUtc: [...panelSite.ephemeris.timesUtc], sunDistanceAu: [1, 1, 1], sunAngularRadiusDeg: [0.266, 0.266, 0.266], earthAngularRadiusDeg: [0.95, 0.95, 0.95] } },
    scenario: { id, pointId: 'point-1', regionId: 'test-region', startUtc: utc(shiftHours), durationHours: 2, panelHeightM: 1, antennaHeightM: 10, maxDarkHours: 2, maxEarthGapHours: 2, terrainEnabled: true },
  };
}

function equipment(): EnergyModel {
  return { panel: { areaM2: 1, efficiency: 1, deratingFactor: 1, mode: 'sun-tracking', tiltDeg: 0, azimuthDeg: 0 }, battery: { capacityWh: 1000, initialChargeWh: 0, reserveWh: 0, chargeEfficiency: 1, dischargeEfficiency: 1 }, loadW: 100, referenceIrradianceWm2: 1000 };
}

describe('separate solar and antenna observers', () => {
  it('combines Sun visibility from panel height with Earth visibility from antenna height', () => {
    const { prepared, scenario } = fixture();
    const result = analyzeScenario(prepared, scenario);
    expect(result.status).toBe('complete');
    expect(result.visibility?.solarPercent).toBe(100);
    expect(result.visibility?.earthPercent).toBe(0);
    expect(result.visibility?.overlapPercent).toBe(0);
    expect(result.visibility?.longestEarthGapHours).toBe(2);
    expect(result.visibilitySegments.every(segment => segment.sunVisible && !segment.earthVisible)).toBe(true);
  });

  it('rejects stale geometry when a component height or point changes', () => {
    const { prepared, scenario } = fixture();
    const raised = analyzeScenario(prepared, { ...scenario, antennaHeightM: 20 });
    expect(raised.status).toBe('unsupported');
    expect(raised.visibility).toBeNull();
    expect(raised.message).toMatch(/prepare new component horizons/);
    expect(analyzeScenario(prepared, { ...scenario, pointId: 'nearby-point' }).status).toBe('unsupported');
  });

  it('keeps each 3D receiver view coherent while providing separately labelled combined card values', () => {
    const { prepared } = fixture();
    const result = componentSamplesAtTime(prepared, origin + 3_600_000);
    expect(result.panel.earthVisible).toBe(true);
    expect(result.antenna.earthVisible).toBe(false);
    expect(result.combined.sunVisible).toBe(true);
    expect(result.combined.earthVisible).toBe(false);
    expect(() => componentSamplesAtTime(prepared, origin - 1)).toThrow(/outside prepared date coverage/);
    expect(() => componentSamplesAtTime(prepared, Number.NaN)).toThrow(/finite UTC instant/);
  });
});

describe('exact UTC A/B comparison', () => {
  it('shifts arrival by 72 elapsed hours across the month boundary without mutating A', () => {
    const { scenario } = fixture();
    const shifted = delayedScenario(scenario);
    expect(shifted.id).toBe('B');
    expect(shifted.startUtc).toBe('2026-12-02T00:00:00.000Z');
    expect(Date.parse(shifted.startUtc) - Date.parse(scenario.startUtc)).toBe(72 * 3_600_000);
    expect(shifted.panelHeightM).toBe(scenario.panelHeightM);
    expect(shifted.durationHours).toBe(scenario.durationHours);
    expect(scenario.startUtc).toBe(utc(0));
  });

  it('requires new date coverage rather than clamping a delayed arrival onto the old cache', () => {
    const { prepared, scenario } = fixture();
    const delayed = delayedScenario(scenario);
    const result = analyzeScenario({ ...prepared, scenarioId: 'B' }, delayed);
    expect(result.status).toBe('incomplete');
    expect(result.visibility).toBeNull();
    expect(result.message).toMatch(/outside prepared date coverage/);
  });

  it('analyzes A and B on independent UTC axes and reports B-minus-A deltas', () => {
    const a = fixture('A');
    const b = fixture('B', 72);
    b.prepared.panelSite.ephemeris.sunElDeg = [-2, -2, -2];
    const result = compareScenarios(a.prepared, a.scenario, b.prepared, b.scenario);
    expect(result.bothComplete).toBe(true);
    expect(result.delta?.solarPercent).toBe(-100);
    expect(result.a.visibility?.samples[0].timeUtc).toBe(utc(0));
    expect(result.b.visibility?.samples[0].timeUtc).toBe(utc(72));
  });

  it('rejects ambiguous local timestamps and incomplete component axes', () => {
    const { prepared, scenario } = fixture();
    expect(analyzeScenario(prepared, { ...scenario, startUtc: '2026-11-29T00:00:00' }).status).toBe('invalid');
    expect(analyzeScenario(prepared, { ...scenario, startUtc: '2027-02-30T00:00:00Z' }).status).toBe('invalid');
    prepared.antennaSite.ephemeris.earthElDeg.pop();
    expect(analyzeScenario(prepared, scenario).status).toBe('incomplete');
  });
});

describe('component-specific, finite-disc energy estimates', () => {
  it('uses real supplied Sun distance and the panel horizon, independently of antenna visibility', () => {
    const { prepared, scenario } = fixture();
    prepared.bodyGeometry.sunDistanceAu = [2, 2, 2];
    const result = analyzeScenario(prepared, scenario, equipment(), { solarDiscRays: 64 });
    expect(result.status).toBe('complete');
    expect(result.visibility?.earthPercent).toBe(0);
    expect(result.energy?.generatedWh).toBeCloseTo(500, 6);
    expect(result.energy?.endingBatteryWh).toBeCloseTo(300, 6);
    expect(result.energy?.energyConservationErrorWh).toBeCloseTo(0, 6);
  });

  it('can generate partial-disc power when the Sun-centre timeline is below the horizon', () => {
    const { prepared, scenario } = fixture();
    prepared.panelSite.ephemeris.sunElDeg = [0, 0, 0];
    const result = analyzeScenario(prepared, scenario, equipment(), { solarDiscRays: 512 });
    expect(result.status).toBe('complete');
    expect(result.visibility?.solarPercent).toBe(0);
    expect(result.energy!.generatedWh).toBeGreaterThan(900);
    expect(result.energy!.generatedWh).toBeLessThan(1100);
    expect(result.energy!.assumptions.some(value => value.includes('visibility timeline separately uses Sun-centre'))).toBe(true);
  });

  it('uses Earth geometry at the panel receiver for eclipses, not the antenna card geometry', () => {
    const { prepared, scenario } = fixture();
    // Deliberately different synthetic angles test source selection; they are not physical height-parallax claims.
    prepared.panelSite.ephemeris.earthAzDeg = [0, 0, 0];
    prepared.panelSite.ephemeris.earthElDeg = [2, 2, 2];
    const result = analyzeScenario(prepared, scenario, equipment(), { solarDiscRays: 64 });
    expect(result.status).toBe('complete');
    expect(result.energy?.generatedWh).toBe(0);
    expect(result.energy?.unmetLoadWh).toBeCloseTo(200);
  });

  it('preserves visibility but flags unavailable energy metadata rather than assuming a range', () => {
    const { prepared, scenario } = fixture();
    prepared.bodyGeometry.sunDistanceAu[1] = 0;
    const result = analyzeScenario(prepared, scenario, equipment());
    expect(result.status).toBe('incomplete');
    expect(result.visibility?.solarPercent).toBe(100);
    expect(result.energy).toBeNull();
    expect(result.message).toMatch(/real Sun range/);
  });
});
