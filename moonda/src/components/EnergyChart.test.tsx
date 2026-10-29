import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import EnergyChart from './EnergyChart';
import type { EnergyChartPoint, EnergyGenerationInterval } from './EnergyChart';

const at = (hours: number) => new Date(Date.parse('2026-11-01T00:00:00Z') + hours * 3_600_000).toISOString();
// Engine points carry the power of the preceding interval, whereas the chart
// readout at a boundary must use the interval that starts at that instant.
const points: EnergyChartPoint[] = [0, 1, 2].map((hour, index) => ({
  timeUtc: at(hour), generationW: [0, 0, 100][index], batteryWh: 1000, unmetLoadWh: 0,
}));
const intervals: EnergyGenerationInterval[] = [
  { startUtc: at(0), endUtc: at(1), generationW: 0 },
  { startUtc: at(1), endUtc: at(2), generationW: 100 },
];

function renderAt(hours: number, generationIntervals = intervals) {
  const markup = renderToStaticMarkup(<EnergyChart points={points} generationIntervals={generationIntervals} capacityWh={1000} reserveWh={100} currentTimeUtc={at(hours)} />);
  const readout = markup.match(/<span class="energy-chart-metric energy-chart-generation-readout"[^>]*>.*?<\/strong><\/span>/s)?.[0];
  expect(readout, 'The actual interval-power readout must be present').toBeDefined();
  return { markup, readout: readout! };
}

describe('EnergyChart interval power', () => {
  it('reads the containing power interval at boundaries, preserves a dark interval, and leaves gaps unavailable', () => {
    const boundary = renderAt(1);
    expect(boundary.readout).toContain('<strong>100 <span>W</span></strong>');
    expect(boundary.markup).toContain('interval power 100 watts; battery 1,000 watt-hours');

    expect(renderAt(.5).readout).toContain('<strong>0 <span>W</span></strong>');
    expect(renderAt(2).readout).toContain('<strong>100 <span>W</span></strong>');

    const gap = renderAt(1, [
      { startUtc: at(0), endUtc: at(.5), generationW: 0 },
      { startUtc: at(1.5), endUtc: at(2), generationW: 100 },
    ]);
    expect(gap.readout).toContain('<strong>— <span>W</span></strong>');
    expect(gap.markup).toContain('interval power unavailable');
    expect(gap.markup).not.toContain('class="energy-chart-generation-point"');
  });
});
