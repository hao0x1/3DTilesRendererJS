import { describe, expect, it } from 'vitest';
import { estimateEnergy, finiteSolarDisc, panelGenerationW, panelNormalEnu } from './energy';
import type { EnergyModel, FiniteSolarDiscInput, SolarPowerInterval } from './energy';

const origin = Date.parse('2027-01-01T00:00:00Z');
const utc = (hours: number) => new Date(origin + hours * 3_600_000).toISOString();

function model(): EnergyModel {
  return {
    panel: { areaM2: 1, efficiency: 1, deratingFactor: 1, mode: 'fixed', tiltDeg: 0, azimuthDeg: 0 },
    battery: { capacityWh: 1000, initialChargeWh: 0, reserveWh: 0, chargeEfficiency: 1, dischargeEfficiency: 1 },
    loadW: 100,
    referenceIrradianceWm2: 1000,
  };
}

function solar(overrides: Partial<SolarPowerInterval> = {}): SolarPowerInterval {
  return { startUtc: utc(0), endUtc: utc(1), sunAzDeg: 0, sunElDeg: 90, sunVisible: true, sunDistanceAu: 1, ...overrides };
}

function disc(overrides: Partial<FiniteSolarDiscInput> = {}): FiniteSolarDiscInput {
  return {
    sunAzDeg: 0, sunElDeg: 0, sunAngularRadiusDeg: 0.266,
    earthAzDeg: 180, earthElDeg: -20, earthAngularRadiusDeg: 0.95,
    horizonAtAzimuth: () => -90,
    panel: { mode: 'sun-tracking', tiltDeg: 0, azimuthDeg: 0 },
    rayCount: 1024,
    ...overrides,
  };
}

describe('panel orientation and solar intensity', () => {
  it('exports the power-model panel normal in named east/north/up coordinates', () => {
    const panel = model().panel;
    expect(panelNormalEnu(panel, 90, 0).up).toBeCloseTo(1, 12);
    panel.tiltDeg = 90;
    panel.azimuthDeg = 90;
    expect(panelNormalEnu(panel, 270, 0).east).toBeCloseTo(1, 12);
    const tracking = panelNormalEnu({ ...panel, mode: 'sun-tracking' }, 180, 30);
    expect(tracking.north).toBeCloseTo(-Math.sqrt(3) / 2, 12);
    expect(tracking.up).toBeCloseTo(0.5, 12);
    expect(Math.hypot(tracking.east, tracking.north, tracking.up)).toBeCloseTo(1, 12);
  });

  it('uses physical panel incidence and inverse-square Sun distance', () => {
    const settings = model();
    expect(panelGenerationW(solar(), settings)).toBeCloseTo(1000);
    expect(panelGenerationW(solar({ sunDistanceAu: 2 }), settings)).toBeCloseTo(250);
    settings.panel.tiltDeg = 90;
    settings.panel.azimuthDeg = 90;
    expect(panelGenerationW(solar({ sunAzDeg: 90, sunElDeg: 0 }), settings)).toBeCloseTo(1000);
    expect(panelGenerationW(solar({ sunAzDeg: 270, sunElDeg: 0 }), settings)).toBe(0);
  });

  it('treats ideal tracking and supplied disc incidence separately from a centre flag', () => {
    const settings = model();
    settings.panel.mode = 'sun-tracking';
    expect(panelGenerationW(solar({ sunElDeg: 1 }), settings)).toBeCloseTo(1000);
    expect(panelGenerationW(solar({ sunVisible: false }), settings)).toBe(0);
    expect(panelGenerationW(solar({ sunVisible: false, effectiveIncidenceFactor: 0.25 }), settings)).toBeCloseTo(250);
  });

  it('labels a missing Sun-distance assumption explicitly', () => {
    const result = estimateEnergy([solar({ sunDistanceAu: undefined })], model());
    expect(result.assumptions.some(value => value.includes('assumes a Sun distance of 1 AU'))).toBe(true);
    expect(result.assumptions.some(value => value.includes('binary Sun-centre'))).toBe(true);
  });
});

describe('finite Sun-disc obstruction', () => {
  it('preserves normal-plane irradiance for a fully visible Sun with ideal tracking', () => {
    const result = finiteSolarDisc(disc());
    expect(result.visibleDiscFraction).toBe(1);
    expect(result.effectiveIncidenceFactor).toBeCloseTo(1, 12);
  });

  it('models a partly risen solar disc and positive fixed-panel power even with centre incidence zero', () => {
    const input = disc({ horizonAtAzimuth: () => 0 });
    const tracking = finiteSolarDisc(input);
    expect(tracking.visibleDiscFraction).toBeCloseTo(0.5, 1);
    const horizontal = finiteSolarDisc({ ...input, panel: { mode: 'fixed', tiltDeg: 0, azimuthDeg: 0 } });
    expect(horizontal.effectiveIncidenceFactor).toBeGreaterThan(0);
    expect(horizontal.effectiveIncidenceFactor).toBeLessThan(0.01);
  });

  it('unions complementary terrain and Earth masks instead of multiplying their visible fractions', () => {
    const terrain = finiteSolarDisc(disc({ horizonAtAzimuth: () => 0, earthAngularRadiusDeg: 0 }));
    const eclipse = finiteSolarDisc(disc({ earthAzDeg: 0, earthElDeg: 1, earthAngularRadiusDeg: 1 }));
    const combined = finiteSolarDisc(disc({ horizonAtAzimuth: () => 0, earthAzDeg: 0, earthElDeg: 1, earthAngularRadiusDeg: 1 }));
    expect(terrain.visibleDiscFraction * eclipse.visibleDiscFraction).toBeGreaterThan(0.15);
    expect(combined.visibleDiscFraction).toBeLessThan(0.1);
  });

  it('models a full geometric eclipse and rejects an invalid horizon', () => {
    const result = finiteSolarDisc(disc({ earthAzDeg: 0, earthElDeg: 0, earthAngularRadiusDeg: 1 }));
    expect(result.visibleDiscFraction).toBe(0);
    expect(result.effectiveIncidenceFactor).toBe(0);
    expect(() => finiteSolarDisc(disc({ horizonAtAzimuth: () => Number.NaN }))).toThrow(/horizon/);
  });
});

describe('electrical energy accounting', () => {
  it('charges from generation remaining after the load and conserves Wh', () => {
    const result = estimateEnergy([solar()], model());
    expect(result.generatedWh).toBe(1000);
    expect(result.loadWh).toBe(100);
    expect(result.endingBatteryWh).toBe(900);
    expect(result.suppliedLoadWh).toBe(100);
    expect(result.unmetLoadWh).toBe(0);
    expect(result.energyConservationErrorWh).toBeCloseTo(0, 10);
  });

  it('accounts for charge losses and curtailment when the battery becomes full', () => {
    const settings = model();
    settings.battery.capacityWh = 300;
    settings.battery.chargeEfficiency = 0.5;
    const result = estimateEnergy([solar()], settings);
    expect(result.endingBatteryWh).toBe(300);
    expect(result.chargeLossWh).toBe(300);
    expect(result.spilledWh).toBe(300);
    expect(result.series.some(point => point.timeUtc === utc(2 / 3) && point.batteryWh === 300)).toBe(true);
    expect(result.energyConservationErrorWh).toBeCloseTo(0, 10);
  });

  it('reports unmet load after depletion rather than implying continuing battery supply', () => {
    const settings = model();
    settings.battery.initialChargeWh = 50;
    settings.battery.dischargeEfficiency = 0.5;
    const result = estimateEnergy([solar({ sunVisible: false })], settings);
    expect(result.endingBatteryWh).toBe(0);
    expect(result.suppliedLoadWh).toBe(25);
    expect(result.unmetLoadWh).toBe(75);
    expect(result.dischargeLossWh).toBe(25);
    expect(result.series.find(point => point.timeUtc === utc(0.25))?.batteryWh).toBe(0);
    expect(result.energyConservationErrorWh).toBeCloseTo(0, 10);
  });

  it('handles an initially empty battery and zero solar supply explicitly', () => {
    const result = estimateEnergy([solar({ sunVisible: false })], model());
    expect(result.minBatteryWh).toBe(0);
    expect(result.suppliedLoadWh).toBe(0);
    expect(result.unmetLoadWh).toBe(100);
    expect(result.series.at(-1)?.unmetLoadWh).toBe(100);
  });

  it('preserves power interval boundaries across a darkness-to-light transition', () => {
    const result = estimateEnergy([
      solar({ sunVisible: false }),
      solar({ startUtc: utc(1), endUtc: utc(2) }),
    ], model());
    expect(result.intervals.map(interval => [interval.startUtc, interval.endUtc, interval.generationW])).toEqual([
      [utc(0), utc(1), 0],
      [utc(1), utc(2), 1000],
    ]);
    // A step chart changes power at 01:00; endpoint samples are not instantaneous power.
    expect(result.series.find(point => point.timeUtc === utc(1))?.batteryWh).toBe(0);
    expect(result.endingBatteryWh).toBe(900);
    expect(result.unmetLoadWh).toBe(100);
    expect(result.generatedWh).toBe(1000);
    expect(result.energyConservationErrorWh).toBeCloseTo(0, 10);
  });

  it('respects bus charge and discharge power limits', () => {
    const discharge = model();
    discharge.battery.initialChargeWh = 100;
    discharge.battery.maxDischargeW = 20;
    const dark = estimateEnergy([solar({ sunVisible: false })], discharge);
    expect(dark.endingBatteryWh).toBe(80);
    expect(dark.unmetLoadWh).toBe(80);
    const charge = model();
    charge.battery.maxChargeW = 50;
    const bright = estimateEnergy([solar()], charge);
    expect(bright.endingBatteryWh).toBe(50);
    expect(bright.spilledWh).toBe(850);
    expect(bright.energyConservationErrorWh).toBeCloseTo(0, 10);
  });

  it('uses reserve as a warning while continuing to account for actual depletion', () => {
    const settings = model();
    settings.battery.initialChargeWh = 15;
    settings.battery.reserveWh = 10;
    settings.loadW = 10;
    const result = estimateEnergy([solar({ sunVisible: false })], settings);
    expect(result.endingBatteryWh).toBe(5);
    expect(result.reserveBreached).toBe(true);
    expect(result.unmetLoadWh).toBe(0);
  });

  it('clips integration to exact UTC bounds and rejects missing coverage', () => {
    const result = estimateEnergy([solar({ endUtc: utc(2) })], model(), { startUtc: utc(0.5), endUtc: utc(1.5) });
    expect(result.coveredHours).toBe(1);
    expect(result.generatedWh).toBe(1000);
    expect(result.series[0].timeUtc).toBe(utc(0.5));
    expect(() => estimateEnergy([solar(), solar({ startUtc: utc(2), endUtc: utc(3) })], model())).toThrow(/gaps/);
    expect(() => estimateEnergy([solar()], model(), { startUtc: utc(0), endUtc: utc(2) })).toThrow(/complete/);
  });

  it('rejects nonphysical user inputs instead of coercing them', () => {
    const settings = model();
    settings.battery.dischargeEfficiency = 0;
    expect(() => estimateEnergy([solar()], settings)).toThrow(/Discharge efficiency/);
    settings.battery.dischargeEfficiency = 1;
    settings.battery.initialChargeWh = 1001;
    expect(() => estimateEnergy([solar()], settings)).toThrow(/capacity/);
  });
});
