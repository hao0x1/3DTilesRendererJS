import { describe, expect, it } from 'vitest';
import { lunarArcDestination, lunarArcOffsets, lunarObserverAxes, lunarPointToScene, scenePointToLunar } from './sceneCoordinates';

const origin = { latitudeDeg: -89.78, longitudeDeg: -137.39, groundHeightM: 1_592.5, referenceRadiusM: 1_737_400 };

describe('lunar display frame and deliberate terrain picks', () => {
  it('round-trips curved lunar positions across the longitude seam and near the pole', () => {
    for (const point of [
      { latitudeDeg: -89.78, longitudeDeg: -137.39, groundHeightM: 1_592.5 },
      { latitudeDeg: -89.75, longitudeDeg: -135.2, groundHeightM: 1_255.75 },
      { latitudeDeg: -89.95, longitudeDeg: 179.99, groundHeightM: -2_000 },
      { latitudeDeg: -89.91, longitudeDeg: -179.99, groundHeightM: 740 },
    ]) {
      const actual = scenePointToLunar(origin, lunarPointToScene(origin, point));
      expect(actual.latitudeDeg).toBeCloseTo(point.latitudeDeg, 9);
      expect(actual.longitudeDeg).toBeCloseTo(point.longitudeDeg, 9);
      expect(actual.groundHeightM).toBeCloseTo(point.groundHeightM, 7);
    }
  });

  it('uses great-circle arc offsets instead of treating curved mesh coordinates as map distances', () => {
    const point = { latitudeDeg: origin.latitudeDeg + 1 / (origin.referenceRadiusM * Math.PI / 180), longitudeDeg: origin.longitudeDeg, groundHeightM: origin.groundHeightM };
    const offsets = lunarArcOffsets(origin, point);
    expect(offsets.eastM).toBeCloseTo(0, 8);
    expect(offsets.northM).toBeCloseTo(1, 7);
    const scene = lunarPointToScene(origin, point);
    expect(scene.z).toBeLessThan(-1);
    expect(lunarArcOffsets(origin, origin)).toEqual({ eastM: 0, northM: 0 });
    expect(() => lunarArcOffsets(origin, { latitudeDeg: -origin.latitudeDeg, longitudeDeg: origin.longitudeDeg + 180 })).toThrow('antipode');
  });

  it('rotates a nearby observer basis without changing its origin or exaggerating scale', () => {
    const axes = lunarObserverAxes(origin, { latitudeDeg: -89.75, longitudeDeg: -135.2 });
    const dot = (a: typeof axes.up, b: typeof axes.up) => a.x * b.x + a.y * b.y + a.z * b.z;
    expect(dot(axes.up, axes.up)).toBeCloseTo(1, 12);
    expect(dot(axes.east, axes.south)).toBeCloseTo(0, 12);
    expect(dot(axes.up, axes.south)).toBeCloseTo(0, 12);
    const same = lunarObserverAxes(origin, origin);
    expect(same.up.y).toBeCloseTo(1, 12);
    expect(same.east.x).toBeCloseTo(1, 12);
    expect(same.south.z).toBeCloseTo(1, 12);
  });

  it('round-trips the supported 10 metre selection grid through geographic coordinates', () => {
    for (const eastM of [-2_560, -1_230, 0, 1_570, 2_560]) {
      for (const northM of [-2_560, -890, 0, 2_210, 2_560]) {
        const point = lunarArcDestination(origin, eastM, northM);
        const offsets = lunarArcOffsets(origin, point);
        expect(offsets.eastM).toBeCloseTo(eastM, 5);
        expect(offsets.northM).toBeCloseTo(northM, 5);
      }
    }
  });
});
