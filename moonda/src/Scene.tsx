import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Ellipsoid, GlobeControls, TilesRenderer } from '3d-tiles-renderer/three';
import { ArrowCounterClockwise, ArrowDown, ArrowsOut, GlobeHemisphereWest, Sun } from '@phosphor-icons/react';
import { sampleAt } from './science';
import type { Site } from './types';

export interface SceneProps {
  sites: Site[];
  selectedSite: Site;
  timeIndex: number;
  terrainEnabled: boolean;
  mode: 'globe' | 'surface';
  onSelectSite: (id: string) => void;
  onModeChange?: (mode: 'globe' | 'surface') => void;
}

const MOON_RADIUS = 1_737_400;
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 0, 1);
const moonEllipsoid = new Ellipsoid(MOON_RADIUS, MOON_RADIUS, MOON_RADIUS);
const asset = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\.\//, '')}`;

function location(site: Site, height = 0) {
  return moonEllipsoid.getCartographicToPosition(site.latitudeDeg * DEG, site.longitudeDeg * DEG, height, new THREE.Vector3()) as THREE.Vector3;
}

function localDirection(azimuth: number, elevation: number) {
  const az = azimuth * DEG;
  const el = elevation * DEG;
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

function worldDirection(site: Site, azimuth: number, elevation: number) {
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  const up = new THREE.Vector3();
  moonEllipsoid.getEastNorthUpAxes(site.latitudeDeg * DEG, site.longitudeDeg * DEG, east, north, up);
  const local = localDirection(azimuth, elevation);
  return east.multiplyScalar(local.x).add(north.multiplyScalar(-local.z)).add(up.multiplyScalar(local.y));
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

function horizonGeometry(site: Site, enabled: boolean) {
  const profile = site.horizon.elevationDeg;
  const positions: number[] = [];
  const count = profile.length;
  const radius = 28_000;
  for (let i = 0; i < count; i++) {
    const a = i * 2 * Math.PI / count;
    const b = (i + 1) * 2 * Math.PI / count;
    const ya = Math.tan((enabled ? profile[i] : 0) * DEG) * radius + site.observerHeightM;
    const yb = Math.tan((enabled ? profile[(i + 1) % count] : 0) * DEG) * radius + site.observerHeightM;
    const x1 = Math.sin(a) * radius, z1 = -Math.cos(a) * radius;
    const x2 = Math.sin(b) * radius, z2 = -Math.cos(b) * radius;
    positions.push(x1, -15000, z1, x2, -15000, z2, x1, ya, z1, x1, ya, z1, x2, -15000, z2, x2, yb, z2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function fallbackTerrain(site: Site) {
  const { terrain } = site;
  const n = terrain.size;
  const positions = new Float32Array(n * n * 3);
  const indices: number[] = [];
  const centerHeight = terrain.centerHeightM ?? terrain.heightsM[Math.floor(n / 2) * n + Math.floor(n / 2)] ?? 0;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = row * n + col;
      positions[3 * i] = terrain.bounds.eastMinM + col / (n - 1) * (terrain.bounds.eastMaxM - terrain.bounds.eastMinM);
      positions[3 * i + 1] = terrain.heightsM[i] - centerHeight;
      positions[3 * i + 2] = -(terrain.bounds.northMaxM - row / (n - 1) * (terrain.bounds.northMaxM - terrain.bounds.northMinM));
      positions[3 * i + 1] -= (positions[3 * i] ** 2 + positions[3 * i + 2] ** 2) / (2 * terrain.referenceRadiusM);
      if (row < n - 1 && col < n - 1) {
        indices.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#777c81', roughness: 1, metalness: 0, side: THREE.DoubleSide }));
}

export default function Scene(props: SceneProps) {
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ update: (next: SceneProps) => void; focus: (body: 'sun' | 'earth' | 'reset') => void } | null>(null);
  const currentProps = useRef(props);
  const labels = useRef<Record<string, HTMLButtonElement | null>>({});
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const [loadingTerrain, setLoadingTerrain] = useState(false);
  currentProps.current = props;

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      setError('This browser could not start the 3D view. You can still use the analysis and comparison below.');
      return;
    }
    let disposed = false;
    let frame = 0;
    let framesRendered = 0;
    let lastTime = performance.now();
    let state = currentProps.current;
    let siteId = '';
    let previousMode = state.mode;
    let yaw = 140 * DEG;
    let pitch = 5 * DEG;
    let dragging: { x: number; y: number } | null = null;
    let cameraTarget: THREE.Vector3 | null = null;
    let previousAspect = 0;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, host.clientWidth < 700 ? 1.25 : 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.autoClear = false;
    renderer.domElement.setAttribute('aria-label', 'Interactive lunar overview. Drag to rotate. Use the named site buttons or site list to select a location.');
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.tabIndex = 0;
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    host.appendChild(renderer.domElement);

    const globeScene = new THREE.Scene();
    const globeGroup = new THREE.Group();
    globeScene.add(globeGroup);
    const globeCamera = new THREE.PerspectiveCamera(36, 1, 1000, 30_000_000);
    globeCamera.up.copy(UP);
    const controls = new GlobeControls(globeGroup, globeCamera, renderer.domElement);
    controls.setEllipsoid(moonEllipsoid, globeGroup);
    controls.enableDamping = true;
    controls.minDistance = MOON_RADIUS * 0.08;
    controls.maxDistance = MOON_RADIUS * 8;
    controls.adjustHeight = false;

    const globeLight = new THREE.DirectionalLight('#fff6df', 3.5);
    globeScene.add(globeLight, new THREE.AmbientLight('#b0c0d0', 0.075));
    const moonMaterial = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, color: '#d3d4d2' });
    const moon = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS, 112, 72), moonMaterial);
    moon.rotation.x = Math.PI / 2;
    globeGroup.add(moon);

    const skyScene = new THREE.Scene();
    const skyCamera = new THREE.PerspectiveCamera(36, 1, 0.1, 5000);
    const starPositions = new Float32Array(850 * 3);
    let seed = 619;
    const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    for (let i = 0; i < 850; i++) {
      const z = 2 * random() - 1;
      const theta = random() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      starPositions[3 * i] = r * Math.cos(theta) * 3000;
      starPositions[3 * i + 1] = r * Math.sin(theta) * 3000;
      starPositions[3 * i + 2] = z * 3000;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: '#9daeba', size: 1.5, sizeAttenuation: false, transparent: true, opacity: 0.43, depthWrite: false }));
    skyScene.add(stars);

    const surfaceScene = new THREE.Scene();
    const surfaceCamera = new THREE.PerspectiveCamera(65, 1, 0.5, 120_000);
    surfaceCamera.position.set(0, state.selectedSite.observerHeightM, 0);
    const terrainGroup = new THREE.Group();
    surfaceScene.add(terrainGroup);
    const surfaceLight = new THREE.DirectionalLight('#fff0cb', 2.8);
    surfaceScene.add(surfaceLight, new THREE.HemisphereLight('#596c80', '#24262b', 0.42));
    const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(280, 24, 16), new THREE.MeshBasicMaterial({ color: '#ffe2a0' }));
    const earthMaterial = new THREE.MeshBasicMaterial({ color: '#c5e7ff' });
    const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(1050, 40, 28), earthMaterial);
    surfaceScene.add(sunMesh, earthMesh);
    let horizon = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: '#151b23', side: THREE.DoubleSide }));
    surfaceScene.add(horizon);
    let tiles: any = null;
    let fallback: THREE.Mesh | null = null;

    const textureLoader = new THREE.TextureLoader();
    const textures: THREE.Texture[] = [];
    textureLoader.load(asset('textures/moon.jpg'), (texture) => {
      if (disposed) { texture.dispose(); return; }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
      textures.push(texture);
      moonMaterial.map = texture;
      moonMaterial.needsUpdate = true;
      invalidate();
    }, undefined, () => invalidate());
    textureLoader.load(asset('textures/earth.png'), (texture) => {
      if (disposed) { texture.dispose(); return; }
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.push(texture);
      earthMaterial.map = texture;
      earthMaterial.color.set('#ffffff');
      earthMaterial.needsUpdate = true;
      invalidate();
    });

    function desiredGlobePosition(site: Site) {
      const east = new THREE.Vector3();
      const north = new THREE.Vector3();
      const up = new THREE.Vector3();
      moonEllipsoid.getEastNorthUpAxes(site.latitudeDeg * DEG, site.longitudeDeg * DEG, east, north, up);
      const limitingHalfFov = Math.atan(Math.tan(globeCamera.fov * DEG / 2) * Math.min(1, globeCamera.aspect));
      const distance = MOON_RADIUS / Math.sin(limitingHalfFov * 0.8);
      return up.multiplyScalar(3.25).add(north.multiplyScalar(0.9)).add(east.multiplyScalar(0.35)).normalize().multiplyScalar(distance);
    }

    function invalidate() {
      if (!disposed && !frame) frame = requestAnimationFrame(draw);
    }

    function updateLabels() {
      for (const site of state.sites) {
        const element = labels.current[site.id];
        if (!element) continue;
        const point = location(site, 2000);
        const normal = point.clone().normalize();
        const visible = state.mode === 'globe' && normal.dot(globeCamera.position.clone().sub(point).normalize()) > 0.02;
        const projected = point.project(globeCamera);
        element.style.opacity = visible && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 ? '1' : '0';
        element.style.pointerEvents = visible ? 'auto' : 'none';
        element.style.left = `${(projected.x * 0.5 + 0.5) * host!.clientWidth}px`;
        element.style.top = `${(-projected.y * 0.5 + 0.5) * host!.clientHeight}px`;
      }
    }

    function loadTerrain(site: Site) {
      if (tiles) { terrainGroup.remove(tiles.group); tiles.dispose(); tiles = null; }
      if (fallback) { terrainGroup.remove(fallback); disposeObject(fallback); }
      fallback = fallbackTerrain(site);
      terrainGroup.add(fallback);
      if (site.terrain.tilesetUrl) {
        setLoadingTerrain(true);
        const currentTiles = new TilesRenderer(asset(site.terrain.tilesetUrl));
        // 3D Tiles uses a Z-up tile frame; GLTFLoader's Y-up content is rotated
        // into it by the upstream renderer. The local sky scene uses Y-up.
        currentTiles.group.rotation.x = -Math.PI / 2;
        tiles = currentTiles;
        currentTiles.setCamera(surfaceCamera);
        currentTiles.errorTarget = 8;
        currentTiles.addEventListener('needs-render', invalidate);
        currentTiles.addEventListener('needs-update', invalidate);
        currentTiles.addEventListener('load-model', () => {
          if (disposed || tiles !== currentTiles) return;
          if (fallback) fallback.visible = false;
          setLoadingTerrain(false);
          invalidate();
        });
        currentTiles.addEventListener('load-error', () => {
          if (!disposed) setLoadingTerrain(false);
          invalidate();
        });
        terrainGroup.add(currentTiles.group);
      }
    }

    function updateSky() {
      const sample = sampleAt(state.selectedSite, state.timeIndex, state.terrainEnabled);
      surfaceCamera.position.y = state.selectedSite.observerHeightM;
      const sun = localDirection(sample.sunAz, sample.sunEl);
      const earth = localDirection(sample.earthAz, sample.earthEl);
      sunMesh.position.copy(sun).multiplyScalar(60_000).add(surfaceCamera.position);
      earthMesh.position.copy(earth).multiplyScalar(60_000).add(surfaceCamera.position);
      surfaceLight.position.copy(sun).multiplyScalar(50_000);
      globeLight.position.copy(worldDirection(state.selectedSite, sample.sunAz, sample.sunEl)).multiplyScalar(10_000_000);
    }

    function updateSurfaceOrientation() {
      const direction = localDirection(yaw / DEG, pitch / DEG);
      surfaceCamera.lookAt(surfaceCamera.position.clone().add(direction));
    }

    function draw(now: number) {
      frame = 0;
      if (disposed || document.hidden) return;
      const delta = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;
      const camera = state.mode === 'globe' ? globeCamera : surfaceCamera;
      if (state.mode === 'globe') {
        if (cameraTarget) {
          globeCamera.position.lerp(cameraTarget, reduceMotion ? 1 : 1 - Math.exp(-delta * 7));
          globeCamera.lookAt(0, 0, 0);
          // Manual transitions bypass controls.update(), so refresh clipping
          // here too; stale planes can cut a hole through the Moon on reset.
          controls.adjustCamera(globeCamera);
          if (globeCamera.position.distanceTo(cameraTarget) < 30) { cameraTarget = null; controls.enabled = true; }
          else invalidate();
        } else controls.update(Math.max(delta, 0.001));
      } else {
        updateSurfaceOrientation();
        if (tiles) { surfaceCamera.updateMatrixWorld(); tiles.setResolutionFromRenderer(surfaceCamera, renderer); tiles.update(); }
      }
      skyCamera.fov = camera.fov;
      skyCamera.aspect = camera.aspect;
      skyCamera.quaternion.copy(camera.quaternion);
      skyCamera.updateProjectionMatrix();
      renderer.setClearColor('#080c10', 1);
      renderer.clear();
      renderer.render(skyScene, skyCamera);
      renderer.clearDepth();
      renderer.render(state.mode === 'globe' ? globeScene : surfaceScene, camera);
      camera.updateMatrixWorld();
      updateLabels();
      framesRendered++;
      host!.dataset.framesRendered = String(framesRendered);
      if (framesRendered === 1) host!.dataset.firstFrameMs = performance.now().toFixed(1);
      host!.dataset.drawCalls = String(renderer.info.render.calls);
      host!.dataset.pixelRatio = String(renderer.getPixelRatio());
      host!.dataset.triangles = String(renderer.info.render.triangles);
      host!.dataset.cameraPosition = camera.position.toArray().map((v) => v.toFixed(1)).join(',');
      host!.dataset.centerProjection = new THREE.Vector3().project(camera).toArray().map((v) => v.toFixed(3)).join(',');
      host!.dataset.cameraPlanes = `${camera.near.toFixed(0)},${camera.far.toFixed(0)}`;
    }

    function update(next: SceneProps) {
      const changedSite = siteId !== next.selectedSite.id;
      const changedTerrain = state.terrainEnabled !== next.terrainEnabled;
      state = next;
      terrainGroup.visible = state.terrainEnabled;
      renderer.domElement.setAttribute('aria-label', state.mode === 'globe'
        ? 'Interactive lunar overview. Drag to rotate. Use the named site buttons or site list to select a location.'
        : 'Lunar surface horizon at the selected observer. Drag to look around, or use arrow keys. Sun and Earth focus buttons are available.');
      controls.enabled = state.mode === 'globe';
      if (changedSite) {
        siteId = state.selectedSite.id;
        loadTerrain(state.selectedSite);
        const sample = sampleAt(state.selectedSite, state.timeIndex, state.terrainEnabled);
        yaw = sample.sunAz * DEG;
        pitch = Math.max(3, Math.min(10, sample.sunEl + 4)) * DEG;
        const target = desiredGlobePosition(state.selectedSite);
        if (!globeCamera.position.lengthSq() || reduceMotion) { globeCamera.position.copy(target); globeCamera.lookAt(0, 0, 0); }
        else { cameraTarget = target; controls.enabled = false; }
      }
      if (changedSite || changedTerrain) {
        surfaceScene.remove(horizon);
        disposeObject(horizon);
        horizon = new THREE.Mesh(horizonGeometry(state.selectedSite, state.terrainEnabled), new THREE.MeshBasicMaterial({ color: '#151b23', side: THREE.DoubleSide }));
        surfaceScene.add(horizon);
      }
      if (state.mode !== previousMode) {
        previousMode = state.mode;
        host!.classList.remove('scene-arriving');
        requestAnimationFrame(() => { if (!disposed) host!.classList.add('scene-arriving'); });
      }
      updateSky();
      invalidate();
    }

    function resize() {
      const width = Math.max(host!.clientWidth, 1), height = Math.max(host!.clientHeight, 1);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, width < 700 ? 1.25 : 1.5));
      renderer.setSize(width, height, false);
      globeCamera.aspect = surfaceCamera.aspect = width / height;
      globeCamera.updateProjectionMatrix();
      surfaceCamera.updateProjectionMatrix();
      // Preserve the viewing direction while making room for the globe when
      // the viewport narrows (for example, rotating a phone).
      if (previousAspect && globeCamera.aspect < previousAspect && globeCamera.position.lengthSq()) {
        const minimumDistance = desiredGlobePosition(state.selectedSite).length();
        if (globeCamera.position.length() < minimumDistance) globeCamera.position.setLength(minimumDistance);
        if (cameraTarget && cameraTarget.length() < minimumDistance) cameraTarget.setLength(minimumDistance);
      }
      previousAspect = globeCamera.aspect;
      invalidate();
    }

    function pointerDown(event: PointerEvent) {
      if (state.mode === 'globe') { cameraTarget = null; controls.enabled = true; }
      else { dragging = { x: event.clientX, y: event.clientY }; renderer.domElement.setPointerCapture(event.pointerId); }
      invalidate();
    }
    function pointerMove(event: PointerEvent) {
      if (state.mode === 'surface' && dragging) {
        yaw -= (event.clientX - dragging.x) * 0.004;
        pitch = THREE.MathUtils.clamp(pitch + (event.clientY - dragging.y) * 0.004, -12 * DEG, 70 * DEG);
        dragging = { x: event.clientX, y: event.clientY };
      }
      invalidate();
    }
    function pointerUp() { dragging = null; invalidate(); }
    function keydown(event: KeyboardEvent) {
      if (state.mode !== 'surface') return;
      if (event.key === 'ArrowLeft') yaw -= 5 * DEG;
      else if (event.key === 'ArrowRight') yaw += 5 * DEG;
      else if (event.key === 'ArrowUp') pitch = Math.min(pitch + 3 * DEG, 70 * DEG);
      else if (event.key === 'ArrowDown') pitch = Math.max(pitch - 3 * DEG, -12 * DEG);
      else return;
      event.preventDefault();
      invalidate();
    }
    function lostContext(event: Event) {
      event.preventDefault();
      setError('The browser paused the 3D view. Your mission settings are preserved.');
    }

    controls.addEventListener('change', invalidate);
    controls.addEventListener('start', invalidate);
    renderer.domElement.addEventListener('pointerdown', pointerDown, true);
    renderer.domElement.addEventListener('pointermove', pointerMove);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    renderer.domElement.addEventListener('pointercancel', pointerUp);
    renderer.domElement.addEventListener('keydown', keydown);
    renderer.domElement.addEventListener('webglcontextlost', lostContext);
    document.addEventListener('visibilitychange', invalidate);
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    runtime.current = {
      update,
      focus(body) {
        const sample = sampleAt(state.selectedSite, state.timeIndex, state.terrainEnabled);
        if (body === 'reset') {
          if (state.mode === 'globe') { cameraTarget = desiredGlobePosition(state.selectedSite); controls.enabled = false; }
          else { yaw = sample.sunAz * DEG; pitch = Math.max(3, sample.sunEl + 4) * DEG; }
        } else { yaw = (body === 'sun' ? sample.sunAz : sample.earthAz) * DEG; pitch = 3 * DEG; }
        invalidate();
      },
    };
    resize();
    update(state);

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', invalidate);
      renderer.domElement.removeEventListener('pointerdown', pointerDown, true);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointercancel', pointerUp);
      renderer.domElement.removeEventListener('keydown', keydown);
      renderer.domElement.removeEventListener('webglcontextlost', lostContext);
      controls.dispose();
      if (tiles) tiles.dispose();
      disposeObject(globeScene);
      disposeObject(surfaceScene);
      disposeObject(skyScene);
      textures.forEach((texture) => texture.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      runtime.current = null;
    };
  }, [props.sites, generation]);

  useEffect(() => { runtime.current?.update(props); }, [props]);

  return <div className={`lunar-scene lunar-scene--${props.mode}`}>
    <div className="lunar-scene__canvas" ref={container} data-testid="lunar-canvas" />
    {props.mode === 'globe' && <div className="lunar-scene__pins" aria-label="Sites on the lunar globe">
      {props.sites.map((site, index) => <button key={site.id} ref={(el) => { labels.current[site.id] = el; }} className={`lunar-pin ${site.id === props.selectedSite.id ? 'is-selected' : ''}`} title={site.name} aria-label={`Select ${site.name}`} onClick={() => props.onSelectSite(site.id)}><span>{String(index + 1).padStart(2, '0')}</span></button>)}
    </div>}
    {error ? <div className="scene-fallback" role="status"><p>{error}</p><button type="button" onClick={() => { setError(''); setGeneration((n) => n + 1); }}>Retry 3D view</button></div> : <>
      <div className="scene-instructions"><span className="scene-status-dot" />{props.mode === 'globe' ? 'Drag to orbit · Scroll to explore' : 'Drag to look · Arrow keys also work'}</div>
      {props.mode === 'surface' && <div className="scene-body-controls"><button type="button" onClick={() => runtime.current?.focus('sun')}><Sun size={16} />Look toward Sun</button><button type="button" onClick={() => runtime.current?.focus('earth')}><GlobeHemisphereWest size={16} />Look toward Earth</button></div>}
      <div className="scene-corner-controls"><button type="button" aria-label="Reset camera" title="Reset camera" onClick={() => runtime.current?.focus('reset')}><ArrowCounterClockwise size={18} /></button>{props.onModeChange && <button type="button" aria-label={props.mode === 'globe' ? 'Descend to horizon' : 'Return to lunar overview'} title={props.mode === 'globe' ? 'Descend to horizon' : 'Lunar overview'} onClick={() => props.onModeChange?.(props.mode === 'globe' ? 'surface' : 'globe')}>{props.mode === 'globe' ? <ArrowDown size={18} /> : <ArrowsOut size={18} />}</button>}</div>
      {props.mode === 'surface' && <div className="surface-method">Observer {props.selectedSite.observerHeightM} m above local ground · {loadingTerrain ? 'Loading local terrain…' : 'Local NASA terrain'} · Celestial discs are illustrative</div>}
    </>}
  </div>;
}
