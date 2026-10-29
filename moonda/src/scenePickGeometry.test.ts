import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Mesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ObservatoryData } from './types';
import { lunarArcDestination, lunarArcOffsets, lunarPointToScene, scenePointToLunar } from './sceneCoordinates';

describe('prepared terrain selection grid', () => {
  it('maps real finest-mesh vertices to the canonical 10 metre arc grid in every region', async () => {
    const data = JSON.parse(await readFile(new URL('../public/data/observatory.json', import.meta.url), 'utf8')) as ObservatoryData;
    for (const site of data.sites) {
      const file = await readFile(new URL(`../public/visuals/terrain/${site.id}/6-32-32.glb`, import.meta.url));
      const gltf = await new GLTFLoader().parseAsync(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), '');
      const mesh = gltf.scene.getObjectByProperty('isMesh', true) as Mesh;
      gltf.scene.updateMatrixWorld(true);
      const bounds = mesh.userData.bounds, size = mesh.userData.gridSize;
      const origin = { latitudeDeg: site.latitudeDeg, longitudeDeg: site.longitudeDeg, groundHeightM: site.terrain.centerHeightM!, referenceRadiusM: site.terrain.referenceRadiusM };
      for (const [row, column] of [[0, 0], [13, 57], [128, 128]]) {
        const point = new Vector3().fromBufferAttribute(mesh.geometry.attributes.position, row * size + column).applyMatrix4(mesh.matrixWorld);
        const geographic = scenePointToLunar(origin, point), actual = lunarArcOffsets(origin, geographic);
        const eastM = bounds.eastMinM + column * 10, northM = bounds.northMaxM - row * 10;
        expect(Math.abs(actual.eastM - eastM)).toBeLessThan(0.001);
        expect(Math.abs(actual.northM - northM)).toBeLessThan(0.001);
        const canonical = lunarArcDestination(origin, eastM, northM);
        const projected = lunarPointToScene(origin, { ...canonical, groundHeightM: geographic.groundHeightM });
        expect(new Vector3(projected.x, projected.y, projected.z).distanceTo(point)).toBeLessThan(0.001);
      }
      mesh.geometry.dispose();
    }
  });
});
