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

export interface SceneMarkerAnchor { id: string; x: number; y: number }
export interface SceneOverlayRect { x: number; y: number; width: number; height: number }
export interface SceneMarkerBadge extends SceneMarkerAnchor { anchorX: number; anchorY: number; size: number }

export function sceneCaptionOwner(intent: { focused?: string | null; hovered?: string | null; candidate?: string | null; active?: string | null }, visibleIds: ReadonlySet<string>) {
  return [intent.focused, intent.hovered, intent.candidate, intent.active].find((id): id is string => Boolean(id && visibleIds.has(id))) ?? null;
}

const overlaps = (a: SceneOverlayRect, b: SceneOverlayRect, gap = 0) => a.x < b.x + b.width + gap - 0.001 && a.x + a.width + gap > b.x + 0.001 && a.y < b.y + b.height + gap - 0.001 && a.y + a.height + gap > b.y + 0.001;
const badgeRect = (badge: SceneMarkerBadge): SceneOverlayRect => ({ x: badge.x - badge.size / 2, y: badge.y - badge.size / 2, width: badge.size, height: badge.size });

/** A/B/candidate badges stay near their real projected anchors; only labels move. */
export function layoutSceneMarkerBadges(anchors: readonly SceneMarkerAnchor[], width: number, height: number, size: number, padding = 12, gap = 10): SceneMarkerBadge[] {
  const clamp = (value: number, extent: number) => Math.max(Math.min(extent / 2, padding + size / 2), Math.min(Math.max(extent / 2, extent - padding - size / 2), value));
  const inputs = anchors.filter(anchor => Number.isFinite(anchor.x) && Number.isFinite(anchor.y));
  const initial = inputs.map(anchor => ({ id: anchor.id, anchorX: anchor.x, anchorY: anchor.y, x: clamp(anchor.x, width), y: clamp(anchor.y, height), size }));
  if (!initial.some((a, i) => initial.some((b, j) => j > i && overlaps(badgeRect(a), badgeRect(b), gap)))) return initial;
  const step = size + gap, offsets = [0, -step / 2, step / 2, -step, step];
  const choices = initial.map(anchor => {
    const unique = new Map<string, { badge: SceneMarkerBadge; cost: number }>();
    for (const dx of offsets) for (const dy of offsets) {
      const badge = { ...anchor, x: clamp(anchor.x + dx, width), y: clamp(anchor.y + dy, height) };
      const displacementX = badge.x - anchor.anchorX, displacementY = badge.y - anchor.anchorY;
      const horizontalPreference = anchor.id === 'A' ? Math.max(0, displacementX) : anchor.id === 'B' ? Math.max(0, -displacementX) : 0;
      const preference = anchor.id === 'candidate' ? Math.max(0, displacementY) : Math.abs(displacementY) * 0.01 + horizontalPreference * 0.01;
      const cost = displacementX ** 2 + displacementY ** 2 + preference;
      unique.set(`${badge.x.toFixed(3)},${badge.y.toFixed(3)}`, { badge, cost });
    }
    return [...unique.values()].sort((a, b) => a.cost - b.cost);
  });
  let best: SceneMarkerBadge[] | null = null, bestCost = Infinity;
  const search = (index: number, placed: SceneMarkerBadge[], cost: number) => {
    if (cost >= bestCost) return;
    if (index === choices.length) { best = [...placed]; bestCost = cost; return; }
    for (const choice of choices[index]) {
      if (cost + choice.cost >= bestCost) break;
      if (placed.some(other => overlaps(badgeRect(choice.badge), badgeRect(other), gap))) continue;
      placed.push(choice.badge); search(index + 1, placed, cost + choice.cost); placed.pop();
    }
  };
  search(0, [], 0);
  return best ?? initial;
}

export type SceneCaptionSide = 'below' | 'above' | 'right' | 'left';
export interface SceneCaptionPlacement extends SceneOverlayRect {
  side: SceneCaptionSide;
  clusterKey: string;
  clusterIds: string[];
  cluster: SceneOverlayRect;
}
export interface SceneCaptionLayoutOptions {
  previous?: SceneCaptionPlacement | null;
  clusterGap?: number;
}

/** One stable caption slot belongs to a connected badge cluster, not its owner. */
export function layoutSceneMarkerCaption(ownerId: string, badges: readonly SceneMarkerBadge[], width: number, height: number, captionSize: { width: number; height: number }, hud: readonly SceneOverlayRect[] = [], padding = 12, gap = 10, options: SceneCaptionLayoutOptions = {}): SceneCaptionPlacement | null {
  const owner = badges.find(badge => badge.id === ownerId);
  if (!owner) return null;
  const w = Math.min(captionSize.width, width - padding * 2), h = Math.min(captionSize.height, height - padding * 2);
  if (w <= 0 || h <= 0) return null;
  const previous = options.previous, clusterGap = Math.max(0, options.clusterGap ?? 24);
  const connected = (a: SceneMarkerBadge, b: SceneMarkerBadge) => {
    const ra = badgeRect(a), rb = badgeRect(b);
    const dx = Math.max(0, ra.x - rb.x - rb.width, rb.x - ra.x - ra.width);
    const dy = Math.max(0, ra.y - rb.y - rb.height, rb.y - ra.y - ra.height);
    // Keep an existing cluster together through small camera/subpixel changes.
    const retained = previous?.clusterIds.includes(a.id) && previous.clusterIds.includes(b.id);
    return Math.hypot(dx, dy) <= clusterGap + (retained ? 8 : 0) + 0.001;
  };
  const members = [owner], memberIds = new Set([owner.id]);
  for (let index = 0; index < members.length; index++) {
    for (const badge of badges) if (!memberIds.has(badge.id) && connected(members[index], badge)) { members.push(badge); memberIds.add(badge.id); }
  }
  const rects = members.map(badgeRect);
  const left = Math.min(...rects.map(rect => rect.x)), top = Math.min(...rects.map(rect => rect.y));
  const cluster = { x: left, y: top, width: Math.max(...rects.map(rect => rect.x + rect.width)) - left, height: Math.max(...rects.map(rect => rect.y + rect.height)) - top };
  const clusterIds = [...memberIds].sort(), clusterKey = JSON.stringify(clusterIds);
  const sameCluster = previous?.clusterKey === clusterKey;
  const priority: SceneCaptionSide[] = ['below', 'above', 'right', 'left'];
  const sides = sameCluster ? [previous.side, ...priority.filter(side => side !== previous.side)] : priority;
  const blocked = [...badges.map(badge => ({ rect: badgeRect(badge), clearance: gap })), ...hud.map(rect => ({ rect, clearance: 6 }))];
  const fits = (rect: SceneOverlayRect) => rect.x >= padding - 0.001 && rect.y >= padding - 0.001 && rect.x + w <= width - padding + 0.001 && rect.y + h <= height - padding + 0.001 && !blocked.some(item => overlaps(rect, item.rect, item.clearance));
  for (const side of sides) {
    const horizontal = side === 'below' || side === 'above';
    const centre = horizontal ? cluster.x + cluster.width / 2 : cluster.y + cluster.height / 2;
    const crossSize = horizontal ? w : h, extent = horizontal ? width : height;
    const makeRect = (crossCentre: number): SceneOverlayRect => {
      const cross = Math.max(padding, Math.min(extent - crossSize - padding, crossCentre - crossSize / 2));
      if (side === 'below') return { x: cross, y: cluster.y + cluster.height + gap, width: w, height: h };
      if (side === 'above') return { x: cross, y: cluster.y - gap - h, width: w, height: h };
      if (side === 'right') return { x: cluster.x + cluster.width + gap, y: cross, width: w, height: h };
      return { x: cluster.x - gap - w, y: cross, width: w, height: h };
    };
    const candidates: number[] = [];
    if (sameCluster && previous.side === side) {
      const oldCentre = horizontal ? previous.cluster.x + previous.cluster.width / 2 : previous.cluster.y + previous.cluster.height / 2;
      const oldCaptionCentre = horizontal ? previous.x + previous.width / 2 : previous.y + previous.height / 2;
      candidates.push(centre + oldCaptionCentre - oldCentre);
    }
    candidates.push(centre);
    const alternatives = blocked.flatMap(({ rect, clearance }) => horizontal
      ? [rect.x - clearance - w / 2, rect.x + rect.width + clearance + w / 2]
      : [rect.y - clearance - h / 2, rect.y + rect.height + clearance + h / 2]);
    alternatives.sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
    candidates.push(...alternatives);
    for (const crossCentre of candidates) {
      const rect = makeRect(crossCentre);
      if (fits(rect)) return { ...rect, side, clusterKey, clusterIds, cluster };
    }
  }
  return null;
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
