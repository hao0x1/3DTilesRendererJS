import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { excludeTerrainSkirtsFromShadows } from './sceneAssets';

async function terrainFixture() {
  const file = await readFile(new URL('../public/visuals/terrain/shackleton-peak/0-0-0.glb', import.meta.url));
  const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  const mesh = gltf.scene.getObjectByProperty('isMesh', true) as THREE.Mesh;
  if (!mesh) throw new Error('The terrain fixture contains no mesh.');
  return mesh;
}

function before(mesh: THREE.Mesh) {
  mesh.onBeforeShadow(null!, null!, null!, null!, mesh.geometry, null!, null!);
}

function after(mesh: THREE.Mesh) {
  mesh.onAfterShadow(null!, null!, null!, null!, mesh.geometry, null!, null!);
}

function attributeArray(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) {
  return attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data.array : attribute.array;
}

describe('physical terrain shadow geometry', () => {
  it('excludes only skirts from real GLB shadow draws with float positions and quantized normals', async () => {
    const mesh = await terrainFixture();
    const geometry = mesh.geometry, position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    const index = geometry.index!;
    const indices = index.array.slice(), vertices = attributeArray(position).slice();
    const normals = attributeArray(normal).slice();
    const transform = mesh.matrix.clone();
    const surfaceCount = 6 * (mesh.userData.gridSize - 1) ** 2;
    expect(attributeArray(position)).toBeInstanceOf(Float32Array);
    expect(normal.normalized).toBe(true);
    expect(surfaceCount).toBeLessThan(index.count);
    expect(excludeTerrainSkirtsFromShadows(mesh)).toBe(true);
    for (let pass = 0; pass < 4; pass++) {
      before(mesh);
      expect(geometry.drawRange).toEqual({ start: 0, count: surfaceCount });
      after(mesh);
      expect(geometry.drawRange).toEqual({ start: 0, count: Infinity });
    }
    expect(index.array).toEqual(indices);
    expect(attributeArray(position)).toEqual(vertices);
    expect(attributeArray(normal)).toEqual(normals);
    expect(mesh.matrix.equals(transform)).toBe(true);
    geometry.dispose();
  });

  it('preserves existing callbacks, restricted ranges and sequential shared-geometry draws', async () => {
    const mesh = await terrainFixture();
    const surfaceCount = 6 * (mesh.userData.gridSize - 1) ** 2;
    const geometry = mesh.geometry;
    geometry.setDrawRange(surfaceCount - 6, 36);
    const calls: string[] = [];
    mesh.onBeforeShadow = function () {
      expect(this).toBe(mesh);
      expect(geometry.drawRange.count).toBe(36);
      calls.push('before');
    };
    mesh.onAfterShadow = function () {
      expect(this).toBe(mesh);
      expect(geometry.drawRange.count).toBe(36);
      calls.push('after');
    };
    excludeTerrainSkirtsFromShadows(mesh);
    excludeTerrainSkirtsFromShadows(mesh);
    before(mesh);
    expect(geometry.drawRange).toEqual({ start: surfaceCount - 6, count: 6 });
    after(mesh);
    expect(calls).toEqual(['before', 'after']);
    const shared = new THREE.Mesh(geometry, mesh.material);
    shared.userData.gridSize = mesh.userData.gridSize;
    excludeTerrainSkirtsFromShadows(shared);
    geometry.setDrawRange(surfaceCount, 30);
    before(shared);
    expect(geometry.drawRange.count).toBe(0);
    after(shared);
    expect(geometry.drawRange).toEqual({ start: surfaceCount, count: 30 });
    geometry.dispose();
  });
});
