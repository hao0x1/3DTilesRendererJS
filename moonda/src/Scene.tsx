import { useEffect, useId, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Ellipsoid, GlobeControls, TilesRenderer } from '3d-tiles-renderer/three';
import { ArrowCounterClockwise, ArrowDown, ArrowsOut, Crosshair, GlobeHemisphereWest, Sun } from '@phosphor-icons/react';
import { sampleAt } from './science';
import type { Horizon, Site, SkySample, Terrain } from './types';
import { anchorLanderToTerrain, applyLunarRelief, createTerrainShadowMaterial, disposeObject, excludeTerrainSkirtsFromShadows, genericLander, raycastVisibleTerrain, terrainMesh } from './sceneAssets';
import type { ImageAsset, TerrainVisualEntry, TerrainVisualManifest, VisualAssetManifest } from './sceneAssets';
import { lunarArcDestination, lunarArcOffsets, lunarPointToScene, scenePointToLunar } from './sceneCoordinates';
import type { LunarFrameOrigin, LunarGroundPoint, ScenePoint } from './sceneCoordinates';
import { layoutSceneMarkerBadges, layoutSceneMarkerCaption, observerPose, scenarioObserverMarker, sceneCaptionOwner } from './sceneScenarioVisuals';
import type { SceneCaptionPlacement, SceneMarkerAnchor, SceneMarkerBadge, SceneOverlayRect } from './sceneScenarioVisuals';
import type { SceneObserverMarker } from './sceneScenarioVisuals';

export type { SceneObserverMarker } from './sceneScenarioVisuals';

export interface SceneObserverView extends LunarGroundPoint {
  heightM: number;
  horizon: Horizon;
  /** Both bodies must be computed at this component's own position/height. */
  sample: SkySample;
  sunAngularRadiusDeg?: number;
  earthAngularRadiusDeg?: number;
  /** Local display approximation of Earth-only solar occultation. */
  earthBlockedSolarFraction?: number;
}

export interface SceneTerrainPick {
  regionId: string;
  latitudeDeg: number;
  longitudeDeg: number;
  arcEastM: number;
  arcNorthM: number;
  displayPoint: ScenePoint;
  /** Preview only: lock jobs must re-sample the scientific DEM. */
  displayGroundHeightM: number;
  supported: boolean;
  status?: 'pending' | 'valid' | 'invalid';
  message?: string;
}

export type SceneMode = 'globe' | 'terrain' | 'surface';
export interface SceneProps {
  sites: Site[];
  selectedSite: Site;
  timeIndex: number;
  terrainEnabled: boolean;
  mode: SceneMode;
  onSelectSite: (id: string) => void;
  onModeChange?: (mode: SceneMode) => void;
  analysisObservers?: { panel: SceneObserverView; antenna: SceneObserverView };
  analysisStatus?: 'loading' | 'ready' | 'error';
  observerView?: 'panel' | 'antenna';
  onObserverViewChange?: (view: 'panel' | 'antenna') => void;
  observers?: SceneObserverMarker[];
  activeObserverId?: 'A' | 'B';
  onActivateObserver?: (id: 'A' | 'B') => void;
  pickingEnabled?: boolean;
  pickingDomain?: Terrain['bounds'];
  candidate?: SceneTerrainPick | null;
  onTerrainPick?: (pick: SceneTerrainPick) => void;
  onLockCandidate?: () => void;
  onCancelCandidate?: () => void;
  integratedControls?: boolean;
  guidanceText?: string;
}

const MOON_RADIUS = 1_737_400;
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 0, 1);
const moonEllipsoid = new Ellipsoid(MOON_RADIUS, MOON_RADIUS, MOON_RADIUS);
const asset = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^(?:\.\/|\/)+/, '')}`;
const formatInteger = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

function location(site: Site, height = 0) {
  return moonEllipsoid.getCartographicToPosition(site.latitudeDeg * DEG, site.longitudeDeg * DEG, height, new THREE.Vector3()) as THREE.Vector3;
}

function localDirection(azimuth: number, elevation: number) {
  const az = azimuth * DEG, el = elevation * DEG;
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

function worldDirection(site: Pick<Site, 'latitudeDeg' | 'longitudeDeg'>, azimuth: number, elevation: number) {
  const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
  moonEllipsoid.getEastNorthUpAxes(site.latitudeDeg * DEG, site.longitudeDeg * DEG, east, north, up);
  const direction = localDirection(azimuth, elevation);
  return east.multiplyScalar(direction.x).add(north.multiplyScalar(-direction.z)).add(up.multiplyScalar(direction.y));
}

function horizonGeometry(site: Pick<Site, 'horizon' | 'observerHeightM'>, enabled: boolean) {
  const profile = site.horizon.elevationDeg;
  const positions: number[] = [];
  const count = profile.length, radius = 45_000;
  for (let i = 0; i < count; i++) {
    const a = i * 2 * Math.PI / count, b = (i + 1) * 2 * Math.PI / count;
    const ya = Math.tan((enabled ? profile[i] : 0) * DEG) * radius + site.observerHeightM;
    const yb = Math.tan((enabled ? profile[(i + 1) % count] : 0) * DEG) * radius + site.observerHeightM;
    const x1 = Math.sin(a) * radius, z1 = -Math.cos(a) * radius;
    const x2 = Math.sin(b) * radius, z2 = -Math.cos(b) * radius;
    positions.push(x1, -30_000, z1, x2, -30_000, z2, x1, ya, z1, x1, ya, z1, x2, -30_000, z2, x2, yb, z2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export default function Scene(props: SceneProps) {
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ update: (next: SceneProps) => void; focus: (body: 'sun' | 'earth' | 'reset' | 'marker') => void; setInspectionLighting: (enabled: boolean) => void; refreshLabels: () => void } | null>(null);
  const currentProps = useRef(props);
  const labels = useRef<Record<string, HTMLButtonElement | null>>({});
  const scenarioLabels = useRef<Record<string, HTMLButtonElement | null>>({});
  const candidateLabel = useRef<HTMLDivElement | null>(null);
  const markerCaption = useRef<HTMLDivElement | null>(null);
  const captionIntent = useRef<{ focused: string | null; hovered: string | null }>({ focused: null, hovered: null });
  const markerCaptionId = useId();
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const [loadingTerrain, setLoadingTerrain] = useState(false);
  const [visualQuality, setVisualQuality] = useState('Loading lunar detail');
  const [terrainQuality, setTerrainQuality] = useState('Local NASA terrain');
  const [inspectionLight, setInspectionLight] = useState(true);
  const inspectionRef = useRef(true);
  const [viewComponent, setViewComponent] = useState<'panel' | 'antenna'>(props.observerView ?? 'panel');
  const componentRef = useRef<'panel' | 'antenna'>(props.observerView ?? 'panel');
  const resolvedView = props.observerView ?? viewComponent;
  componentRef.current = resolvedView;
  currentProps.current = props;

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true, alpha: true, powerPreference: 'high-performance',
        // Real metre-scale detail and an 80 km terrain context must share a
        // depth buffer, including the separately lit celestial pass below.
        // Linear perspective depth cannot retain centimetre-scale tile
        // precision across that span with the close-up camera's near plane.
        logarithmicDepthBuffer: true,
      });
    } catch {
      setError('This browser could not start the 3D view. You can still use the analysis and comparison below.');
      return;
    }
    let disposed = false, frame = 0, framesRendered = 0;
    let lastTime = performance.now(), state = currentProps.current;
    let siteId = '', previousMode = state.mode, previousAspect = 0;
    let yaw = 140 * DEG, pitch = 5 * DEG;
    let dragging: { x: number; y: number } | null = null;
    let globeTarget: THREE.Vector3 | null = null;
    let orbitTarget: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
    let visuals: TerrainVisualManifest | null = null;
    let tiles: any = null;
    let activeTileCamera: THREE.PerspectiveCamera | null = null;
    let fallback: THREE.Mesh | null = null;
    let lunarColorWidth = 0, earthColorWidth = 0;
    let hasRelief = false;
    let loadedTerrainEntry: TerrainVisualEntry | undefined;
    let inspectionLighting = inspectionRef.current;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const abort = new AbortController();
    const textureLoader = new THREE.TextureLoader();
    const textures = new Set<THREE.Texture>();
    const maxTextureSize = renderer.capabilities.maxTextureSize;
    const anisotropy = renderer.capabilities.getMaxAnisotropy();

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.tabIndex = 0;
    renderer.domElement.style.width = renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    host.appendChild(renderer.domElement);

    const globeScene = new THREE.Scene(), globeGroup = new THREE.Group();
    globeScene.add(globeGroup);
    const globeCamera = new THREE.PerspectiveCamera(36, 1, 1_000, 30_000_000);
    globeCamera.up.copy(UP);
    const globeControls = new GlobeControls(globeGroup, globeCamera, renderer.domElement);
    globeControls.setEllipsoid(moonEllipsoid, globeGroup);
    globeControls.enableDamping = true;
    globeControls.minDistance = 60_000;
    globeControls.maxDistance = MOON_RADIUS * 8;
    globeControls.adjustHeight = false;
    // The controls' reference ellipsoid is smooth; measured relief extends
    // beyond it, so reserve a little far-plane room at the visible limb.
    globeControls.farMargin = 0.04;
    const globeLight = new THREE.DirectionalLight('#fff9ed', 3.15);
    globeScene.add(globeLight, new THREE.AmbientLight('#d6e0e8', 0.075));
    const moonMaterial = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, color: '#ffffff' });
    const moon = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS, 1024, 512), moonMaterial);
    // Native renderer math is Z-up; the texture sphere starts Y-up.
    moon.rotation.x = Math.PI / 2;
    globeGroup.add(moon);

    const skyScene = new THREE.Scene(), skyCamera = new THREE.PerspectiveCamera(36, 1, 0.1, 5_000);
    const starPositions = new Float32Array(1_250 * 3);
    let seed = 619;
    const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    for (let i = 0; i < 1_250; i++) {
      const z = 2 * random() - 1, theta = random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      starPositions[3 * i] = r * Math.cos(theta) * 3_000;
      starPositions[3 * i + 1] = r * Math.sin(theta) * 3_000;
      starPositions[3 * i + 2] = z * 3_000;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    skyScene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: '#b6c5d0', size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.48, depthWrite: false })));

    const localScene = new THREE.Scene(), terrainGroup = new THREE.Group();
    localScene.add(terrainGroup);
    const surfaceCamera = new THREE.PerspectiveCamera(65, 1, 0.1, 250_000);
    const terrainCamera = new THREE.PerspectiveCamera(48, 1, 0.2, 300_000);
    const orbitControls = new OrbitControls(terrainCamera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.1;
    orbitControls.screenSpacePanning = false;
    orbitControls.minDistance = 6;
    orbitControls.maxDistance = 110_000;
    orbitControls.maxPolarAngle = Math.PI * 0.48;
    orbitControls.minPolarAngle = 0.025;
    orbitControls.panSpeed = 0.75;
    orbitControls.zoomSpeed = 0.8;
    orbitControls.enabled = false;
    orbitControls.listenToKeyEvents(renderer.domElement);

    const surfaceLight = new THREE.DirectionalLight('#fff6e6', 3.0);
    surfaceLight.castShadow = true;
    const shadowSize = Math.min(8_192, maxTextureSize);
    const shadowFilterRadius = 0.65;
    const terrainShadowMaterial = createTerrainShadowMaterial(shadowFilterRadius);
    surfaceLight.shadow.mapSize.set(shadowSize, shadowSize);
    surfaceLight.shadow.radius = shadowFilterRadius;
    surfaceLight.shadow.camera.left = surfaceLight.shadow.camera.bottom = -4_500;
    surfaceLight.shadow.camera.right = surfaceLight.shadow.camera.top = 4_500;
    surfaceLight.shadow.camera.near = 1;
    surfaceLight.shadow.camera.far = 180_000;
    // Keep the shared receiver offset small enough for the scale reference;
    // low-Sun terrain acne is handled by its separate slope-biased caster.
    surfaceLight.shadow.bias = -0.25 / (surfaceLight.shadow.camera.far - surfaceLight.shadow.camera.near);
    surfaceLight.shadow.normalBias = 0.05;
    const surfaceAmbient = new THREE.AmbientLight('#d8e4ef', 0.065);
    const inspectionFill = new THREE.DirectionalLight('#e1e8ec', 1.15);
    inspectionFill.visible = false;
    localScene.add(surfaceLight, surfaceLight.target, surfaceAmbient, inspectionFill, inspectionFill.target);
    const flatGround = new THREE.Mesh(new THREE.CircleGeometry(80_000, 128), new THREE.MeshStandardMaterial({ color: '#8a8985', roughness: 1 }));
    flatGround.rotation.x = -Math.PI / 2;
    flatGround.receiveShadow = true;
    localScene.add(flatGround);
    const sunDistance = 120_000, earthDistance = 80_000;
    const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.MeshBasicMaterial({ color: '#fff1c6', toneMapped: false }));
    const earthMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0 });
    const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), earthMaterial);
    // Render celestial appearance separately with the same depth buffer, so
    // the terrain inspection fill cannot accidentally brighten Earth's night.
    const celestialScene = new THREE.Scene();
    const celestialLight = new THREE.DirectionalLight('#fff6e6', 3.0);
    celestialScene.add(sunMesh, earthMesh, celestialLight, celestialLight.target, new THREE.AmbientLight('#d8e4ef', 0.045));
    const horizonMaterial = new THREE.MeshBasicMaterial({ color: '#11151b', side: THREE.DoubleSide });
    let horizon = new THREE.Mesh(new THREE.BufferGeometry(), horizonMaterial);
    localScene.add(horizon);
    let marker: ReturnType<typeof genericLander> | null = null;
    let markerGroundDirty = true;
    let analysisProfile: Horizon | null = null, analysisPoseKey = '', skyKey = '', observerLocationKey = '';
    let pendingFocus: 'sun' | 'earth' | null = null;
    let scenarioVisualKey = '', candidateVisualKey = '';
    let pickGesture: { pointerId: number; x: number; y: number; moved: boolean } | null = null;
    const scenarioGroups = new Map<string, THREE.Group>();
    const scenarioVisuals = new THREE.Group(); localScene.add(scenarioVisuals);
    let candidateVisual: THREE.Group | null = null;
    let sunDirection = new THREE.Vector3(1, 0, 0), earthDirection = new THREE.Vector3(0, 0, -1);

    function frameOrigin(): LunarFrameOrigin {
      const origin = loadedTerrainEntry?.origin;
      return {
        latitudeDeg: origin?.latitudeDeg ?? state.selectedSite.latitudeDeg,
        longitudeDeg: origin?.longitudeDeg ?? state.selectedSite.longitudeDeg,
        groundHeightM: origin?.centerHeightM ?? state.selectedSite.terrain.centerHeightM ?? 0,
        referenceRadiusM: state.selectedSite.terrain.referenceRadiusM,
      };
    }

    function analysisView(): SceneObserverView {
      if (state.analysisObservers) return state.analysisObservers[state.mode === 'surface' ? componentRef.current : 'panel'];
      return {
        latitudeDeg: state.selectedSite.latitudeDeg, longitudeDeg: state.selectedSite.longitudeDeg,
        groundHeightM: state.selectedSite.terrain.centerHeightM ?? 0,
        heightM: state.selectedSite.observerHeightM, horizon: state.selectedSite.horizon,
        sample: sampleAt(state.selectedSite, state.timeIndex, state.terrainEnabled),
      };
    }

    function skySignature(view: SceneObserverView) {
      return JSON.stringify({
        latitude: view.latitudeDeg, longitude: view.longitudeDeg, ground: view.groundHeightM, height: view.heightM,
        sample: view.sample, sunRadius: view.sunAngularRadiusDeg, earthRadius: view.earthAngularRadiusDeg,
        earthBlocked: view.earthBlockedSolarFraction,
      });
    }

    function refreshAnalysisHorizon() {
      if (state.analysisStatus && state.analysisStatus !== 'ready') return;
      const view = analysisView();
      const key = `${view.latitudeDeg},${view.longitudeDeg},${view.groundHeightM},${view.heightM},${state.terrainEnabled}`;
      if (view.horizon === analysisProfile && key === analysisPoseKey) return;
      analysisProfile = view.horizon; analysisPoseKey = key;
      localScene.remove(horizon); horizon.geometry.dispose();
      horizon = new THREE.Mesh(horizonGeometry({ horizon: view.horizon, observerHeightM: view.heightM }, state.terrainEnabled), horizonMaterial);
      const pose = observerPose(frameOrigin(), view);
      horizon.position.copy(pose.point); horizon.quaternion.copy(pose.orientation);
      localScene.add(horizon);
    }

    function syncScenarioVisuals() {
      const entries = (state.observers ?? []).filter(observer => observer.regionId === state.selectedSite.id);
      const active = state.activeObserverId ?? entries[0]?.id;
      const key = JSON.stringify(entries.map(({ panelNormalEnu: _normal, ...observer }) => ({ ...observer, detailed: observer.id === active })));
      if (key !== scenarioVisualKey) {
        scenarioVisualKey = key;
        for (const group of scenarioGroups.values()) { scenarioVisuals.remove(group); disposeObject(group); }
        scenarioGroups.clear();
        for (const observer of entries) {
          const group = scenarioObserverMarker(frameOrigin(), observer, observer.id === active);
          scenarioGroups.set(observer.id, group); scenarioVisuals.add(group);
        }
        markerGroundDirty = true;
      }
      for (const observer of entries) {
        const panel = scenarioGroups.get(observer.id)?.getObjectByName('solar-panel');
        if (panel && observer.panelNormalEnu) {
          const { east, north, up } = observer.panelNormalEnu;
          const normal = new THREE.Vector3(east, up, -north);
          if (normal.lengthSq() > 0 && normal.toArray().every(Number.isFinite)) panel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal.normalize());
        }
      }
      if (marker) {
        const observer = entries.find(entry => entry.id === active);
        const base = observer ? observerPose(frameOrigin(), observer) : null;
        const offset = new THREE.Vector3(7, 0, 3);
        if (base) offset.applyQuaternion(base.orientation).add(base.point);
        if (Math.hypot(marker.lander.position.x - offset.x, marker.lander.position.z - offset.z) > 0.0001) {
          marker.lander.position.copy(offset); markerGroundDirty = true;
        }
        const panel = marker.lander.getObjectByName('illustrative-body-panel');
        if (panel) panel.visible = !observer;
      }
      const candidate = state.candidate?.regionId === state.selectedSite.id ? state.candidate : null;
      const candidateKey = JSON.stringify(candidate);
      if (candidateKey !== candidateVisualKey) {
        candidateVisualKey = candidateKey;
        if (candidateVisual) { scenarioVisuals.remove(candidateVisual); disposeObject(candidateVisual); candidateVisual = null; }
        if (candidate) {
          candidateVisual = new THREE.Group();
          candidateVisual.position.set(candidate.displayPoint.x, candidate.displayPoint.y, candidate.displayPoint.z);
          candidateVisual.quaternion.copy(observerPose(frameOrigin(), { ...candidate, groundHeightM: candidate.displayGroundHeightM }).orientation);
          const material = new THREE.MeshBasicMaterial({ color: candidate.supported && candidate.status !== 'invalid' ? '#d8eff1' : '#ec9a86', side: THREE.DoubleSide, depthWrite: false });
          const ring = new THREE.Mesh(new THREE.RingGeometry(2.8, 3.5, 64), material);
          ring.rotation.x = -Math.PI / 2; ring.position.y = 0.12;
          candidateVisual.add(ring); scenarioVisuals.add(candidateVisual);
        }
      }
    }

    function invalidate() {
      if (!disposed && !frame) frame = requestAnimationFrame(draw);
    }

    function updateQualityLabel() {
      const tier = lunarColorWidth >= 16_000 ? '16K' : lunarColorWidth >= 8_000 ? '8K' : '2K';
      setVisualQuality(`${tier} lunar albedo${hasRelief ? ' · measured relief' : ''}`);
      host!.dataset.lunarTextureWidth = String(lunarColorWidth);
      host!.dataset.relief = hasRelief ? 'NASA height map · true scale' : 'Reference sphere';
    }

    function loadColor(entry: ImageAsset | undefined, target: 'moon' | 'earth') {
      if (!entry || (entry.width ?? 0) > maxTextureSize) return Promise.resolve();
      return new Promise<void>(resolve => {
        textureLoader.load(asset(entry.url), texture => {
          if (disposed) { texture.dispose(); resolve(); return; }
          const width = entry.width ?? texture.image.width ?? 0;
          if ((target === 'moon' ? lunarColorWidth : earthColorWidth) > width) { texture.dispose(); resolve(); return; }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = anisotropy;
          texture.wrapS = THREE.RepeatWrapping;
          texture.needsUpdate = true;
          textures.add(texture);
          const material = target === 'moon' ? moonMaterial : earthMaterial;
          const old = material.map;
          material.map = texture;
          material.needsUpdate = true;
          if (old && old !== texture) { textures.delete(old); old.dispose(); }
          if (target === 'moon') { lunarColorWidth = width; updateQualityLabel(); }
          else earthColorWidth = width;
          invalidate(); resolve();
        }, undefined, () => resolve());
      });
    }

    void loadColor({ url: 'textures/moon.jpg', width: 2048 }, 'moon');
    void loadColor({ url: 'textures/earth.png', width: 2048 }, 'earth');
    void fetch(asset('visuals/assets.json'), { signal: abort.signal, cache: 'no-cache' }).then(response => response.ok ? response.json() as Promise<VisualAssetManifest> : null).then(async manifest => {
      if (!manifest || disposed) return;
      const moonColors = manifest.moon?.color, earthColors = manifest.earth?.color;
      await Promise.all([loadColor(moonColors?.high ?? moonColors?.fallback, 'moon'), loadColor(earthColors?.high ?? earthColors?.fallback, 'earth')]);
      if (disposed) return;
      // Ultra assets load after the first useful frame, and never require a higher DPR.
      void loadColor(moonColors?.ultra, 'moon');
      void loadColor(earthColors?.ultra, 'earth');
      const height = manifest.moon?.height;
      if (height) {
        try {
          const response = await fetch(asset(height.url), { signal: abort.signal });
          if (!response.ok) return;
          const bytes = await response.arrayBuffer();
          if (disposed) return;
          applyLunarRelief(moon.geometry, bytes, height, MOON_RADIUS);
          // The supplied normal map contains the full DEM gradient. Applying it on
          // top of these measured mesh normals would count coarse slopes twice.
          hasRelief = true;
          updateQualityLabel(); invalidate();
        } catch (cause) {
          if (!disposed && !(cause instanceof DOMException && cause.name === 'AbortError')) host!.dataset.reliefError = 'Height asset unavailable; using the reference sphere.';
        }
      }
    }).catch(() => {});

    function desiredGlobePosition(site: Site) {
      const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
      moonEllipsoid.getEastNorthUpAxes(site.latitudeDeg * DEG, site.longitudeDeg * DEG, east, north, up);
      const limitingHalfFov = Math.atan(Math.tan(globeCamera.fov * DEG / 2) * Math.min(1, globeCamera.aspect));
      const distance = MOON_RADIUS / Math.sin(limitingHalfFov * 0.82);
      return up.multiplyScalar(3.25).add(north.multiplyScalar(0.9)).add(east.multiplyScalar(0.35)).normalize().multiplyScalar(distance);
    }

    function terrainHome() {
      // Keep the lander/observer reachable with a normal wheel zoom, while the
      // initial view communicates the crater's real kilometre-scale relief.
      return { position: new THREE.Vector3(2_600, 3_400, 4_400), target: new THREE.Vector3(0, 0, 0) };
    }

    function configureTileCamera() {
      if (!tiles || state.mode === 'globe') return;
      const next = state.mode === 'surface' ? surfaceCamera : terrainCamera;
      if (activeTileCamera === next) return;
      if (activeTileCamera) tiles.deleteCamera(activeTileCamera);
      tiles.setCamera(next);
      activeTileCamera = next;
    }

    function loadTerrain(site: Site, preserveCamera = false) {
      if (tiles) { terrainGroup.remove(tiles.group); tiles.dispose(); tiles = null; activeTileCamera = null; }
      if (fallback) { terrainGroup.remove(fallback); disposeObject(fallback); }
      loadedTerrainEntry = visuals?.sites[site.id];
      fallback = terrainMesh(loadedTerrainEntry?.fallback ?? site.terrain);
      fallback.customDepthMaterial = terrainShadowMaterial;
      terrainGroup.add(fallback);
      const url = loadedTerrainEntry?.tilesetUrl ?? site.terrain.tilesetUrl;
      if (url) {
        setLoadingTerrain(true);
        const currentTiles = new TilesRenderer(asset(url));
        // 3D Tiles is Z-up; GLTFLoader maps its Y-up content into that frame.
        // The local observatory's ENU rendering frame is X-east/Y-up/Z-south.
        currentTiles.group.rotation.x = -Math.PI / 2;
        currentTiles.errorTarget = loadedTerrainEntry ? 2 : 6;
        currentTiles.lruCache.maxSize = 180;
        currentTiles.lruCache.minSize = 100;
        tiles = currentTiles;
        configureTileCamera();
        currentTiles.addEventListener('needs-render', invalidate);
        currentTiles.addEventListener('needs-update', invalidate);
        currentTiles.addEventListener('tile-visibility-change', () => {
          if (disposed || tiles !== currentTiles) return;
          markerGroundDirty = true; invalidate();
        });
        currentTiles.addEventListener('load-model', (event: any) => {
          if (disposed || tiles !== currentTiles) return;
          markerGroundDirty = true;
          if (fallback) fallback.visible = false;
          event.scene?.traverse((child: THREE.Object3D) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true; child.receiveShadow = true;
              child.customDepthMaterial = terrainShadowMaterial;
              excludeTerrainSkirtsFromShadows(child);
            }
          });
          setLoadingTerrain(false);
          const spacing = event.scene?.userData?.meshSpacingM;
          const finest = loadedTerrainEntry?.levels?.reduce((n, level) => Math.min(n, level.spacingM), Infinity);
          setTerrainQuality(finest && Number.isFinite(finest) ? `NASA terrain · ${formatInteger.format(finest)} m finest mesh` : spacing ? `NASA terrain · ${formatInteger.format(spacing)} m mesh` : 'Local NASA terrain');
          renderer.shadowMap.needsUpdate = true;
          invalidate();
        });
        currentTiles.addEventListener('load-error', () => { if (!disposed) setLoadingTerrain(false); invalidate(); });
        terrainGroup.add(currentTiles.group);
      }
      if (marker) { localScene.remove(marker.lander, marker.observer); disposeObject(marker.lander); disposeObject(marker.observer); }
      marker = genericLander(site.observerHeightM);
      markerGroundDirty = true;
      localScene.add(marker.lander, marker.observer);
      scenarioVisualKey = ''; analysisProfile = null;
      syncScenarioVisuals(); refreshAnalysisHorizon(); updateSky();
      if (!preserveCamera) {
        const home = terrainHome();
        terrainCamera.position.copy(home.position); orbitControls.target.copy(home.target); orbitControls.update();
        orbitTarget = null;
      }
      renderer.shadowMap.needsUpdate = true;
    }

    void fetch(asset('visuals/terrain.json'), { signal: abort.signal, cache: 'no-cache' }).then(response => response.ok ? response.json() as Promise<TerrainVisualManifest> : null).then(manifest => {
      if (!manifest || disposed) return;
      visuals = manifest;
      // A late detail manifest upgrades the same location without stealing an
      // exploration camera that the user may already have moved.
      loadTerrain(state.selectedSite, true);
      invalidate();
    }).catch(() => {});

    function updateSky() {
      if (state.analysisStatus && state.analysisStatus !== 'ready') return;
      const view = analysisView(), sample = view.sample;
      skyKey = skySignature(view);
      const locationKey = `${state.activeObserverId ?? ''},${view.latitudeDeg},${view.longitudeDeg},${state.mode === 'surface' ? componentRef.current : 'panel'}`;
      if (observerLocationKey !== locationKey) {
        observerLocationKey = locationKey;
        const antenna = state.mode === 'surface' && componentRef.current === 'antenna';
        yaw = (antenna ? sample.earthAz : sample.sunAz) * DEG;
        pitch = (antenna ? sample.earthEl : Math.max(3, Math.min(10, sample.sunEl + 4))) * DEG;
      }
      const pose = observerPose(frameOrigin(), view);
      surfaceCamera.position.copy(pose.point).addScaledVector(pose.up, view.heightM);
      surfaceCamera.up.copy(pose.up);
      const angularRadius = (value: number | undefined, fallback: number) => value != null && Number.isFinite(value) && value > 0 && value < 30 ? value : fallback;
      sunMesh.scale.setScalar(Math.sin(angularRadius(view.sunAngularRadiusDeg, 0.266) * DEG) * sunDistance);
      earthMesh.scale.setScalar(Math.sin(angularRadius(view.earthAngularRadiusDeg, 0.95) * DEG) * earthDistance);
      const earthBlocked = view.earthBlockedSolarFraction;
      const visibleSun = earthBlocked != null && Number.isFinite(earthBlocked) ? 1 - THREE.MathUtils.clamp(earthBlocked, 0, 1) : 1;
      surfaceLight.intensity = 3 * visibleSun;
      host!.dataset.eclipseLightFraction = visibleSun.toFixed(6);
      flatGround.position.copy(pose.point);
      flatGround.quaternion.copy(pose.orientation).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
      sunDirection = localDirection(sample.sunAz, sample.sunEl).applyQuaternion(pose.orientation);
      earthDirection = localDirection(sample.earthAz, sample.earthEl).applyQuaternion(pose.orientation);
      surfaceLight.position.copy(sunDirection).multiplyScalar(100_000);
      surfaceLight.target.position.set(0, 0, 0);
      celestialLight.position.copy(surfaceLight.position);
      globeLight.position.copy(worldDirection(view, sample.sunAz, sample.sunEl)).multiplyScalar(10_000_000);
      // Rotation is an appearance cue; the Earth phase is illuminated by the
      // same topocentric Sun direction used by the selected lunar observer.
      const time = new Date(sample.timeUtc).getTime() / 1000;
      earthMesh.rotation.y = (time / 86_164.0905 * Math.PI * 2) % (Math.PI * 2);
      renderer.shadowMap.needsUpdate = true;
    }

    let captionPlacement: SceneCaptionPlacement | null = null;
    let captionMode = state.mode;
    function labelCaptionOwner(elements: Map<string, HTMLElement>, badges: readonly SceneMarkerBadge[], active: string | undefined, candidate: string | null = null) {
      const intent = captionIntent.current;
      if (intent.focused && elements.get(intent.focused) !== document.activeElement) intent.focused = null;
      if (intent.hovered && !elements.get(intent.hovered)?.matches(':hover')) intent.hovered = null;
      return sceneCaptionOwner({ ...intent, candidate, active }, new Set(badges.map(badge => badge.id)));
    }

    function placeLabelCaption(elements: Map<string, HTMLElement>, badges: readonly SceneMarkerBadge[], owner: string | null, text: string, width: number, height: number) {
      const caption = markerCaption.current;
      if (!caption) return;
      if (captionMode !== state.mode) { captionPlacement = null; captionMode = state.mode; }
      const hide = () => {
        caption.hidden = true; caption.setAttribute('aria-hidden', 'true'); delete caption.dataset.owner;
        for (const element of elements.values()) element.removeAttribute('aria-describedby');
      };
      if (!owner) { hide(); return; }
      if (caption.textContent !== text) caption.textContent = text;
      caption.hidden = false; caption.style.width = 'max-content';
      caption.style.minWidth = state.mode === 'terrain' ? `${Math.max(0, Math.min(180, width - 24))}px` : '0';
      caption.style.maxWidth = `${Math.max(1, Math.min(260, width - 24))}px`;
      const captionBounds = caption.getBoundingClientRect();
      const hostBounds = host!.getBoundingClientRect();
      const hud: SceneOverlayRect[] = [];
      const overlayRoot = host!.closest('.viewer') ?? host!.parentElement;
      for (const element of overlayRoot?.querySelectorAll<HTMLElement>('.viewer-title,.scene-body-controls,.scene-corner-controls,.guide-card,.scene-candidate-controls,.presentation-readings,.scene-pick-hint,.view-guidance,[data-scene-hud]') ?? []) {
        const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
        if (!bounds.width || !bounds.height || style.visibility === 'hidden' || Number(style.opacity) === 0 || bounds.right <= hostBounds.left || bounds.left >= hostBounds.right || bounds.bottom <= hostBounds.top || bounds.top >= hostBounds.bottom) continue;
        const x = Math.max(0, bounds.left - hostBounds.left), y = Math.max(0, bounds.top - hostBounds.top);
        hud.push({ x, y, width: Math.min(width, bounds.right - hostBounds.left) - x, height: Math.min(height, bounds.bottom - hostBounds.top) - y });
      }
      const placement = layoutSceneMarkerCaption(owner, badges, width, height, { width: captionBounds.width || 180, height: captionBounds.height || 34 }, hud, 12, 10, { previous: captionPlacement });
      if (!placement) { hide(); return; }
      captionPlacement = placement;
      caption.style.left = `${placement.x}px`; caption.style.top = `${placement.y}px`;
      caption.style.visibility = 'visible'; caption.setAttribute('aria-hidden', 'false'); caption.dataset.owner = owner; caption.dataset.side = placement.side;
      const ownerElement = elements.get(owner);
      for (const element of elements.values()) {
        if (element === ownerElement && element instanceof HTMLButtonElement) {
          if (element.getAttribute('aria-describedby') !== markerCaptionId) element.setAttribute('aria-describedby', markerCaptionId);
        } else element.removeAttribute('aria-describedby');
      }
    }

    function updateLabels() {
      const width = host!.clientWidth, height = host!.clientHeight;
      const placed: THREE.Vector2[] = [];
      const globeElements = new Map<string, HTMLElement>();
      const globeBadges: SceneMarkerBadge[] = [];
      const ordered = [...state.sites].sort((a, b) => Number(b.id === state.selectedSite.id) - Number(a.id === state.selectedSite.id));
      for (const site of ordered) {
        const element = labels.current[site.id];
        if (!element) continue;
        globeElements.set(site.id, element);
        const point = location(site, (site.terrain.centerHeightM ?? 0) + 2_000);
        const normal = point.clone().normalize();
        const projected = point.clone().project(globeCamera);
        const screen = new THREE.Vector2((projected.x * 0.5 + 0.5) * host!.clientWidth, (-projected.y * 0.5 + 0.5) * host!.clientHeight);
        const onFront = normal.dot(globeCamera.position.clone().sub(point).normalize()) > 0.02;
        const visible = state.mode === 'globe' && onFront && projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 0.95 && Math.abs(projected.y) < 0.95 && placed.every(previous => previous.distanceTo(screen) > 32);
        if (visible) {
          placed.push(screen);
          globeBadges.push({ id: site.id, x: screen.x, y: screen.y, anchorX: screen.x, anchorY: screen.y, size: Math.max(30, element.offsetWidth, element.offsetHeight) });
        }
        element.style.opacity = visible ? '1' : '0';
        element.style.pointerEvents = visible ? 'auto' : 'none';
        element.style.left = `${screen.x}px`;
        element.style.top = `${screen.y}px`;
        element.setAttribute('aria-hidden', visible ? 'false' : 'true');
        element.tabIndex = visible ? 0 : -1;
      }
      if (state.mode === 'globe') {
        const owner = labelCaptionOwner(globeElements, globeBadges, state.selectedSite.id);
        placeLabelCaption(globeElements, globeBadges, owner, state.sites.find(site => site.id === owner)?.name ?? '', width, height);
        return;
      }
      if (state.mode !== 'terrain') return;
      const camera = terrainCamera;
      const elements = new Map<string, HTMLElement>();
      for (const [id, element] of Object.entries(scenarioLabels.current)) if (element) elements.set(id, element);
      if (candidateLabel.current) elements.set('candidate', candidateLabel.current);
      const anchors: SceneMarkerAnchor[] = [];
      const addAnchor = (id: string, point: THREE.Vector3) => {
        const screen = point.project(camera);
        if (!elements.has(id) || screen.z <= -1 || screen.z >= 1 || Math.abs(screen.x) > 1 || Math.abs(screen.y) > 1) return;
        anchors.push({ id, x: (screen.x * 0.5 + 0.5) * width, y: (-screen.y * 0.5 + 0.5) * height });
      };
      for (const observer of state.observers ?? []) {
        if (observer.regionId !== state.selectedSite.id) continue;
        const pose = observerPose(frameOrigin(), observer);
        const markerHeight = observer.id === state.activeObserverId ? Math.max(observer.antennaHeightM, observer.panelHeightM) : 4;
        addAnchor(observer.id, pose.point.addScaledVector(pose.up, markerHeight + 1));
      }
      const candidate = state.candidate?.regionId === state.selectedSite.id ? state.candidate : null;
      if (candidate) addAnchor('candidate', new THREE.Vector3(candidate.displayPoint.x, candidate.displayPoint.y + 2, candidate.displayPoint.z));
      const badgeSize = Math.max(31, ...[...elements.values()].map(element => Math.max(element.offsetWidth, element.offsetHeight)));
      const badges = layoutSceneMarkerBadges(anchors, width, height, badgeSize);
      const visibleBadgeIds = new Set(badges.map(badge => badge.id));
      for (const [id, element] of elements) if (!visibleBadgeIds.has(id)) {
        element.style.opacity = '0'; element.style.pointerEvents = 'none';
        element.setAttribute('aria-hidden', 'true'); element.removeAttribute('aria-describedby');
        if (element instanceof HTMLButtonElement) element.tabIndex = -1;
      }
      for (const badge of badges) {
        const element = elements.get(badge.id)!;
        element.style.opacity = '1'; element.style.pointerEvents = element instanceof HTMLButtonElement ? 'auto' : 'none';
        element.style.left = `${badge.x}px`; element.style.top = `${badge.y}px`;
        const dx = badge.anchorX - badge.x, dy = badge.anchorY - badge.y;
        element.style.setProperty('--label-offset-x', `${-dx}px`); element.style.setProperty('--label-offset-y', `${-dy}px`);
        element.style.setProperty('--label-leader-length', `${Math.hypot(dx, dy)}px`);
        element.style.setProperty('--label-leader-angle', `${Math.atan2(dy, dx)}rad`);
        element.setAttribute('aria-hidden', 'false');
        if (element instanceof HTMLButtonElement) element.tabIndex = 0;
      }
      const owner = labelCaptionOwner(elements, badges, state.activeObserverId, candidate ? 'candidate' : null);
      const text = owner === 'candidate' ? candidate?.status === 'pending' ? 'Candidate · Checking point' : candidate?.status === 'invalid' ? 'Candidate · Unavailable point' : candidate?.supported ? 'Candidate · Preview point' : 'Candidate · Outside prepared area' : `${owner} · ${owner === state.activeObserverId ? 'Active observer' : 'Locked point'}`;
      placeLabelCaption(elements, badges, owner, text, width, height);
    }

    function updateSurfaceOrientation() {
      const pose = observerPose(frameOrigin(), analysisView());
      surfaceCamera.lookAt(surfaceCamera.position.clone().add(localDirection(yaw / DEG, pitch / DEG).applyQuaternion(pose.orientation)));
    }

    function refreshLocalClipping() {
      const distance = terrainCamera.position.distanceTo(orbitControls.target);
      terrainCamera.near = Math.max(0.05, Math.min(10, distance / 30_000));
      terrainCamera.far = Math.max(180_000, terrainCamera.position.length() + 160_000);
      terrainCamera.updateProjectionMatrix();
    }

    function draw(now: number) {
      frame = 0;
      if (disposed || document.hidden) return;
      const started = performance.now(), delta = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;
      const camera = state.mode === 'globe' ? globeCamera : state.mode === 'terrain' ? terrainCamera : surfaceCamera;
      if (state.mode === 'globe') {
        if (globeTarget) {
          globeCamera.position.lerp(globeTarget, reduceMotion ? 1 : 1 - Math.exp(-delta * 7));
          globeCamera.lookAt(0, 0, 0);
          // Reset/tweens bypass controls.update(); always refresh clipping too.
          globeControls.adjustCamera(globeCamera);
          if (globeCamera.position.distanceTo(globeTarget) < 20) { globeTarget = null; globeControls.enabled = true; }
          else invalidate();
        } else globeControls.update(Math.max(delta, 0.001));
      } else {
        if (state.mode === 'terrain') {
          if (orbitTarget) {
            const alpha = reduceMotion ? 1 : 1 - Math.exp(-delta * 7);
            terrainCamera.position.lerp(orbitTarget.position, alpha);
            orbitControls.target.lerp(orbitTarget.target, alpha);
            terrainCamera.lookAt(orbitControls.target);
            if (terrainCamera.position.distanceTo(orbitTarget.position) < 0.1 && orbitControls.target.distanceTo(orbitTarget.target) < 0.1) { orbitTarget = null; orbitControls.enabled = true; }
            else invalidate();
          } else orbitControls.update();
          refreshLocalClipping();
        } else updateSurfaceOrientation();
        configureTileCamera();
        if (tiles) { camera.updateMatrixWorld(); tiles.setResolutionFromRenderer(camera, renderer); tiles.update(); }
        // Celestial directions remain fixed to the selected observer. Their
        // display translation follows the exploration camera to remove false
        // kilometre-scale parallax while panning around the terrain.
        sunMesh.position.copy(sunDirection).multiplyScalar(sunDistance).add(camera.position);
        earthMesh.position.copy(earthDirection).multiplyScalar(earthDistance).add(camera.position);
      }
      terrainGroup.visible = state.terrainEnabled || state.mode === 'terrain';
      if (marker && markerGroundDirty && state.mode === 'terrain') {
        if (anchorLanderToTerrain(marker.lander, terrainGroup)) {
          markerGroundDirty = false;
          renderer.shadowMap.needsUpdate = true;
        }
      }
      const inspect = state.mode === 'terrain' && inspectionLighting;
      const analysisReady = !state.analysisStatus || state.analysisStatus === 'ready';
      surfaceLight.visible = analysisReady;
      surfaceLight.castShadow = !inspect;
      surfaceAmbient.intensity = inspect ? 0.42 : 0.065;
      inspectionFill.visible = inspect;
      if (inspect) {
        // A camera-side fill makes shaded relief readable while leaving the
        // modeled Sun direction unchanged. It is explicitly a display aid.
        inspectionFill.position.copy(terrainCamera.position).add(new THREE.Vector3(0, 10_000, 0));
        inspectionFill.target.position.copy(orbitControls.target);
      }
      flatGround.visible = state.mode === 'surface' && !state.terrainEnabled;
      horizon.visible = state.mode === 'surface' && analysisReady;
      scenarioVisuals.visible = state.mode === 'terrain';
      if (marker) { marker.lander.visible = state.mode === 'terrain'; marker.observer.visible = state.mode === 'terrain' && !state.observers?.length; }
      skyCamera.fov = camera.fov; skyCamera.aspect = camera.aspect;
      skyCamera.quaternion.copy(camera.quaternion); skyCamera.updateProjectionMatrix();
      renderer.info.reset();
      renderer.setClearColor('#05080d', 1); renderer.clear();
      renderer.render(skyScene, skyCamera); renderer.clearDepth();
      renderer.render(state.mode === 'globe' ? globeScene : localScene, camera);
      if (state.mode !== 'globe' && analysisReady) renderer.render(celestialScene, camera);
      camera.updateMatrixWorld(); updateLabels();
      framesRendered++;
      host!.dataset.framesRendered = String(framesRendered);
      if (framesRendered === 1) host!.dataset.firstFrameMs = performance.now().toFixed(1);
      host!.dataset.drawCalls = String(renderer.info.render.calls);
      host!.dataset.pixelRatio = String(renderer.getPixelRatio());
      host!.dataset.triangles = String(renderer.info.render.triangles);
      host!.dataset.frameCpuMs = (performance.now() - started).toFixed(2);
      host!.dataset.cameraPosition = camera.position.toArray().map(v => v.toFixed(1)).join(',');
      host!.dataset.centerProjection = new THREE.Vector3().project(camera).toArray().map(v => v.toFixed(3)).join(',');
      host!.dataset.cameraPlanes = `${camera.near.toFixed(2)},${camera.far.toFixed(0)}`;
      host!.dataset.depthMode = renderer.capabilities.logarithmicDepthBuffer ? 'Logarithmic depth' : 'Linear depth';
      host!.dataset.mode = state.mode;
      const view = analysisView();
      host!.dataset.analysisObserver = `${state.activeObserverId ?? state.selectedSite.id} · ${state.mode === 'surface' ? componentRef.current : 'panel'} · ${view.latitudeDeg},${view.longitudeDeg} · ${view.heightM} m`;
      host!.dataset.lightingMode = inspect ? 'Inspection fill · display only' : 'Modeled Sun';
      host!.dataset.shadowQuality = `${shadowSize} px · terrain filter-footprint caster bias · 0.25 m receiver bias`;
    }

    function update(next: SceneProps) {
      const changedSite = siteId !== next.selectedSite.id;
      state = next;
      globeControls.enabled = state.mode === 'globe' && !globeTarget;
      orbitControls.enabled = state.mode === 'terrain' && !orbitTarget;
      renderer.domElement.setAttribute('aria-label', state.mode === 'globe'
        ? 'Interactive Moon with measured global relief. Drag to orbit and scroll to zoom. Nearby site markers separate when zoomed in.'
        : state.mode === 'terrain'
          ? state.pickingEnabled ? 'Click visible terrain to preview a landing point. Drag to orbit; analysis changes only when a point is locked.' : 'Free lunar terrain exploration. Drag to orbit, right-drag to pan, scroll to zoom. Analysis remains anchored at the selected observer.'
          : 'Horizon at the fixed lunar observer. Drag or use arrow keys to look around. Scroll changes optical zoom without moving the observer.');
      if (changedSite) {
        siteId = state.selectedSite.id; loadTerrain(state.selectedSite);
        const sample = analysisView().sample;
        yaw = sample.sunAz * DEG; pitch = Math.max(3, Math.min(10, sample.sunEl + 4)) * DEG;
        const target = desiredGlobePosition(state.selectedSite);
        if (!globeCamera.position.lengthSq() || reduceMotion) { globeCamera.position.copy(target); globeCamera.lookAt(0, 0, 0); globeControls.adjustCamera(globeCamera); }
        else { globeTarget = target; globeControls.enabled = false; }
      }
      syncScenarioVisuals(); refreshAnalysisHorizon();
      if (state.mode !== previousMode) {
        previousMode = state.mode;
        renderer.shadowMap.needsUpdate = true;
        host!.classList.remove('scene-arriving');
        requestAnimationFrame(() => { if (!disposed) host!.classList.add('scene-arriving'); });
        configureTileCamera();
      }
      const view = analysisView();
      const nextSkyKey = skySignature(view);
      if (skyKey !== nextSkyKey) updateSky();
      if (pendingFocus && componentRef.current === (pendingFocus === 'sun' ? 'panel' : 'antenna')) {
        yaw = (pendingFocus === 'sun' ? view.sample.sunAz : view.sample.earthAz) * DEG;
        pitch = (pendingFocus === 'sun' ? view.sample.sunEl : view.sample.earthEl) * DEG;
        pendingFocus = null;
      }
      invalidate();
    }

    function resize() {
      const width = Math.max(host!.clientWidth, 1), height = Math.max(host!.clientHeight, 1);
      // Keep native sharpness on the M5/Retina demo computer. Only hardware
      // renderbuffer limits constrain DPR; there is no arbitrary 1.5 cap.
      const maximumDimension = renderer.capabilities.maxTextureSize;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, maximumDimension / width, maximumDimension / height);
      renderer.setPixelRatio(Math.max(1, pixelRatio)); renderer.setSize(width, height, false);
      globeCamera.aspect = surfaceCamera.aspect = terrainCamera.aspect = width / height;
      globeCamera.updateProjectionMatrix(); surfaceCamera.updateProjectionMatrix(); terrainCamera.updateProjectionMatrix();
      if (previousAspect && globeCamera.aspect < previousAspect && globeCamera.position.lengthSq()) {
        const minimum = desiredGlobePosition(state.selectedSite).length();
        if (globeCamera.position.length() < minimum) globeCamera.position.setLength(minimum);
        if (globeTarget && globeTarget.length() < minimum) globeTarget.setLength(minimum);
      }
      previousAspect = globeCamera.aspect;
      if (globeCamera.position.lengthSq()) globeControls.adjustCamera(globeCamera);
      invalidate();
    }

    function pointerDown(event: PointerEvent) {
      pickGesture = state.mode === 'terrain' && state.pickingEnabled && event.button === 0 ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false } : null;
      if (state.mode === 'globe') { globeTarget = null; globeControls.enabled = true; }
      else if (state.mode === 'terrain') { orbitTarget = null; orbitControls.enabled = true; }
      else { dragging = { x: event.clientX, y: event.clientY }; renderer.domElement.setPointerCapture(event.pointerId); }
      invalidate();
    }
    function pointerMove(event: PointerEvent) {
      if (pickGesture && Math.hypot(event.clientX - pickGesture.x, event.clientY - pickGesture.y) > 5) pickGesture.moved = true;
      if (state.mode === 'surface' && dragging) {
        yaw -= (event.clientX - dragging.x) * 0.004;
        pitch = THREE.MathUtils.clamp(pitch + (event.clientY - dragging.y) * 0.004, -70 * DEG, 85 * DEG);
        dragging = { x: event.clientX, y: event.clientY }; invalidate();
      }
    }
    function pickTerrain(event: PointerEvent) {
      const bounds = renderer.domElement.getBoundingClientRect();
      if (!bounds.width || !bounds.height || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      const ndc = new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2);
      const ray = new THREE.Raycaster();
      terrainCamera.updateMatrixWorld(); ray.setFromCamera(ndc, terrainCamera);
      const hit = raycastVisibleTerrain(ray, terrainGroup);
      if (!hit) return;
      const origin = frameOrigin(), geographic = scenePointToLunar(origin, hit.point);
      const rawOffsets = lunarArcOffsets(origin, geographic), domain = state.pickingDomain;
      const offsets = { eastM: Math.round(rawOffsets.eastM / 10) * 10, northM: Math.round(rawOffsets.northM / 10) * 10 };
      const snapped = lunarArcDestination(origin, offsets.eastM, offsets.northM);
      let displayHeight = geographic.groundHeightM;
      let position = lunarPointToScene(origin, { ...snapped, groundHeightM: displayHeight });
      // Reproject after the first height estimate so a coarse preview's
      // radius cannot leave the snapped latitude/longitude off its vertex.
      for (let i = 0; i < 2; i++) {
        position = lunarPointToScene(origin, { ...snapped, groundHeightM: displayHeight });
        const down = new THREE.Raycaster(new THREE.Vector3(position.x, 20_000, position.z), new THREE.Vector3(0, -1, 0), 0, 40_000);
        const surface = raycastVisibleTerrain(down, terrainGroup);
        if (!surface) break;
        position.y = surface.point.y;
        displayHeight = scenePointToLunar(origin, position).groundHeightM;
      }
      const supported = Boolean(domain && offsets.eastM >= domain.eastMinM && offsets.eastM <= domain.eastMaxM && offsets.northM >= domain.northMinM && offsets.northM <= domain.northMaxM);
      state.onTerrainPick?.({
        regionId: state.selectedSite.id, latitudeDeg: snapped.latitudeDeg, longitudeDeg: snapped.longitudeDeg,
        arcEastM: offsets.eastM, arcNorthM: offsets.northM,
        displayPoint: position, displayGroundHeightM: displayHeight,
        supported, message: !domain ? 'Prepared-area bounds are loading.' : supported ? '10 m selection grid. Lock to sample the scientific terrain and calculate horizons.' : 'Outside the prepared 5.12 km area. Choose a point closer to the current region centre.',
      });
    }
    function pointerUp(event: PointerEvent) {
      const shouldPick = event.type === 'pointerup' && pickGesture?.pointerId === event.pointerId && !pickGesture.moved && state.mode === 'terrain' && state.pickingEnabled;
      pickGesture = null; dragging = null;
      if (shouldPick) pickTerrain(event);
    }
    function wheel(event: WheelEvent) {
      if (state.mode !== 'surface') return;
      event.preventDefault();
      surfaceCamera.fov = THREE.MathUtils.clamp(surfaceCamera.fov * Math.exp(event.deltaY * 0.0009), 12, 85);
      surfaceCamera.updateProjectionMatrix(); invalidate();
    }
    function keydown(event: KeyboardEvent) {
      if (state.mode !== 'surface') return;
      if (event.key === 'ArrowLeft') yaw -= 5 * DEG;
      else if (event.key === 'ArrowRight') yaw += 5 * DEG;
      else if (event.key === 'ArrowUp') pitch = Math.min(pitch + 3 * DEG, 85 * DEG);
      else if (event.key === 'ArrowDown') pitch = Math.max(pitch - 3 * DEG, -70 * DEG);
      else return;
      event.preventDefault(); invalidate();
    }
    function lostContext(event: Event) {
      event.preventDefault(); setError('The browser paused the 3D view. Your mission settings are preserved.');
    }
    globeControls.addEventListener('change', invalidate);
    globeControls.addEventListener('start', invalidate);
    orbitControls.addEventListener('change', invalidate);
    renderer.domElement.addEventListener('pointerdown', pointerDown, true);
    renderer.domElement.addEventListener('pointermove', pointerMove);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    renderer.domElement.addEventListener('pointercancel', pointerUp);
    renderer.domElement.addEventListener('wheel', wheel, { passive: false });
    renderer.domElement.addEventListener('keydown', keydown);
    renderer.domElement.addEventListener('webglcontextlost', lostContext);
    document.addEventListener('visibilitychange', invalidate);
    const layoutSurface = host.closest('.viewer');
    const sceneLayoutChanged = () => {
      // Reflow against the new HUD synchronously, without a hidden frame.
      updateLabels();
      invalidate();
    };
    layoutSurface?.addEventListener('moonda:scene-layout', sceneLayoutChanged);
    const observer = new ResizeObserver(resize); observer.observe(host);
    runtime.current = {
      update,
      refreshLabels: invalidate,
      setInspectionLighting(enabled) {
        if (inspectionLighting !== enabled) renderer.shadowMap.needsUpdate = true;
        inspectionLighting = enabled; invalidate();
      },
      focus(body) {
        if (body === 'sun' || body === 'earth') {
          const component = body === 'sun' ? 'panel' : 'antenna';
          state.onObserverViewChange?.(component);
          if (state.observerView != null && state.observerView !== component) {
            pendingFocus = body;
            surfaceCamera.fov = body === 'earth' ? 30 : 45; surfaceCamera.updateProjectionMatrix();
            invalidate(); return;
          }
          componentRef.current = component;
          if (state.observerView == null) setViewComponent(component);
          refreshAnalysisHorizon(); updateSky();
        }
        const sample = analysisView().sample;
        if (body === 'marker') {
          const observer = state.observers?.find(entry => entry.id === state.activeObserverId && entry.regionId === state.selectedSite.id);
          const pose = observer ? observerPose(frameOrigin(), observer) : null;
          const position = new THREE.Vector3(16, 9, 18), target = new THREE.Vector3(3, 1.4, 1);
          if (pose) { position.applyQuaternion(pose.orientation).add(pose.point); target.applyQuaternion(pose.orientation).add(pose.point); }
          orbitTarget = { position, target };
          orbitControls.enabled = false;
          invalidate(); return;
        }
        if (body === 'reset') {
          if (state.mode === 'globe') { globeTarget = desiredGlobePosition(state.selectedSite); globeControls.enabled = false; }
          else if (state.mode === 'terrain') { orbitTarget = terrainHome(); orbitControls.enabled = false; }
          else { yaw = sample.sunAz * DEG; pitch = Math.max(3, sample.sunEl + 4) * DEG; surfaceCamera.fov = 65; surfaceCamera.updateProjectionMatrix(); }
        } else {
          yaw = (body === 'sun' ? sample.sunAz : sample.earthAz) * DEG;
          pitch = (body === 'sun' ? sample.sunEl : sample.earthEl) * DEG;
          surfaceCamera.fov = body === 'earth' ? 30 : 45;
          surfaceCamera.updateProjectionMatrix();
        }
        invalidate();
      },
    };
    resize(); update(state);

    return () => {
      disposed = true; abort.abort(); if (frame) cancelAnimationFrame(frame);
      observer.disconnect(); document.removeEventListener('visibilitychange', invalidate);
      layoutSurface?.removeEventListener('moonda:scene-layout', sceneLayoutChanged);
      renderer.domElement.removeEventListener('pointerdown', pointerDown, true);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointercancel', pointerUp);
      renderer.domElement.removeEventListener('wheel', wheel);
      renderer.domElement.removeEventListener('keydown', keydown);
      renderer.domElement.removeEventListener('webglcontextlost', lostContext);
      globeControls.dispose(); orbitControls.dispose();
      if (tiles) { terrainGroup.remove(tiles.group); tiles.dispose(); }
      disposeObject(globeScene); disposeObject(localScene); disposeObject(skyScene); disposeObject(celestialScene);
      terrainShadowMaterial.dispose();
      textures.forEach(texture => texture.dispose());
      surfaceLight.shadow.map?.dispose(); renderer.dispose(); renderer.domElement.remove(); runtime.current = null;
    };
  }, [props.sites, generation]);

  useEffect(() => { runtime.current?.update(props); }, [props]);

  const changeInspectionLighting = (enabled: boolean) => {
    inspectionRef.current = enabled;
    setInspectionLight(enabled);
    runtime.current?.setInspectionLighting(enabled);
  };
  const surfaceView = props.analysisObservers?.[resolvedView];
  const surfaceHeight = surfaceView?.heightM ?? props.selectedSite.observerHeightM;
  const candidate = props.candidate?.regionId === props.selectedSite.id ? props.candidate : null;
  const analysisReady = !props.analysisStatus || props.analysisStatus === 'ready';

  const changeMarkerIntent = (kind: 'focused' | 'hovered', id: string | null) => {
    captionIntent.current[kind] = id;
    runtime.current?.refreshLabels();
  };
  const instructions = props.mode === 'globe' ? 'Drag to orbit · Scroll to explore' : props.mode === 'terrain' ? 'Drag to orbit · Right-drag to pan · Scroll to zoom' : 'Drag to look · Scroll for optical zoom';
  const method = props.mode === 'globe' ? visualQuality : !analysisReady ? 'Observer analysis unavailable · Camera exploration remains independent' : props.mode === 'terrain' ? `${loadingTerrain ? 'Loading regional detail…' : terrainQuality} · ${inspectionLight ? 'Inspection light (display only)' : 'Sun lighting (estimated shadows)'} · Analysis remains at the locked observer` : `${props.activeObserverId ? `Scenario ${props.activeObserverId} · ` : ''}${surfaceView ? resolvedView === 'panel' ? 'Panel viewpoint' : 'Antenna viewpoint' : 'Fixed observer'} ${surfaceHeight} m above ground · ${loadingTerrain ? 'Loading local detail…' : terrainQuality} · Earth orientation is illustrative`;
  const bodyControls = props.mode === 'surface' ? <div className="scene-body-controls"><button type="button" disabled={!analysisReady} aria-pressed={resolvedView === 'panel'} onClick={() => runtime.current?.focus('sun')}><Sun size={16} />{props.analysisObservers ? 'Panel · Look toward Sun' : 'Look toward Sun'}</button><button type="button" disabled={!analysisReady} aria-pressed={resolvedView === 'antenna'} onClick={() => runtime.current?.focus('earth')}><GlobeHemisphereWest size={16} />{props.analysisObservers ? 'Antenna · Look toward Earth' : 'Look toward Earth'}</button></div>
    : props.mode === 'terrain' ? <div className="scene-body-controls"><button type="button" title="Inspect an original generic lander and the fixed analysis observer mast; the lander is an illustrative scale reference." onClick={() => runtime.current?.focus('marker')}><Crosshair size={16} />Inspect scale reference</button><div className="scene-lighting-controls" role="group" aria-label="Terrain display lighting"><button type="button" aria-pressed={inspectionLight} title="Display-only fill light helps you inspect shaded terrain. Visibility analysis is unchanged." onClick={() => changeInspectionLighting(true)}>Inspection light</button><button type="button" aria-pressed={!inspectionLight} title="Use the selected time's modeled Sun direction. Cast shadows are display estimates; visibility results use the validated horizon." onClick={() => changeInspectionLighting(false)}><Sun size={14} />Sun lighting</button></div></div> : null;
  const cornerControls = <div className="scene-corner-controls"><button type="button" aria-label="Reset camera" title="Reset camera" onClick={() => runtime.current?.focus('reset')}><ArrowCounterClockwise size={18} /></button>{props.onModeChange && <>
    {props.mode === 'terrain' && <button type="button" aria-label="Go to fixed horizon observer" title="Fixed horizon observer" onClick={() => props.onModeChange?.('surface')}><Crosshair size={18} /></button>}
    <button type="button" aria-label={props.mode === 'globe' ? 'Explore local terrain' : props.mode === 'surface' ? 'Explore terrain freely' : 'Return to lunar overview'} title={props.mode === 'globe' ? 'Explore local terrain' : props.mode === 'surface' ? 'Explore terrain freely' : 'Lunar overview'} onClick={() => props.onModeChange?.(props.mode === 'terrain' ? 'globe' : 'terrain')}>{props.mode === 'globe' ? <ArrowDown size={18} /> : <ArrowsOut size={18} />}</button>
  </>}</div>;
  const methodLabel = <div className={props.integratedControls && props.mode === 'globe' ? 'global-quality-badge' : 'surface-method'}>{method}</div>;

  return <div className={`lunar-scene lunar-scene--${props.mode}${props.integratedControls ? ' lunar-scene--integrated' : ''}`}>
    <div className="lunar-scene__canvas" ref={container} data-testid="lunar-canvas" />
    {props.mode === 'globe' && <div className="lunar-scene__pins" aria-label="Sites on the lunar globe">
      {props.sites.map((site, index) => <button key={site.id} ref={el => { labels.current[site.id] = el; }} className={`lunar-pin ${site.id === props.selectedSite.id ? 'is-selected' : ''}`} aria-label={`Select ${site.name}`}
        onPointerEnter={event => { if (event.pointerType !== 'touch') changeMarkerIntent('hovered', site.id); }} onPointerLeave={() => changeMarkerIntent('hovered', null)} onPointerCancel={() => changeMarkerIntent('hovered', null)}
        onFocus={() => changeMarkerIntent('focused', site.id)} onBlur={() => changeMarkerIntent('focused', null)} onClick={() => props.onSelectSite(site.id)}><span>{String(index + 1).padStart(2, '0')}</span></button>)}
    </div>}
    {props.mode === 'terrain' && <div className="lunar-scene__pins" aria-label="Locked scenario positions">
      {(props.observers ?? []).map(observer => <button key={observer.id} ref={element => { scenarioLabels.current[observer.id] = element; }} type="button" style={{ opacity: 0, pointerEvents: 'none' }} tabIndex={-1} aria-hidden="true" className={`scenario-scene-label ${observer.id === props.activeObserverId ? 'is-active' : ''}`} aria-label={`Activate scenario ${observer.id}`} aria-pressed={observer.id === props.activeObserverId}
        onPointerEnter={event => { if (event.pointerType !== 'touch') changeMarkerIntent('hovered', observer.id); }} onPointerLeave={() => changeMarkerIntent('hovered', null)} onPointerCancel={() => changeMarkerIntent('hovered', null)}
        onFocus={() => changeMarkerIntent('focused', observer.id)} onBlur={() => changeMarkerIntent('focused', null)} onClick={() => props.onActivateObserver?.(observer.id)}><i className="scenario-scene-label__leader" aria-hidden="true" /><span>{observer.id}</span></button>)}
      {candidate && <div ref={candidateLabel} className="scenario-scene-label is-candidate" style={{ opacity: 0, pointerEvents: 'none' }} aria-hidden="true" aria-label="Candidate landing point"><i className="scenario-scene-label__leader" aria-hidden="true" /><span>+</span></div>}
    </div>}
    {(props.mode === 'globe' || props.mode === 'terrain') && <div className="lunar-scene__pins lunar-scene__caption-layer"><div key={props.mode} ref={markerCaption} id={markerCaptionId} className="scenario-scene-caption" role="tooltip" hidden /></div>}
    {error ? <div className="scene-fallback" role="status"><p>{error}</p><button type="button" onClick={() => { setError(''); setGeneration(n => n + 1); }}>Retry 3D view</button></div> : <>
      {!props.integratedControls && <div className="scene-instructions"><span className="scene-status-dot" />{instructions}</div>}
      {!analysisReady && <div className="scene-pick-hint scene-analysis-status" role="status">{props.analysisStatus === 'loading' ? 'Calculating this observer… Sun, Earth and horizon appear when ready.' : 'This observer could not be calculated. Recalculate a supported point.'}</div>}
      {props.mode === 'terrain' && props.pickingEnabled && analysisReady && <div className="scene-pick-hint" role="status">10 m selection grid · Click ground to preview · Drag to explore · Lock to recalculate</div>}
      {props.mode === 'terrain' && candidate && <div className={`scene-candidate-controls ${candidate.status === 'pending' ? 'is-loading' : !candidate.supported || candidate.status === 'invalid' ? 'is-error' : ''}`} role="status">
        <strong>Candidate · {candidate.latitudeDeg.toFixed(5)}°, {candidate.longitudeDeg.toFixed(5)}°</strong>
        <p>{candidate.message ?? (candidate.supported ? 'Preview only. Lock this point to calculate its scientific horizon.' : 'Outside the prepared area.')}</p>
        <div className="scene-candidate-actions">{props.onLockCandidate && <button type="button" disabled={!candidate.supported || candidate.status === 'invalid' || candidate.status === 'pending'} onClick={props.onLockCandidate}>Lock point</button>}{props.onCancelCandidate && <button type="button" onClick={props.onCancelCandidate}>Cancel</button>}</div>
      </div>}
      {props.integratedControls ? <div className="scene-controls-dock" data-scene-hud="controls">
        <div className="scene-controls-row">{bodyControls}{cornerControls}</div>
        {methodLabel}
        <p className="scene-controls-guidance">{props.guidanceText ?? instructions}</p>
      </div> : <>{bodyControls}{cornerControls}{methodLabel}</>}
    </>}
  </div>;
}
