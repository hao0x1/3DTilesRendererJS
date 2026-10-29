import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { estimateEnergy } from '../energy';
import type { EnergyModel } from '../energy';
import EnergyPanel from './EnergyPanel';

describe('EnergyPanel pending results', () => {
  it('shows the pending state without exposing a supplied previous result', () => {
    const model: EnergyModel = {
      panel: { areaM2: 1, efficiency: .25, deratingFactor: .8, mode: 'sun-tracking', tiltDeg: 0, azimuthDeg: 0 },
      battery: { capacityWh: 100, initialChargeWh: 80, reserveWh: 20, chargeEfficiency: .95, dischargeEfficiency: .95 },
      loadW: 10,
    };
    const result = estimateEnergy([{
      startUtc: '2026-11-01T00:00:00Z', endUtc: '2026-11-01T01:00:00Z', sunAzDeg: 0, sunElDeg: 30, sunVisible: true,
    }], model);
    const props = { scenarioId: 'A' as const, model, result, onChange: () => {} };
    const ready = renderToStaticMarkup(<EnergyPanel {...props} />);
    const pending = renderToStaticMarkup(<EnergyPanel {...props} pending />);
    expect(ready).toContain('class="energy-summary-grid"');
    expect(ready).toContain('class="energy-chart"');
    expect(pending).toContain('class="energy-results-region" aria-busy="true"');
    expect(pending).toContain('Updating scenario estimates');
    expect(pending).not.toContain('class="energy-summary-grid"');
    expect(pending).not.toContain('class="energy-chart"');
    expect(pending).not.toContain('class="energy-model-limits"');
  });
});
