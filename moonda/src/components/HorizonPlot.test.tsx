import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import HorizonPlot from './HorizonPlot';

it('keeps the skyline region mounted without drawing stale sky positions while an observer updates', () => {
  const markup = renderToStaticMarkup(<HorizonPlot site={null} sample={null} terrainEnabled />);
  expect(markup).toContain('Your local skyline.');
  expect(markup).toContain('Updating observer horizon');
  expect(markup).toContain('<svg');
  expect(markup).not.toContain('<polyline');
  expect(markup).not.toContain('Sun centre elevation');
});
