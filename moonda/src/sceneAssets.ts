import * as THREE from 'three';
import type { Terrain } from './types';

export interface ImageAsset {
  url: string;
  width?: number;
  height?: number;
}

export interface VisualAssetManifest {
  moon?: {
    referenceRadiusMeters?: number;
    color?: { fallback?: ImageAsset; high?: ImageAsset; ultra?: ImageAsset };
    height?: {
      url: string; width: number; height: number; scale: number; bias: number;
      format: string; referenceRadiusMeters: number; minMeters?: number; maxMeters?: number;
    };
    normal?: ImageAsset & { scaleFactor?: number };
  };
  earth?: { color?: { fallback?: ImageAsset; high?: ImageAsset; ultra?: ImageAsset } };
}

export interface TerrainVisualEntry {
  tilesetUrl: string;
  bounds: { eastMinM: number; eastMaxM: number; northMinM: number; northMaxM: number };
  origin?: { latitudeDeg: number; longitudeDeg: number; centerHeightM: number };
  levels?: { level?: number; spacingM: number; extentM: number }[];
  source?: { title: string; url: string; detail?: string };
  limitations?: string[];
  fallback?: Terrain;
}

export interface TerrainVisualManifest {
  version?: string;
  sites: Record<string, TerrainVisualEntry>;
}

/** NASA CGI Moon Kit height values are unsigned half-metres offset by 10 km. */
export function applyLunarRelief(
  geometry: THREE.SphereGeometry,
  bytes: ArrayBuffer,
  metadata: NonNullable<NonNullable<VisualAssetManifest['moon']>['height']>,
  radius: number,
) {
  const { width, height, scale, bias } = metadata;
  if (bytes.byteLength !== width * height * 2 || metadata.format !== 'uint16-le') {
    throw new Error('The lunar height file does not match its declared dimensions or encoding.');
  }
  if (Math.abs(metadata.referenceRadiusMeters - radius) > 0.001) {
    throw new Error('The lunar height map and rendering sphere use different reference radii.');
  }
  const values = new DataView(bytes);
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  const point = new THREE.Vector3();
  let min = Infinity, max = -Infinity;
  const valueAt = (x: number, y: number) => {
    const row = Math.max(0, Math.min(height - 1, y));
    const col = ((x % width) + width) % width;
    return values.getUint16((row * width + col) * 2, true) * scale + bias;
  };
  // Equirectangular pixels describe a ring around each pole, not multiple
  // physical poles. SphereGeometry duplicates a pole for every UV segment;
  // those duplicates must share one height to close the mesh. The mean of
  // the nearest source ring is the longitude-independent pole estimate.
  const meanRow = (row: number) => {
    let sum = 0;
    for (let col = 0; col < width; col++) sum += valueAt(col, row);
    return sum / width;
  };
  const northPoleHeight = meanRow(0), southPoleHeight = meanRow(height - 1);
  for (let i = 0; i < positions.count; i++) {
    // SphereGeometry's u=0.5 is longitude zero; v=1 is the north pole.
    const x = uv.getX(i) * width - 0.5;
    const y = (1 - uv.getY(i)) * height - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = x - x0, ty = y - y0;
    let h = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(valueAt(x0, y0), valueAt(x0 + 1, y0), tx),
      THREE.MathUtils.lerp(valueAt(x0, y0 + 1), valueAt(x0 + 1, y0 + 1), tx), ty,
    );
    const northPole = uv.getY(i) >= 1 - 1e-8, southPole = uv.getY(i) <= 1e-8;
    if (northPole) h = northPoleHeight;
    if (southPole) h = southPoleHeight;
    if (!Number.isFinite(h) || Math.abs(h) > 30_000) throw new Error('The lunar height map contains an invalid elevation.');
    min = Math.min(min, h); max = Math.max(max, h);
    if (northPole || southPole) positions.setXYZ(i, 0, (northPole ? 1 : -1) * (radius + h), 0);
    else {
      point.fromBufferAttribute(positions, i).normalize().multiplyScalar(radius + h);
      positions.setXYZ(i, point.x, point.y, point.z);
    }
  }
  const columns = geometry.parameters.widthSegments + 1;
  const lastRow = geometry.parameters.heightSegments;
  // Exactly weld the duplicate longitude seam positions before accumulating
  // normals. The two UVs remain separate for texture wrapping.
  for (let row = 1; row < lastRow; row++) {
    const first = row * columns, last = first + columns - 1;
    positions.setXYZ(last, positions.getX(first), positions.getY(first), positions.getZ(first));
  }
  positions.needsUpdate = true;
  const normal = geometry.attributes.normal as THREE.BufferAttribute;
  const normals = normal.array as Float32Array;
  normals.fill(0);
  const indices = geometry.index!.array;
  const points = positions.array as Float32Array;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const abx = points[a] - points[b], aby = points[a + 1] - points[b + 1], abz = points[a + 2] - points[b + 2];
    const cbx = points[c] - points[b], cby = points[c + 1] - points[b + 1], cbz = points[c + 2] - points[b + 2];
    // Cross products retain face area, so a small triangle cannot dominate
    // the shared normal at the pole or along the longitude seam.
    const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let row = 1; row < lastRow; row++) {
    const first = row * columns * 3, last = (row * columns + columns - 1) * 3;
    for (let axis = 0; axis < 3; axis++) {
      const sum = normals[first + axis] + normals[last + axis];
      normals[first + axis] = normals[last + axis] = sum;
    }
  }
  for (const row of [0, lastRow]) {
    const start = row * columns;
    let nx = 0, ny = 0, nz = 0;
    for (let col = 0; col < columns; col++) {
      const index = (start + col) * 3;
      nx += normals[index]; ny += normals[index + 1]; nz += normals[index + 2];
    }
    for (let col = 0; col < columns; col++) normal.setXYZ(start + col, nx, ny, nz);
  }
  geometry.normalizeNormals();
  normal.needsUpdate = true;
  geometry.computeBoundingSphere();
  return { minMeters: min, maxMeters: max };
}

export function terrainMesh(terrain: Terrain) {
  const n = terrain.size;
  const positions = new Float32Array(n * n * 3);
  const indices: number[] = [];
  const centerHeight = terrain.centerHeightM ?? terrain.heightsM[Math.floor(n / 2) * n + Math.floor(n / 2)] ?? 0;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = row * n + col;
      const east = terrain.bounds.eastMinM + col / (n - 1) * (terrain.bounds.eastMaxM - terrain.bounds.eastMinM);
      const north = terrain.bounds.northMaxM - row / (n - 1) * (terrain.bounds.northMaxM - terrain.bounds.northMinM);
      positions[3 * i] = east;
      positions[3 * i + 1] = terrain.heightsM[i] - centerHeight - (east * east + north * north) / (2 * terrain.referenceRadiusM);
      positions[3 * i + 2] = -north;
      if (row < n - 1 && col < n - 1) indices.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: '#a3a29e', roughness: 1, metalness: 0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}

const terrainShadowHooks = new WeakSet<THREE.Mesh>();

/** Raster-only bias for measured terrain; spacecraft keep their own casters. */
export function createTerrainShadowMaterial(filterRadius: number) {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });
  material.onBeforeCompile = shader => {
    shader.uniforms.moondaShadowFilterRadius = { value: filterRadius };
    shader.fragmentShader = `uniform float moondaShadowFilterRadius;\n${shader.fragmentShader}`.replace(
      '#include <logdepthbuf_fragment>',
      `#include <logdepthbuf_fragment>
      // Directional Sun shadows use orthographic depth. At grazing incidence,
      // neighbouring PCF samples lie far apart along a terrain face in light
      // depth. Bias this terrain caster by the filter's raster footprint,
      // instead of moving every receiver or the lander by metres.
      vec2 moondaDepthGradient = vec2(dFdx(gl_FragCoord.z), dFdy(gl_FragCoord.z));
      float moondaCasterBias = moondaShadowFilterRadius * length(moondaDepthGradient)
        + abs(moondaDepthGradient.x) + abs(moondaDepthGradient.y)
        + 0.00000011920929;
      gl_FragDepth = min(1.0, gl_FragCoord.z + moondaCasterBias);`,
    );
  };
  material.customProgramCacheKey = () => 'moonda-terrain-shadow-filter-footprint-v1';
  return material;
}

/** Keep display-only LOD crack skirts out of the physical Sun's shadow map. */
export function excludeTerrainSkirtsFromShadows(mesh: THREE.Mesh) {
  if (terrainShadowHooks.has(mesh)) return true;
  const n = mesh.userData.gridSize;
  const surfaceIndexCount = 6 * (n - 1) ** 2;
  if (!Number.isInteger(n) || n < 2 || !mesh.geometry.index || surfaceIndexCount > mesh.geometry.index.count) return false;
  const previousBefore = mesh.onBeforeShadow, previousAfter = mesh.onAfterShadow;
  const ranges: { geometry: THREE.BufferGeometry; start: number; count: number }[] = [];
  mesh.onBeforeShadow = (...args) => {
    previousBefore.apply(mesh, args);
    const geometry = args[4];
    const { start, count } = geometry.drawRange;
    ranges.push({ geometry, start, count });
    // The generator writes measured surface triangles first, then skirts.
    // Restricting an indexed draw range leaves every attribute (including
    // interleaved/quantized GLB buffers) and node decode transform untouched.
    geometry.setDrawRange(start, Math.max(0, Math.min(start + count, surfaceIndexCount) - start));
  };
  mesh.onAfterShadow = (...args) => {
    const prior = ranges.pop();
    if (prior) prior.geometry.setDrawRange(prior.start, prior.count);
    previousAfter.apply(mesh, args);
  };
  terrainShadowHooks.add(mesh);
  return true;
}

/** Seat the illustrative lander on the active visible surface, never the observer. */
export function anchorLanderToTerrain(lander: THREE.Group, terrain: THREE.Object3D) {
  terrain.updateWorldMatrix(true, true);
  const surfaces: THREE.Mesh[] = [];
  terrain.traverseVisible(child => { if (child instanceof THREE.Mesh) surfaces.push(child); });
  const ray = new THREE.Raycaster(new THREE.Vector3(lander.position.x, 20_000, lander.position.z), new THREE.Vector3(0, -1, 0), 0, 40_000);
  const hit = ray.intersectObjects(surfaces, false).find(intersection => {
    const n = intersection.object.userData.gridSize;
    return !Number.isInteger(n) || intersection.faceIndex == null || intersection.faceIndex * 3 < 6 * (n - 1) ** 2;
  });
  if (!hit?.face) return false;
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  if (normal.y < 0) normal.negate();
  if (normal.y < 0.0001) return false;
  // The pad undersides are 0.035 m above this model's local base. Aligning
  // its up direction to the support face seats them on that display plane.
  lander.position.y = hit.point.y - 0.035 / normal.y;
  lander.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  return true;
}

/** Original generic scale reference: no spacecraft or mission identity is asserted. */
export function genericLander(observerHeightM: number) {
  const group = new THREE.Group();
  const foil = new THREE.MeshStandardMaterial({ color: '#c8a454', roughness: 0.6, metalness: 0.5 });
  const white = new THREE.MeshStandardMaterial({ color: '#e1e0d7', roughness: 0.75, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: '#172a3b', roughness: 0.38, metalness: 0.35 });
  const grey = new THREE.MeshStandardMaterial({ color: '#686d73', roughness: 0.5, metalness: 0.6 });
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
  };
  add(new THREE.CylinderGeometry(1.1, 1.25, 1.1, 8), foil, 0, 1.35, 0);
  add(new THREE.CylinderGeometry(0.95, 1.1, 0.15, 8), white, 0, 1.98, 0);
  const strut = (from: THREE.Vector3, to: THREE.Vector3, radius = 0.045) => {
    const direction = to.clone().sub(from);
    const mesh = add(new THREE.CylinderGeometry(radius, radius, direction.length(), 8), grey, 0, 0, 0);
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  };
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    const foot = new THREE.Vector3(Math.cos(a) * 1.9, 0.08, Math.sin(a) * 1.9);
    strut(new THREE.Vector3(Math.cos(a) * 0.75, 1.25, Math.sin(a) * 0.75), foot);
    add(new THREE.CylinderGeometry(0.26, 0.3, 0.09, 16), white, foot.x, foot.y, foot.z);
  }
  strut(new THREE.Vector3(0.3, 2.0, 0), new THREE.Vector3(0.3, 2.85, 0), 0.025);
  const antenna = add(new THREE.SphereGeometry(0.34, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), white, 0.3, 2.85, 0);
  antenna.rotation.z = -0.6;
  const panel = add(new THREE.BoxGeometry(2.7, 0.055, 1.4), dark, -2.2, 1.85, 0);
  panel.rotation.z = 0.16;
  strut(new THREE.Vector3(-0.9, 1.5, 0), new THREE.Vector3(-2.2, 1.85, 0));
  // Place the illustration beside the actual observer, leaving that origin untouched.
  group.position.set(7, 0, 3);

  const observer = new THREE.Group();
  const markerMaterial = new THREE.MeshStandardMaterial({ color: '#a8d4df', roughness: 0.4, metalness: 0.2, emissive: '#254451', emissiveIntensity: 0.25 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, observerHeightM, 8), grey.clone());
  mast.position.y = observerHeightM / 2;
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 8), markerMaterial);
  marker.position.y = observerHeightM;
  observer.add(mast, marker);
  return { lander: group, observer };
}

export function disposeObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points)) return;
    geometries.add(child.geometry);
    (Array.isArray(child.material) ? child.material : [child.material]).forEach(material => materials.add(material));
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}
