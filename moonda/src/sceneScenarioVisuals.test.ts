import { describe, expect, it } from 'vitest';
import { Mesh, Vector3 } from 'three';
import { disposeObject } from './sceneAssets';
import { scenarioObserverMarker } from './sceneScenarioVisuals';

const origin = { latitudeDeg: -89.78, longitudeDeg: -137.39, groundHeightM: 1_592.5, referenceRadiusM: 1_737_400 };

describe('locked scenario illustration', () => {
  it('draws distinct physical component heights, panel area and the supplied energy-model normal', () => {
    const marker = scenarioObserverMarker(origin, {
      id: 'B', regionId: 'shackleton-rim', latitudeDeg: origin.latitudeDeg, longitudeDeg: origin.longitudeDeg,
      groundHeightM: origin.groundHeightM, antennaHeightM: 4, panelHeightM: 1.5, panelAreaM2: 6,
      panelNormalEnu: { east: 1, north: 0, up: 0 },
    });
    const antenna = marker.getObjectByName('antenna-observer')!;
    const panel = marker.getObjectByName('solar-panel') as Mesh;
    expect(antenna.position.y).toBe(4);
    expect(panel.position.y).toBe(1.5);
    const top = new Vector3(0, 1, 0).applyQuaternion(panel.quaternion);
    expect(top.x).toBeCloseTo(1, 12);
    expect(top.y).toBeCloseTo(0, 12);
    const bounds = panel.geometry;
    bounds.computeBoundingBox();
    const size = bounds.boundingBox!.getSize(new Vector3());
    expect(size.x * size.z).toBeCloseTo(6, 6);
    expect(marker.position.length()).toBeLessThan(0.000001);
    expect(marker.userData.observerId).toBe('B');
    disposeObject(marker);
  });
});
