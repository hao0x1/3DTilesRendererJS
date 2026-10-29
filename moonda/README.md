# MOONDA Lunar Observatory

An exploratory lunar south-pole comparison tool built with the NASA-AMMOS renderer, NASA elevation data and SPICE Sun/Earth geometry. Version 0.3.1 compares two mission scenarios at selectable nearby points, with independent panel and antenna heights and an assumption-based solar/battery estimate. The Moon overview and regional terrain remain available, as does the original three-point reference explorer with its unchanged scientific dataset.

## Run locally

Use a current Node.js release supported by Vite 8 (Node 20.19+, 22.12+, or newer supported releases).

```sh
cd moonda
npm ci
npm run dev
```

Open the localhost URL printed by Vite. Internet is needed to download the repository/assets and install dependencies initially. The app's imagery, fonts, ephemerides, terrain tiles, and horizon profiles are local files; using the complete checkout through the local server does not require a NASA or Cesium connection. Use an HTTP server, rather than opening `index.html` as a file.

After installing Node, you can also double-click `start-local.command` on macOS or `start-local.cmd` on Windows. These build the current source and serve it at `http://127.0.0.1:5183/`. Keep that terminal open during the demonstration.

```sh
npm test
npm run build
npm run preview
```

The production build is in `dist/`. It can be served by a static host and uses relative asset URLs. The production service worker downloads the complete build, including the native scenario DEMs and visual assets, approximately **600 MB**, with progress shown in the footer. **OFFLINE READY** appears only after every file for the matching build revision has been cached. A loaded page or visible terrain alone does not establish offline readiness. The initial cache fill needs access to the host or a running localhost server, browser storage, and time to finish; service workers require HTTPS or localhost. A failed download shows **OFFLINE INCOMPLETE**. Development mode instead shows **LOCAL NASA DATA** and does not install this production cache.

Before an offline demonstration, wait for **OFFLINE READY**, disable the network, reload, and visit all three regions and view modes. Change a scenario point and receiver heights, run the A/B comparison, and open the reference explorer. Keep the complete checkout and a local server available as a backup; browser caches may be cleared or evicted.

## Compare mission scenarios

- Scenarios **A** and **B** each lock a region, east/north point, arrival UTC, panel height and antenna height. Select a point from the terrain or edit its offsets within a **5.12 km by 5.12 km** supported square around each of the three reference origins (east and north offsets of ±2560 m). A mesh pick supplies coordinates; the scientific ground elevation is re-sampled from the native DEM. Free camera movement leaves the locked point unchanged.
- Set panel and antenna heights independently from **0 to 100 m above sampled ground**. Each receiver gets its own terrain horizon and topocentric Sun/Earth geometry. Surface view can use either receiver viewpoint.
- Choose a mission wholly within **January 1, 2026 through January 1, 2028 UTC**. The mission duration, maximum terrain-obstruction gap and maximum Earth-visibility gap are shared by A and B. **Copy A, arrive 72 hours later** copies the point and heights and shifts only arrival UTC; it is unavailable when the delayed mission would exceed the prepared period. This compares arrival scenarios, not a launch-trajectory calculation.
- The comparison reports Sun-centre terrain clearance at the panel, Earth-centre terrain clearance at the antenna, their overlap, longest gaps, and differences in generated energy, minimum battery charge and unmet load. Earth-centre visibility is not a radio link budget or ground-station availability prediction. Sun-centre clearance and gap constraints exclude eclipses; the separate electrical generation estimate includes Earth occultation of the Sun.
- A and B share editable panel, battery and constant-load assumptions. The initial example uses a 2 m² ideal Sun-tracking panel, 28% conversion efficiency, 0.75 derating, a 2000 Wh battery initially at 1600 Wh, a 400 Wh warning reserve, 95% charge/discharge efficiencies and an 80 W load. These are demonstration inputs, not a validated lander design. Fixed panels use tilt from horizontal and the panel-normal azimuth clockwise from local north.
- Mission and results panels collapse independently. **Present** hides them for a larger demonstration view; exiting presentation mode or pressing Escape restores their previous state. **Data & assumptions** explains the active scenario and opens the original reference explorer.

## Explore the scene

- **Explore** provides the Moon overview. Lunar color loads from a 2K fallback to 8K and then 16K when supported by the GPU's maximum texture size. Earth imagery progresses from 2K to 4K and 8K. NASA LOLA global heights provide measured, unexaggerated lunar relief. Texture resolution describes the display asset, not the precision of the visibility calculations.
- **Terrain** allows orbiting, panning, and zooming around the selected region. Each site spans **81.92 km by 81.92 km**, with progressive geometry down to **10 m sampling near the fixed point**. The three sites contain **399 terrain tiles in total**. These use 5 m regional LOLA source elevations where available and native 80 m polar data for surrounding context; the whole displayed region does not have 10 m source resolution.
- **Surface** in mission scenarios keeps the camera at the locked panel or antenna receiver. The reference explorer's **Horizon** mode keeps its original fixed observer **2 m above local ground**. Dragging or arrow keys change the viewing direction; scrolling changes optical zoom. Moving the free Terrain camera never moves a scientific observer.
- **Inspection light** adds display-only fill so shaded terrain can be inspected. **Sun lighting** uses the selected time's modeled Sun direction. Both are visual controls; numerical visibility comes from the cached angles and horizon profiles, independently of rendered shadows. The generic lander and observer mast are illustrative scale references.
- Scene imagery, estimated render shadows and illustrative lander geometry provide context. Scientific visibility and power calculations consume independently prepared terrain horizons and celestial geometry.

## What is reused

- The upstream [NASA-AMMOS 3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) source provides ellipsoid geometry, globe navigation, and loading of the prepared local 3D Tiles terrain.
- [NASA's CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) supplies the December 2025 Moon color imagery and LRO/LOLA global elevation source. Credit NASA's Scientific Visualization Studio and Ernie Wright, with LRO/LROC and LRO/LOLA source data.
- [NASA Blue Marble](https://svs.gsfc.nasa.gov/2915/) supplies the Earth fallback; [Blue Marble Next Generation](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/) supplies the higher-resolution July 2004 Earth display derivatives. See the asset manifest for item-specific NASA Earth Observatory/Goddard and Reto Stöckli credits.
- [NASA/JPL NAIF SPICE](https://naif.jpl.nasa.gov/naif/) supplies the new scenario Sun/Earth state cache in `MOON_ME_DE421`. Kernel URLs, hashes, UTC/ET conventions and validation are recorded in the scenario ephemeris manifest. [NASA/JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) supplies the original reference observers' airless apparent azimuth/elevation arrays, retained for regression and an independent comparison.
- NASA PGDA regional LOLA surface DEMs and the PDS 80 m south-polar DEM supply regional display terrain and the separately prepared scientific horizon inputs. Per-site provenance records resolution, sampling choices, and horizon assumptions.
- IBM Plex Sans and Mono fonts are bundled locally under the SIL Open Font License; their credits and license accompany the files.

The renderer and this application retain the repository's Apache-2.0 license. NASA images and science data have their own attribution and reuse conditions; they are not relabelled as Apache-licensed code. The app does not contain Cesium ion data or an ion API token. No NASA endorsement is implied.

## Scenario scientific method

The new `public/scenarios/` package is separate from the original `public/data/` bundle. Native **5 m regional LOLA** and **80 m polar** source rasters provide ground elevations and terrain along horizon rays. The scientific raster values retain their source precision; bilinear interpolation does not create new measurements. Heights are radial above a **1,737,400 m** reference sphere in the **MOON_ME_DE421** frame. Horizons include lunar curvature, use 0.25° bearings to 200 km and are recalculated separately for the panel and antenna height. The much larger 81.92 km display regions do not expand the selectable scientific squares.

The state cache covers 2026-01-01 through 2028-01-01 UTC, inclusive, at hourly intervals. It stores Sun/Earth positions and rotating-frame derivatives plus exact ET and UTC axes. Cubic Hermite interpolation and translation to the requested surface receiver produce component geometry on a five-minute axis. Validation compares this apparent-vector approximation with exact SPICE surface-observer queries; the measured differences are sample results, not universal accuracy guarantees. The pinned leap-second kernel cannot anticipate future announcements. See [scenario data method and reproduction](scripts/scenario-data-method.md) for frame, sampling, coverage and validation details.

Electrical generation samples a uniform-brightness **finite solar disc** with **512 deterministic rays** and midpoint integration steps of at most **one minute** by default. A ray must clear both the panel-height terrain horizon and opaque spherical Earth, so partial terrain obstruction and eclipses are combined per ray, rather than multiplying separate visible fractions. Actual Sun distance supplies inverse-square irradiance scaling; panel orientation, area, conversion efficiency and derating determine electrical power. The model supplies the constant load first, then charges or discharges the battery with the chosen efficiencies, capacity and optional power limits. It reports spilled energy, minimum charge and unmet load; reserve is a warning threshold, not a discharge cutoff. See [energy method](scripts/energy-method.md).

Selected-case refinement tests compare these defaults with 30-second component geometry/integration and 4096 rays, with 15-second/8192-ray checks for two sensitive cases. The public `energy-convergence.json` records results and settings. Terrain checks likewise compare refined ray sampling. **Convergence checks establish numerical consistency, not source-data accuracy**: denser time steps or rays cannot improve the underlying DEM or ephemeris observations. Five-metre pixel spacing does not imply five-metre height or position accuracy.

Source uncertainty, pixel interpolation, regional/polar joins, finite terrain range, and skyline sampling limit the results. The energy model excludes Earth's atmosphere and oblateness, solar limb darkening, lander self-shadowing, tracking mechanics, dust, ageing and dynamic thermal effects. Battery capacity, electrical efficiencies and load remain user assumptions. The application does not assess landing hazards, mission safety, detailed electrical design or operational communications. Named regions and selected points are not NASA-approved landing coordinates. Use the estimates to explore assumptions, not to qualify hardware or a landing site.

## Original reference explorer

Open **Data & assumptions**, then **Open the original three-point reference explorer** to return to the preserved demonstration. Its calculations and controls retain the following scope.

The original source data includes a fixed UTC date range at an hourly cadence. Mission calculations interpolate angles and horizon crossings and weight visibility by elapsed time, rather than counting samples. Longest gaps are clipped to the chosen mission window. Its three observers remain fixed at 2 m above local ground; moving the camera does not alter them. Mission setup accepts a UTC start, duration and gap limits, with a three-site comparison and a sampled search at the selected site.

“Find a window at this site” checks complete mission windows at six-hour start intervals. It first favors windows meeting both gap limits, then less exceedance, greater simultaneous visibility, and greater combined Sun/Earth visibility, with earlier starts breaking ties. The interface reports the search cadence and gaps. This is the best result among those sampled starts, not proof of a global optimum.

The original cache covers **November 1–December 1, 2026 UTC** at three sample points. Horizon profiles combine **5 m regional terrain nearby and 80 m terrain farther away**, with 360 bearings and a 200 km range. Neither the larger v2 display terrain nor the new scenario package replaces these reference profiles. The pinned original science bundle remains about **865 KB**. [Original method and reproduction](scripts/data-method.md) describes its sampling and checks; `public/data/science-manifest.json` records source and query hashes.

In this explorer, visibility means the centre of the Sun or Earth is above the selected horizon. It uses the original precomputed profiles; the smooth-horizon toggle is an explicit zero-degree baseline. Numerical analysis consumes those profiles and NASA angles, not the 3D renderer's shadows. Its celestial discs are illustrative and do not model partial-disc visibility.

The reference explorer does not calculate nearby observer locations or heights, arrival-delay scenarios, electrical power or eclipse losses. Those are separate features of the new scenario workspace with its own inputs and assumptions. Neither model establishes a radio link budget, ground-station availability, landing suitability or mission safety. Inspect the relevant Sources panel and manifest before interpreting a result.

## Asset provenance and preparation

- `public/visuals/assets.json` records imagery URLs, credits, source and derivative hashes, dimensions, color spaces, and elevation decoding. `public/visuals/fonts/fonts.json` records the local font sources and license.
- `public/scenarios/manifest.json` pins native terrain values, transforms, frame, supported point bounds, source hashes and baseline regression hashes. `public/scenarios/ephemeris/manifest.json` pins the SPICE kernels, state cache, UTC/ET conventions and validation fixtures. The native scenario DEM derivatives are shipped; raw GeoTIFF/JP2 originals, downloaded imagery originals and source kernels remain in the external SSD caches.
- `public/visuals/terrain.json` records per-site bounds, source DEMs, tile levels, hashes, and hashes pinning the unchanged science bundle. Float32 positions use a common site origin to avoid camera-dependent cracks along shared edges. `public/visuals/terrain/verification.json` records geometry checks. The adjacent `horizon-comparison.json` is a source-width comparison report; its alternative profiles are not substituted into the app's numerical analysis.
- `scripts/prepare-visuals.py` prepares imagery, relief, normal-map derivatives, and fonts, retaining source originals in the workspace's external `assets/reference/v2` cache. `scripts/prepare-visual-terrain.py` builds the optional terrain from cached DEMs in `research/terrain-build/raw`; it does not download them or modify `public/data`.
- `scripts/build-offline.mjs` runs after Vite during `npm run build`. It inventories the actual build, embeds its revision, and generates the complete offline-cache worker.

From `moonda/`, use an isolated Python 3.12 environment with `scripts/visual-requirements.txt` for the preparation and verification scripts. Rebuilding visual terrain requires the original cached DEMs; verification of the shipped package does not require downloading those originals.

## Performance approach

- Local progressive imagery and terrain detail; no runtime service credentials or terrain streaming from a remote provider. The full offline package is large even though the initial view starts with lighter assets.
- On-demand rendering and reused geometry/materials. Rendering uses the native device pixel ratio subject to GPU dimension limits, without an arbitrary low Retina cap; texture upgrades respect the GPU's maximum texture size.
- A separate small Vite build, avoiding the upstream build of every engine and example.
- Scientific data and analysis independent of the visual renderer, with usable comparison charts when WebGL is unavailable.
- Reduced-motion support, keyboard controls, and compact layouts for small screens.

Hardware performance and browser compatibility must be measured. The repository does not promise a fixed frame rate across devices.

## Checks

`npm test` covers duration-weighted reference analysis, nearby-point/height-specific scenario geometry against published fixtures, A/B timing, finite-disc power and battery bookkeeping, selected-case energy convergence, physical display relief and geometry, terrain shadow handling, and the generated offline worker's complete-install, failure, update, and offline-fetch behavior. `npm run build` type-checks the app, builds it, and generates the offline package. Normal test runs do not rewrite the energy convergence report; its explicit regeneration command is documented in the energy method.

The Python checks use an isolated Python 3.12 environment with `scripts/visual-requirements.txt` (which includes the science requirements):

```sh
python scripts/test-data.py
python scripts/prepare-visuals.py --verify-only
python scripts/prepare-visual-terrain.py --verify-only
python scripts/prepare-scenario-terrain.py --verify-only
python -I -S scripts/prepare-scenario-ephemeris.py --verify-only
```

These check coordinate transforms, horizon geometry, ephemeris metadata and state units, asset hashes and dimensions, terrain structure and orientation, supported point/ray coverage, LOD coverage, quantization, and preservation of the original science bundle. Scenario terrain verification uses the existing NumPy/Rasterio environment and no raw downloads; ephemeris verification uses only the Python standard library and published files, without SPICE kernels or the generation-only requirements.

Automated checks must be followed by visual browser verification: inspect progressive imagery and all regions, lock nearby points, vary the two receiver heights independently, compare A with a +72-hour B, change energy assumptions, restore collapsed panels, revisit the original reference explorer, and reload in production after the complete cache reports ready. Measure sharpness, responsiveness, and compatibility on the demonstration hardware. These checks establish implementation consistency, not flight readiness or independent landing suitability.

The 0.3.1 UI follow-up separates coincident point labels and reserves space for scene controls, tours and presentation readings. See [UI overlay validation](./docs/ui-overlay-validation.md) for the browser checks.
