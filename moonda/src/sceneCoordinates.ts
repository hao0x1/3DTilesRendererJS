/** Display-frame transforms; scientific heights are always sampled separately. */
export interface LunarFrameOrigin {
  latitudeDeg: number;
  longitudeDeg: number;
  groundHeightM: number;
  referenceRadiusM: number;
}

export interface LunarGroundPoint {
  latitudeDeg: number;
  longitudeDeg: number;
  groundHeightM: number;
}

export interface ScenePoint { x: number; y: number; z: number }

const DEG = Math.PI / 180;
const dot = (a: ScenePoint, b: ScenePoint) => a.x * b.x + a.y * b.y + a.z * b.z;

function axes(latitudeDeg: number, longitudeDeg: number) {
  const latitude = latitudeDeg * DEG, longitude = longitudeDeg * DEG;
  const s = Math.sin(latitude), c = Math.cos(latitude), sl = Math.sin(longitude), cl = Math.cos(longitude);
  return {
    east: { x: -sl, y: cl, z: 0 },
    north: { x: -s * cl, y: -s * sl, z: c },
    up: { x: c * cl, y: c * sl, z: s },
  };
}

export function lunarPointToScene(origin: LunarFrameOrigin, point: LunarGroundPoint): ScenePoint {
  const basis = axes(origin.latitudeDeg, origin.longitudeDeg);
  const target = axes(point.latitudeDeg, point.longitudeDeg).up;
  const distance = origin.referenceRadiusM + point.groundHeightM;
  const reference = origin.referenceRadiusM + origin.groundHeightM;
  const delta = { x: target.x * distance - basis.up.x * reference, y: target.y * distance - basis.up.y * reference, z: target.z * distance - basis.up.z * reference };
  return { x: dot(delta, basis.east), y: dot(delta, basis.up), z: -dot(delta, basis.north) };
}

export function scenePointToLunar(origin: LunarFrameOrigin, point: ScenePoint): LunarGroundPoint {
  const basis = axes(origin.latitudeDeg, origin.longitudeDeg);
  const radial = origin.referenceRadiusM + origin.groundHeightM + point.y;
  const world = {
    x: basis.east.x * point.x - basis.north.x * point.z + basis.up.x * radial,
    y: basis.east.y * point.x - basis.north.y * point.z + basis.up.y * radial,
    z: basis.east.z * point.x - basis.north.z * point.z + basis.up.z * radial,
  };
  const radius = Math.hypot(world.x, world.y, world.z);
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('The picked terrain position is outside the lunar coordinate frame.');
  const longitude = Math.atan2(world.y, world.x) / DEG;
  return {
    latitudeDeg: Math.asin(Math.max(-1, Math.min(1, world.z / radius))) / DEG,
    longitudeDeg: ((longitude + 180) % 360 + 360) % 360 - 180,
    groundHeightM: radius - origin.referenceRadiusM,
  };
}

/** Great-circle arc offsets used by the prepared terrain's supported square. */
export function lunarArcOffsets(origin: LunarFrameOrigin, point: Pick<LunarGroundPoint, 'latitudeDeg' | 'longitudeDeg'>) {
  const latitude0 = origin.latitudeDeg * DEG, latitude = point.latitudeDeg * DEG;
  const deltaLongitude = (point.longitudeDeg - origin.longitudeDeg) * DEG;
  const y = Math.sin(deltaLongitude) * Math.cos(latitude);
  const x = Math.cos(latitude0) * Math.sin(latitude) - Math.sin(latitude0) * Math.cos(latitude) * Math.cos(deltaLongitude);
  const sinDistance = Math.hypot(x, y);
  const cosDistance = Math.sin(latitude0) * Math.sin(latitude) + Math.cos(latitude0) * Math.cos(latitude) * Math.cos(deltaLongitude);
  const distance = Math.atan2(sinDistance, cosDistance) * origin.referenceRadiusM;
  if (sinDistance < 1e-15) {
    if (cosDistance < 0) throw new RangeError('The lunar antipode has no unique local arc direction.');
    return { eastM: 0, northM: 0 };
  }
  return { eastM: distance * y / sinDistance, northM: distance * x / sinDistance };
}

export function lunarArcDestination(origin: LunarFrameOrigin, eastM: number, northM: number) {
  const latitude0 = origin.latitudeDeg * DEG, longitude0 = origin.longitudeDeg * DEG;
  const distance = Math.hypot(eastM, northM), bearing = Math.atan2(eastM, northM), angle = distance / origin.referenceRadiusM;
  const latitude = Math.asin(Math.max(-1, Math.min(1, Math.sin(latitude0) * Math.cos(angle) + Math.cos(latitude0) * Math.sin(angle) * Math.cos(bearing))));
  const longitude = longitude0 + Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(latitude0), Math.cos(angle) - Math.sin(latitude0) * Math.sin(latitude));
  return { latitudeDeg: latitude / DEG, longitudeDeg: ((longitude / DEG + 180) % 360 + 360) % 360 - 180 };
}

/** Local observer X-east/Y-up/Z-south basis expressed in the region frame. */
export function lunarObserverAxes(origin: LunarFrameOrigin, point: Pick<LunarGroundPoint, 'latitudeDeg' | 'longitudeDeg'>) {
  const base = axes(origin.latitudeDeg, origin.longitudeDeg), observer = axes(point.latitudeDeg, point.longitudeDeg);
  const project = (direction: ScenePoint) => ({ x: dot(direction, base.east), y: dot(direction, base.up), z: -dot(direction, base.north) });
  return { east: project(observer.east), up: project(observer.up), south: project({ x: -observer.north.x, y: -observer.north.y, z: -observer.north.z }) };
}
