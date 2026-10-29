import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Ellipsoid, GlobeControls, TilesRenderer } from '3d-tiles-renderer/three';
import { ArrowCounterClockwise, ArrowDown, ArrowsOut, Crosshair, GlobeHemisphereWest, Sun } from '@phosphor-icons/react';
import { sampleAt } from './science';
import type { Site } from './types';
import { anchorLanderToTerrain, applyLunarRelief, createTerrainShadowMaterial, disposeObject, excludeTerrainSkirtsFromShadows, genericLander, terrainMesh } from './sceneAssets';
import type { ImageAsset, TerrainVisualEntry, TerrainVisualManifest, VisualAssetManifest } from './sceneAssets';

export type SceneMode = 'globe' | 'terrain' | 'surface';
export interface SceneProps {
  sites: Site[];
  selectedSite: Site;
  timeIndex: number;
  terrainEnabled: boolean;
  mode: SceneMode;
  onSelectSite: (id: string) => void;
  onModeChange?: (mode: SceneMode) => void;
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

function worldDirection(site: Site, azimuth: number, elevation: number) {
  const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
  moonEllipsoid.getEastNorthUpAxes(site.latitudeDeg * DEG, site.longitudeDeg * DEG, east, north, up);
  const direction = localDirection(azimuth, elevation);
  return east.multiplyScalar(direction.x).add(north.multiplyScalar(-direction.z)).add(up.multiplyScalar(direction.y));
}

function horizonGeometry(site: Site, enabled: boolean) {
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
  const runtime = useRef<{ update: (next: SceneProps) => void; focus: (body: 'sun' | 'earth' | 'reset' | 'marker') => void; setInspectionLighting: (enabled: boolean) => void } | null>(null);
  const currentProps = useRef(props);
  const labels = useRef<Record<string, HTMLButtonElement | null>>({});
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const [loadingTerrain, setLoadingTerrain] = useState(false);
  const [visualQuality, setVisualQuality] = useState('Loading lunar detail');
  const [terrainQuality, setTerrainQuality] = useState('Local NASA terrain');
  const [inspectionLight, setInspectionLight] = useState(true);
  const inspectionRef = useRef(true);
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
    const sunDistance = 120_000;
    const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(Math.tan(0.266 * DEG) * sunDistance, 48, 32), new THREE.MeshBasicMaterial({ color: '#fff1c6', toneMapped: false }));
    const earthMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0 });
    const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(Math.tan(0.95 * DEG) * sunDistance, 96, 64), earthMaterial);
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
    let sunDirection = new THREE.Vector3(1, 0, 0), earthDirection = new THREE.Vector3(0, 0, -1);

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
      const sample = sampleAt(state.selectedSite, state.timeIndex, state.terrainEnabled);
      surfaceCamera.position.set(0, state.selectedSite.observerHeightM, 0);
      sunDirection = localDirection(sample.sunAz, sample.sunEl);
      earthDirection = localDirection(sample.earthAz, sample.earthEl);
      surfaceLight.position.copy(sunDirection).multiplyScalar(100_000);
      surfaceLight.target.position.set(0, 0, 0);
      celestialLight.position.copy(surfaceLight.position);
      globeLight.position.copy(worldDirection(state.selectedSite, sample.sunAz, sample.sunEl)).multiplyScalar(10_000_000);
      // Rotation is an appearance cue; the Earth phase is illuminated by the
      // same topocentric Sun direction used by the selected lunar observer.
      const time = new Date(sample.timeUtc).getTime() / 1000;
      earthMesh.rotation.y = (time / 86_164.0905 * Math.PI * 2) % (Math.PI * 2);
      renderer.shadowMap.needsUpdate = true;
    }

    function updateLabels() {
      const placed: THREE.Vector2[] = [];
      const ordered = [...state.sites].sort((a, b) => Number(b.id === state.selectedSite.id) - Number(a.id === state.selectedSite.id));
      for (const site of ordered) {
        const element = labels.current[site.id];
        if (!element) continue;
        const point = location(site, (site.terrain.centerHeightM ?? 0) + 2_000);
        const normal = point.clone().normalize();
        const projected = point.clone().project(globeCamera);
        const screen = new THREE.Vector2((projected.x * 0.5 + 0.5) * host!.clientWidth, (-projected.y * 0.5 + 0.5) * host!.clientHeight);
        const onFront = normal.dot(globeCamera.position.clone().sub(point).normalize()) > 0.02;
        const visible = state.mode === 'globe' && onFront && projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 0.95 && Math.abs(projected.y) < 0.95 && placed.every(previous => previous.distanceTo(screen) > 32);
        if (visible) placed.push(screen);
        element.style.opacity = visible ? '1' : '0';
        element.style.pointerEvents = visible ? 'auto' : 'none';
        element.style.left = `${screen.x}px`;
        element.style.top = `${screen.y}px`;
        element.setAttribute('aria-hidden', visible ? 'false' : 'true');
        element.tabIndex = visible ? 0 : -1;
      }
    }

    function updateSurfaceOrientation() {
      surfaceCamera.lookAt(surfaceCamera.position.clone().add(localDirection(yaw / DEG, pitch / DEG)));
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
        earthMesh.position.copy(earthDirection).multiplyScalar(sunDistance).add(camera.position);
      }
      terrainGroup.visible = state.terrainEnabled || state.mode === 'terrain';
      if (marker && markerGroundDirty && state.mode === 'terrain') {
        if (anchorLanderToTerrain(marker.lander, terrainGroup)) {
          markerGroundDirty = false;
          renderer.shadowMap.needsUpdate = true;
        }
      }
      const inspect = state.mode === 'terrain' && inspectionLighting;
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
      horizon.visible = state.mode === 'surface';
      if (marker) { marker.lander.visible = marker.observer.visible = state.mode === 'terrain'; }
      skyCamera.fov = camera.fov; skyCamera.aspect = camera.aspect;
      skyCamera.quaternion.copy(camera.quaternion); skyCamera.updateProjectionMatrix();
      renderer.info.reset();
      renderer.setClearColor('#05080d', 1); renderer.clear();
      renderer.render(skyScene, skyCamera); renderer.clearDepth();
      renderer.render(state.mode === 'globe' ? globeScene : localScene, camera);
      if (state.mode !== 'globe') renderer.render(celestialScene, camera);
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
      host!.dataset.analysisObserver = `${state.selectedSite.id} · ${state.selectedSite.observerHeightM} m`;
      host!.dataset.lightingMode = inspect ? 'Inspection fill · display only' : 'Modeled Sun';
      host!.dataset.shadowQuality = `${shadowSize} px · terrain filter-footprint caster bias · 0.25 m receiver bias`;
    }

    function update(next: SceneProps) {
      const changedSite = siteId !== next.selectedSite.id;
      const changedTerrain = state.terrainEnabled !== next.terrainEnabled;
      const changedTime = state.timeIndex !== next.timeIndex;
      state = next;
      globeControls.enabled = state.mode === 'globe' && !globeTarget;
      orbitControls.enabled = state.mode === 'terrain' && !orbitTarget;
      renderer.domElement.setAttribute('aria-label', state.mode === 'globe'
        ? 'Interactive Moon with measured global relief. Drag to orbit and scroll to zoom. Nearby site markers separate when zoomed in.'
        : state.mode === 'terrain'
          ? 'Free lunar terrain exploration. Drag to orbit, right-drag to pan, scroll to zoom. Analysis remains anchored at the selected observer.'
          : 'Horizon at the fixed lunar observer. Drag or use arrow keys to look around. Scroll changes optical zoom without moving the observer.');
      if (changedSite) {
        siteId = state.selectedSite.id; loadTerrain(state.selectedSite);
        const sample = sampleAt(state.selectedSite, state.timeIndex, state.terrainEnabled);
        yaw = sample.sunAz * DEG; pitch = Math.max(3, Math.min(10, sample.sunEl + 4)) * DEG;
        const target = desiredGlobePosition(state.selectedSite);
        if (!globeCamera.position.lengthSq() || reduceMotion) { globeCamera.position.copy(target); globeCamera.lookAt(0, 0, 0); globeControls.adjustCamera(globeCamera); }
        else { globeTarget = target; globeControls.enabled = false; }
      }
      if (changedSite || changedTerrain) {
        localScene.remove(horizon); horizon.geometry.dispose();
        horizon = new THREE.Mesh(horizonGeometry(state.selectedSite, state.terrainEnabled), horizonMaterial);
        localScene.add(horizon);
      }
      if (state.mode !== previousMode) {
        previousMode = state.mode;
        renderer.shadowMap.needsUpdate = true;
        host!.classList.remove('scene-arriving');
        requestAnimationFrame(() => { if (!disposed) host!.classList.add('scene-arriving'); });
        configureTileCamera();
      }
      if (changedSite || changedTime) updateSky();
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
      if (state.mode === 'globe') { globeTarget = null; globeControls.enabled = true; }
      else if (state.mode === 'terrain') { orbitTarget = null; orbitControls.enabled = true; }
      else { dragging = { x: event.clientX, y: event.clientY }; renderer.domElement.setPointerCapture(event.pointerId); }
      invalidate();
    }
    function pointerMove(event: PointerEvent) {
      if (state.mode === 'surface' && dragging) {
        yaw -= (event.clientX - dragging.x) * 0.004;
        pitch = THREE.MathUtils.clamp(pitch + (event.clientY - dragging.y) * 0.004, -70 * DEG, 85 * DEG);
        dragging = { x: event.clientX, y: event.clientY }; invalidate();
      }
    }
    function pointerUp() { dragging = null; }
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
    const observer = new ResizeObserver(resize); observer.observe(host);
    runtime.current = {
      update,
      setInspectionLighting(enabled) {
        if (inspectionLighting !== enabled) renderer.shadowMap.needsUpdate = true;
        inspectionLighting = enabled; invalidate();
      },
      focus(body) {
        const sample = sampleAt(state.selectedSite, state.timeIndex, state.terrainEnabled);
        if (body === 'marker') {
          orbitTarget = { position: new THREE.Vector3(16, 9, 18), target: new THREE.Vector3(3, 1.4, 1) };
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

  return <div className={`lunar-scene lunar-scene--${props.mode}`}>
    <div className="lunar-scene__canvas" ref={container} data-testid="lunar-canvas" />
    {props.mode === 'globe' && <div className="lunar-scene__pins" aria-label="Sites on the lunar globe">
      {props.sites.map((site, index) => <button key={site.id} ref={el => { labels.current[site.id] = el; }} className={`lunar-pin ${site.id === props.selectedSite.id ? 'is-selected' : ''}`} title={site.name} aria-label={`Select ${site.name}`} onClick={() => props.onSelectSite(site.id)}><span>{String(index + 1).padStart(2, '0')}</span><strong className="lunar-pin__label">{site.name}</strong></button>)}
    </div>}
    {error ? <div className="scene-fallback" role="status"><p>{error}</p><button type="button" onClick={() => { setError(''); setGeneration(n => n + 1); }}>Retry 3D view</button></div> : <>
      <div className="scene-instructions"><span className="scene-status-dot" />{props.mode === 'globe' ? 'Drag to orbit · Scroll to explore' : props.mode === 'terrain' ? 'Drag to orbit · Right-drag to pan · Scroll to zoom' : 'Drag to look · Scroll for optical zoom'}</div>
      {props.mode === 'surface' && <div className="scene-body-controls"><button type="button" onClick={() => runtime.current?.focus('sun')}><Sun size={16} />Look toward Sun</button><button type="button" onClick={() => runtime.current?.focus('earth')}><GlobeHemisphereWest size={16} />Look toward Earth</button></div>}
      {props.mode === 'terrain' && <div className="scene-body-controls"><button type="button" title="Inspect an original generic lander and the fixed analysis observer mast; the lander is an illustrative scale reference." onClick={() => runtime.current?.focus('marker')}><Crosshair size={16} />Inspect scale reference</button><div className="scene-lighting-controls" role="group" aria-label="Terrain display lighting"><button type="button" aria-pressed={inspectionLight} title="Display-only fill light helps you inspect shaded terrain. Visibility analysis is unchanged." onClick={() => changeInspectionLighting(true)}>Inspection light</button><button type="button" aria-pressed={!inspectionLight} title="Use the selected time's modeled Sun direction. Cast shadows are display estimates; visibility results use the validated horizon." onClick={() => changeInspectionLighting(false)}><Sun size={14} />Sun lighting</button></div></div>}
      <div className="scene-corner-controls"><button type="button" aria-label="Reset camera" title="Reset camera" onClick={() => runtime.current?.focus('reset')}><ArrowCounterClockwise size={18} /></button>{props.onModeChange && <>
        {props.mode === 'terrain' && <button type="button" aria-label="Go to fixed horizon observer" title="Fixed horizon observer" onClick={() => props.onModeChange?.('surface')}><Crosshair size={18} /></button>}
        <button type="button" aria-label={props.mode === 'globe' ? 'Explore local terrain' : props.mode === 'surface' ? 'Explore terrain freely' : 'Return to lunar overview'} title={props.mode === 'globe' ? 'Explore local terrain' : props.mode === 'surface' ? 'Explore terrain freely' : 'Lunar overview'} onClick={() => props.onModeChange?.(props.mode === 'terrain' ? 'globe' : 'terrain')}>{props.mode === 'globe' ? <ArrowDown size={18} /> : <ArrowsOut size={18} />}</button>
      </>}</div>
      <div className="surface-method">{props.mode === 'globe' ? visualQuality : props.mode === 'terrain' ? `${loadingTerrain ? 'Loading regional detail…' : terrainQuality} · ${inspectionLight ? 'Inspection light (display only)' : 'Sun lighting (estimated shadows)'} · Analysis remains at the fixed observer` : `Fixed observer ${props.selectedSite.observerHeightM} m above ground · ${loadingTerrain ? 'Loading local detail…' : terrainQuality} · Earth orientation is illustrative`}</div>
    </>}
  </div>;
}
