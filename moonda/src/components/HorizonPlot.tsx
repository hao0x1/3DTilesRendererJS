import { useEffect, useId, useRef, useState } from 'react';
import { GlobeHemisphereWest, Sun } from '@phosphor-icons/react';
import type { Site, SkySample } from '../types';

interface Props {
  site: Site | null;
  sample: SkySample | null;
  terrainEnabled: boolean;
  unavailableMessage?: string;
}

const compass = [
  { azimuth: 0, name: 'N' },
  { azimuth: 90, name: 'E' },
  { azimuth: 180, name: 'S' },
  { azimuth: 270, name: 'W' },
  { azimuth: 360, name: 'N' },
];
const signed = (value: number) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)}°`;

export default function HorizonPlot({ site, sample, terrainEnabled, unavailableMessage = 'Updating observer horizon…' }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(260, entries[0].contentRect.width)));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  const heading = <div className="horizon-panel-heading"><span className="eyebrow">THE VIEW FROM HERE</span><h2>Your local skyline.</h2><p>{terrainEnabled ? 'The terrain profile shows what can block the Sun or Earth at each direction.' : 'The geometric horizon provides a smooth reference without terrain obstruction.'}</p><div className="horizon-legend"><span className="solar"><Sun size={15} />Sun centre</span><span className="earth"><GlobeHemisphereWest size={15} />Earth centre</span></div></div>;
  if (!site || !sample) return <section className="horizon-panel" aria-label="Terrain horizon and current Sun and Earth positions">
    {heading}<div className="horizon-plot" ref={host}><svg viewBox={`0 0 ${width} 180`} role="img" aria-label={unavailableMessage}><text x={width / 2} y="88" textAnchor="middle" className="horizon-axis-label">{unavailableMessage}</text></svg></div>
  </section>;

  const terrain = site.horizon.elevationDeg;
  const hasProfile = terrain.length > 0 && terrain.every(Number.isFinite);
  const profile: [number, number][] = terrainEnabled && hasProfile
    ? terrain.map((elevation, index) => [index * site.horizon.azimuthStepDeg, elevation])
    : [[0, 0], [360, 0]];
  if (profile[profile.length - 1][0] < 360) profile.push([360, profile[0][1]]);
  const elevations = [0, sample.sunEl, sample.earthEl, ...(terrainEnabled ? terrain : [0])].filter(Number.isFinite);
  const low = Math.min(...elevations);
  const high = Math.max(...elevations);
  const pad = Math.max(1, (high - low) * .22);
  const minY = low - pad;
  const maxY = high + pad;
  const height = 180;
  const left = 58, right = width - 18, top = 17, bottom = 135;
  const x = (azimuth: number) => left + azimuth / 360 * (right - left);
  const y = (elevation: number) => top + (maxY - elevation) / (maxY - minY) * (bottom - top);
  const points = profile.map(([azimuth, elevation]) => `${x(Math.min(360, azimuth))},${y(elevation)}`).join(' ');
  const terrainArea = `${left},${bottom} ${points} ${right},${bottom}`;
  const azimuth = (value: number) => ((value % 360) + 360) % 360;
  const sun = { x: x(azimuth(sample.sunAz)), y: y(sample.sunEl) };
  const earth = { x: x(azimuth(sample.earthAz)), y: y(sample.earthEl) };
  const labelsCollide = Math.abs(sun.x - earth.x) < 110 && Math.abs(sun.y - earth.y) < 29;
  const textX = (pointX: number) => Math.max(left + 4, Math.min(right - 4, pointX));
  const anchor = (pointX: number) => pointX < left + 65 ? 'start' : pointX > right - 65 ? 'end' : 'middle';
  const labelY = (pointY: number, below = false) => Math.max(top + 11, Math.min(bottom - 7, pointY + (below ? 20 : -12)));
  const ticks = [maxY, 0, minY];

  return <section className="horizon-panel" aria-label="Terrain horizon and current Sun and Earth positions">
    {heading}
    <div className="horizon-plot" ref={host}>
      {terrainEnabled && !hasProfile ? <p className="horizon-unavailable">The terrain horizon profile is unavailable for this site.</p> : <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
        <title id={titleId}>Current Sun and Earth elevations against the {terrainEnabled ? 'terrain' : 'geometric'} horizon at {site.name}</title>
        <desc id={descriptionId}>The horizontal axis is azimuth from north through east, south and west. The vertical axis is elevation in degrees. Sun centre elevation {sample.sunEl.toFixed(2)} degrees, horizon {sample.sunHorizon.toFixed(2)} degrees. Earth centre elevation {sample.earthEl.toFixed(2)} degrees, horizon {sample.earthHorizon.toFixed(2)} degrees. A marker above the profile has a clear geometric line of sight under this model.</desc>
        {ticks.map((tick, i) => <g key={i}><line x1={left} x2={right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? 'horizon-zero' : 'horizon-grid'} /><text x={left - 9} y={y(tick) + 4} textAnchor="end" className="horizon-axis-label">{tick.toFixed(1)}°</text></g>)}
        {compass.map(direction => <line key={direction.azimuth} x1={x(direction.azimuth)} x2={x(direction.azimuth)} y1={top} y2={bottom} className="horizon-grid" />)}
        <polygon points={terrainArea} className="horizon-terrain-fill" />
        <polyline points={points} className="horizon-terrain-line" />
        <line x1={sun.x} x2={sun.x} y1={sun.y} y2={y(sample.sunHorizon)} className="horizon-clearance horizon-clearance-sun" />
        <line x1={earth.x} x2={earth.x} y1={earth.y} y2={y(sample.earthHorizon)} className="horizon-clearance horizon-clearance-earth" />
        <circle cx={sun.x} cy={sun.y} r="4.5" className="horizon-sun-marker" />
        <path d={`M${earth.x},${earth.y - 5} l5,5 -5,5 -5,-5 z`} className="horizon-earth-marker" />
        <text x={textX(sun.x)} y={labelY(sun.y)} textAnchor={anchor(sun.x)} className="horizon-body-label">Sun {signed(sample.sunEl)}</text>
        <text x={textX(earth.x)} y={labelY(earth.y, labelsCollide)} textAnchor={anchor(earth.x)} className="horizon-body-label">Earth {signed(sample.earthEl)}</text>
        <line x1={left} x2={right} y1={bottom} y2={bottom} className="horizon-frame" />
        {compass.map(direction => <text key={direction.azimuth} x={x(direction.azimuth)} y={bottom + 20} textAnchor={direction.azimuth === 0 ? 'start' : direction.azimuth === 360 ? 'end' : 'middle'} className="horizon-axis-label">{direction.name} {direction.azimuth}°</text>)}
        <text x={(left + right) / 2} y={height - 2} textAnchor="middle" className="horizon-axis-title">Azimuth (degrees clockwise from north)</text>
        <text x="12" y={(top + bottom) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(top + bottom) / 2})`} className="horizon-axis-title">Elevation (°)</text>
      </svg>}
    </div>
  </section>;
}
