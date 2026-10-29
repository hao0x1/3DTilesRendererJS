import { describe, expect, it } from 'vitest';
import { Mesh, Vector3 } from 'three';
import { disposeObject } from './sceneAssets';
import { layoutSceneMarkerBadges, layoutSceneMarkerCaption, scenarioObserverMarker, sceneCaptionOwner } from './sceneScenarioVisuals';

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

describe('scenario marker captions', () => {
  it('selects exactly one visible owner, preserving keyboard focus ahead of hover', () => {
    const visible = new Set(['A', 'B', 'candidate']);
    expect(sceneCaptionOwner({ focused: 'A', hovered: 'B', candidate: 'candidate', active: 'B' }, visible)).toBe('A');
    expect(sceneCaptionOwner({ focused: 'A', hovered: null, active: 'B' }, visible)).toBe('A');
    expect(sceneCaptionOwner({ hovered: 'B', active: 'A' }, visible)).toBe('B');
    expect(sceneCaptionOwner({ focused: 'offscreen', hovered: 'other-region', active: 'A' }, visible)).toBe('A');
    expect(sceneCaptionOwner({ active: 'offscreen' }, visible)).toBeNull();
  });

  it('separates coincident and nearby touch badges at every viewport edge without moving their true anchors', () => {
    for (const [x, y] of [[320, 180], [2, 2], [638, 2], [2, 358], [638, 358]]) {
      const anchors = [{ id: 'A', x, y }, { id: 'B', x: x + 3, y: y + 2 }, { id: 'candidate', x, y }];
      const badges = layoutSceneMarkerBadges(anchors, 640, 360, 44);
      expect(badges).toHaveLength(3);
      for (const badge of badges) {
        const anchor = anchors.find(point => point.id === badge.id)!;
        expect(badge.anchorX).toBe(anchor.x); expect(badge.anchorY).toBe(anchor.y);
        expect(badge.x - 22).toBeGreaterThanOrEqual(12); expect(badge.x + 22).toBeLessThanOrEqual(628);
        expect(badge.y - 22).toBeGreaterThanOrEqual(12); expect(badge.y + 22).toBeLessThanOrEqual(348);
      }
      for (let i = 0; i < badges.length; i++) for (let j = i + 1; j < badges.length; j++) {
        expect(Math.abs(badges[i].x - badges[j].x) >= 54 || Math.abs(badges[i].y - badges[j].y) >= 54).toBe(true);
      }
    }
  });

  it('places the shared caption inside the viewport and away from all badges and visible HUD', () => {
    const badges = layoutSceneMarkerBadges([{ id: 'A', x: 610, y: 120 }, { id: 'B', x: 611, y: 121 }], 640, 360, 44);
    const hud = [{ x: 400, y: 30, width: 220, height: 110 }, { x: 400, y: 260, width: 220, height: 80 }];
    const caption = layoutSceneMarkerCaption('A', badges, 640, 360, { width: 180, height: 34 }, hud);
    expect(caption).not.toBeNull();
    expect(caption!.x).toBeGreaterThanOrEqual(12); expect(caption!.x + caption!.width).toBeLessThanOrEqual(628);
    expect(caption!.y).toBeGreaterThanOrEqual(12); expect(caption!.y + caption!.height).toBeLessThanOrEqual(348);
    for (const blocked of [...hud, ...badges.map(badge => ({ x: badge.x - 22, y: badge.y - 22, width: 44, height: 44 }))]) {
      const intersects = caption!.x < blocked.x + blocked.width && caption!.x + caption!.width > blocked.x && caption!.y < blocked.y + blocked.height && caption!.y + caption!.height > blocked.y;
      expect(intersects).toBe(false);
    }
    expect(layoutSceneMarkerCaption('A', badges, 640, 360, { width: 180, height: 34 }, [{ x: 0, y: 0, width: 640, height: 360 }])).toBeNull();
  });

  it('keeps the live A/B subpixel case below the same cluster when only hover owner changes', () => {
    // Live DOM badge bounds were A(376,407.84375,31,31) and
    // B(417,407.75,31,31). Their different bottoms must not pick sides.
    const badges = [
      { id: 'A', x: 391.5, y: 423.34375, anchorX: 391.5, anchorY: 423.34375, size: 31 },
      { id: 'B', x: 432.5, y: 423.25, anchorX: 432.5, anchorY: 423.25, size: 31 },
    ];
    for (let i = -50; i <= 50; i++) {
      const near = badges.map(badge => ({ ...badge, y: badge.y + i * 0.000001 }));
      const a = layoutSceneMarkerCaption('A', near, 800, 650, { width: 150, height: 29.40625 })!;
      const b = layoutSceneMarkerCaption('B', near, 800, 650, { width: 127, height: 29.40625 })!;
      expect(a.side).toBe('below'); expect(b.side).toBe('below');
      expect(a.y).toBe(b.y);
      expect(a.y).toBeCloseTo(448.84375 + i * 0.000001, 8);
      expect(a.x + a.width / 2).toBe(b.x + b.width / 2);
      expect(a.clusterKey).toBe(b.clusterKey);
    }
  });

  it('anchors A/B/candidate ownership to one connected envelope', () => {
    const badges = layoutSceneMarkerBadges([{ id: 'A', x: 320, y: 240 }, { id: 'B', x: 320, y: 240 }, { id: 'candidate', x: 320, y: 240 }], 800, 600, 31);
    const placements = ['A', 'B', 'candidate'].map(id => layoutSceneMarkerCaption(id, badges, 800, 600, { width: 180, height: 34 })!);
    expect(new Set(placements.map(placement => placement.clusterKey)).size).toBe(1);
    expect(new Set(placements.map(placement => placement.y)).size).toBe(1);
    expect(placements.every(placement => placement.side === 'below')).toBe(true);
  });

  it('uses deterministic fallback sides, keeping a prior valid side until genuinely obstructed', () => {
    const badges = layoutSceneMarkerBadges([{ id: 'A', x: 350, y: 300 }, { id: 'B', x: 391, y: 300.09375 }], 800, 600, 31);
    const size = { width: 180, height: 34 };
    const belowBlock = [{ x: 0, y: 325, width: 800, height: 75 }];
    const above = layoutSceneMarkerCaption('A', badges, 800, 600, size, belowBlock)!;
    expect(above.side).toBe('above');
    const retained = layoutSceneMarkerCaption('B', badges, 800, 600, size, [], 12, 10, { previous: above })!;
    expect(retained.side).toBe('above');
    expect(retained.y).toBe(above.y);
    const changed = layoutSceneMarkerCaption('B', badges, 800, 600, size, [{ x: 0, y: 245, width: 800, height: 50 }], 12, 10, { previous: retained })!;
    expect(changed.side).toBe('below');
  });

  it('retains near-edge cluster membership through small camera movement and resets for another cluster', () => {
    const badge = (id: string, x: number) => ({ id, x, y: 220, anchorX: x, anchorY: 220, size: 31 });
    const initial = layoutSceneMarkerCaption('A', [badge('A', 300), badge('B', 354.5)], 800, 600, { width: 180, height: 34 })!;
    expect(initial.clusterIds).toEqual(['A', 'B']);
    const retained = layoutSceneMarkerCaption('B', [badge('A', 300), badge('B', 358)], 800, 600, { width: 180, height: 34 }, [], 12, 10, { previous: initial })!;
    expect(retained.clusterKey).toBe(initial.clusterKey);
    const other = layoutSceneMarkerCaption('candidate', [badge('A', 300), badge('B', 358), badge('candidate', 650)], 800, 600, { width: 180, height: 34 }, [], 12, 10, { previous: retained })!;
    expect(other.clusterIds).toEqual(['candidate']);
    expect(other.side).toBe('below');
  });
});
