import * as THREE from 'three';
import { lunarObserverAxes, lunarPointToScene } from './sceneCoordinates';
import type { LunarFrameOrigin, LunarGroundPoint } from './sceneCoordinates';

export interface SceneObserverMarker extends LunarGroundPoint {
  id: 'A' | 'B';
  regionId: string;
  antennaHeightM: number;
  panelHeightM: number;
  panelAreaM2?: number;
  panelNormalEnu?: { east: number; north: number; up: number };
}

export function observerPose(origin: LunarFrameOrigin, observer: LunarGroundPoint) {
  const point = lunarPointToScene(origin, observer);
  const axes = lunarObserverAxes(origin, observer);
  const vector = (p: typeof point) => new THREE.Vector3(p.x, p.y, p.z);
  const orientation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(vector(axes.east), vector(axes.up), vector(axes.south)));
  return { point: vector(point), orientation, up: vector(axes.up) };
}

/** Real observer heights; this drawing does not model spacecraft occlusion. */
export function scenarioObserverMarker(origin: LunarFrameOrigin, observer: SceneObserverMarker, detailed = true) {
  const group = new THREE.Group();
  const pose = observerPose(origin, observer);
  group.position.copy(pose.point); group.quaternion.copy(pose.orientation);
  const color = observer.id === 'A' ? '#acdce1' : '#e6bd83';
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.2, emissive: color, emissiveIntensity: 0.15 });
  const panelMaterial = new THREE.MeshStandardMaterial({ color: '#263e59', roughness: 0.45, metalness: 0.25 });
  const antennaHeight = Math.max(0, observer.antennaHeightM), panelHeight = Math.max(0, observer.panelHeightM);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.12, 8, 64), material);
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.05; group.add(ring);
  if (!detailed) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 4, 8), material);
    pole.position.y = 2; group.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.7), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    flag.position.set(0.6, 3.65, 0); group.add(flag);
    group.userData = { observerId: observer.id, illustrative: true, flagOnly: true };
    return group;
  }
  if (antennaHeight > 0) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, antennaHeight, 8), material);
    mast.position.y = antennaHeight / 2; group.add(mast);
  }
  const antenna = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 8), material);
  antenna.name = 'antenna-observer';
  antenna.position.y = antennaHeight; group.add(antenna);
  if (panelHeight > 0) {
    const support = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, panelHeight, 8), material);
    support.position.y = panelHeight / 2; group.add(support);
  }
  const area = observer.panelAreaM2 != null && Number.isFinite(observer.panelAreaM2) && observer.panelAreaM2 > 0 ? observer.panelAreaM2 : 3.36;
  const width = Math.sqrt(area * (2.4 / 1.4));
  const panel = new THREE.Mesh(new THREE.BoxGeometry(width, 0.05, area / width), panelMaterial);
  panel.name = 'solar-panel';
  panel.receiveShadow = true;
  panel.position.y = panelHeight;
  if (observer.panelNormalEnu) {
    const { east, north, up } = observer.panelNormalEnu;
    const normal = new THREE.Vector3(east, up, -north);
    if (normal.lengthSq() > 0 && normal.toArray().every(Number.isFinite)) panel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal.normalize());
  }
  group.add(panel);
  group.userData = { observerId: observer.id, illustrative: true, antennaHeightM: antennaHeight, panelHeightM: panelHeight };
  return group;
}
