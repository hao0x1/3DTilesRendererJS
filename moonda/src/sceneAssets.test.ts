import { describe, expect, it } from 'vitest';
import { DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SphereGeometry, Vector3 } from 'three';
import { anchorLanderToTerrain, applyLunarRelief, genericLander, terrainMesh } from './sceneAssets';

const radius = 1_737_400;
const heightMetadata = {
  url: '/height.u16', width: 4, height: 2, scale: 0.5, bias: -10_000,
  format: 'uint16-le', referenceRadiusMeters: radius,
};

describe('physical display terrain', () => {
  it('decodes the NASA half-metre datum without exaggerating elevation', () => {
    const bytes = new ArrayBuffer(16);
    const values = new DataView(bytes);
    for (let i = 0; i < 8; i++) values.setUint16(i * 2, 23_000, true);
    const sphere = new SphereGeometry(radius, 12, 8);
    const direction = new Vector3().fromBufferAttribute(sphere.attributes.position, 15).normalize();
    const result = applyLunarRelief(sphere, bytes, heightMetadata, radius);
    const point = new Vector3().fromBufferAttribute(sphere.attributes.position, 15);
    expect(result).toEqual({ minMeters: 1_500, maxMeters: 1_500 });
    // Float32 positions at a lunar radius have sub-metre display precision.
    expect(point.length()).toBeCloseTo(radius + 1_500, 0);
    expect(point.clone().normalize().distanceTo(direction)).toBeLessThan(0.000001);
    sphere.dispose();
  });

  it('rejects incompatible bytes and reference radii instead of rendering invented relief', () => {
    const sphere = new SphereGeometry(radius, 8, 4);
    expect(() => applyLunarRelief(sphere, new ArrayBuffer(8), heightMetadata, radius)).toThrow('dimensions');
    expect(() => applyLunarRelief(sphere, new ArrayBuffer(16), { ...heightMetadata, referenceRadiusMeters: 6_371_000 }, radius)).toThrow('reference radii');
    sphere.dispose();
  });

  it('closes both physical poles and smooths UV seams when source-ring heights vary', () => {
    const heights = [0, 200, 400, 600, 1_000, 1_500, 2_000, 2_500];
    const bytes = new ArrayBuffer(16);
    const values = new DataView(bytes);
    heights.forEach((height, i) => values.setUint16(i * 2, (height + 10_000) / 0.5, true));
    const widthSegments = 12, heightSegments = 8, columns = widthSegments + 1;
    const sphere = new SphereGeometry(radius, widthSegments, heightSegments);
    applyLunarRelief(sphere, bytes, heightMetadata, radius);
    const positions = sphere.attributes.position, normals = sphere.attributes.normal;
    for (const row of [0, heightSegments]) {
      const start = row * columns;
      const first = new Vector3().fromBufferAttribute(positions, start);
      const firstNormal = new Vector3().fromBufferAttribute(normals, start);
      expect(first.x).toBe(0); expect(first.z).toBe(0);
      expect(Math.abs(first.y)).toBeCloseTo(radius + (row === 0 ? 300 : 1_750), 0);
      expect(firstNormal.length()).toBeCloseTo(1, 6);
      expect(firstNormal.dot(first.clone().normalize())).toBeGreaterThan(0.99);
      for (let col = 1; col < columns; col++) {
        expect(new Vector3().fromBufferAttribute(positions, start + col).distanceTo(first)).toBe(0);
        expect(new Vector3().fromBufferAttribute(normals, start + col).distanceTo(firstNormal)).toBe(0);
      }
    }
    for (let row = 1; row < heightSegments; row++) {
      const first = row * columns, last = first + widthSegments;
      expect(new Vector3().fromBufferAttribute(positions, first).distanceTo(new Vector3().fromBufferAttribute(positions, last))).toBe(0);
      expect(new Vector3().fromBufferAttribute(normals, first).distanceTo(new Vector3().fromBufferAttribute(normals, last))).toBe(0);
    }
    sphere.dispose();
  });

  it('keeps the selected ground origin and accounts for curvature in a fallback grid', () => {
    const mesh = terrainMesh({
      size: 3, bounds: { eastMinM: -1_000, eastMaxM: 1_000, northMinM: -1_000, northMaxM: 1_000 },
      heightsM: Array(9).fill(1_500), centerHeightM: 1_500, referenceRadiusM: radius,
    });
    const positions = mesh.geometry.attributes.position;
    expect(positions.getY(4)).toBe(0);
    expect(positions.getY(0)).toBeCloseTo(-2_000_000 / (2 * radius), 6);
    expect(positions.getZ(0)).toBe(-1_000);
    mesh.geometry.dispose(); mesh.material.dispose();
  });

  it('seats the lander on visible sloping terrain while preserving the fixed observer', () => {
    const terrain = new Group();
    const plane = new Mesh(new PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new MeshBasicMaterial({ side: DoubleSide }));
    plane.rotation.z = 0.12; plane.position.y = 1.2; terrain.add(plane);
    const hidden = new Group();
    const obsolete = plane.clone(); obsolete.position.y = 5; hidden.add(obsolete); hidden.visible = false; terrain.add(hidden);
    const { lander, observer } = genericLander(2);
    const observerPosition = observer.position.clone(), observerRotation = observer.quaternion.clone();
    expect(anchorLanderToTerrain(lander, terrain)).toBe(true);
    lander.updateWorldMatrix(true, true);
    const normal = new Vector3(-Math.sin(0.12), Math.cos(0.12), 0);
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2 + Math.PI / 4;
      const underside = lander.localToWorld(new Vector3(Math.cos(angle) * 1.9, 0.035, Math.sin(angle) * 1.9));
      expect(normal.dot(underside.sub(new Vector3(0, 1.2, 0)))).toBeCloseTo(0, 5);
    }
    expect(observer.position.equals(observerPosition)).toBe(true);
    expect(observer.quaternion.equals(observerRotation)).toBe(true);
    plane.geometry.dispose(); plane.material.dispose();
  });
});
