# MOONDA Lunar Observatory

An exploratory lunar south-pole comparison tool with a Moon overview, free terrain exploration, a fixed-observer horizon view, and explained sunlight and Earth-centre visibility estimates. The v2 display uses progressive NASA imagery and regional terrain while retaining the original three-point scientific dataset and calculations. The NASA-AMMOS renderer source is included in this fork.

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

The production build is in `dist/`. It can be served by a static host and uses relative asset URLs. The production service worker downloads the complete build and visual assets, approximately **410 MB**, with progress shown in the footer. **OFFLINE READY** appears only after every file for the matching build revision has been cached. A loaded page or visible terrain alone does not establish offline readiness. The initial cache fill needs access to the host or a running localhost server, browser storage, and time to finish; service workers require HTTPS or localhost. A failed download shows **OFFLINE INCOMPLETE**. Development mode instead shows **LOCAL NASA DATA** and does not install this production cache.

Before an offline demonstration, wait for **OFFLINE READY**, disable the network, reload, and visit all three sites and view modes. Keep the complete checkout and a local server available as a backup; browser caches may be cleared or evicted.

## Explore and compare

- **Explore** provides the Moon overview. Lunar color loads from a 2K fallback to 8K and then 16K when supported by the GPU's maximum texture size. Earth imagery progresses from 2K to 4K and 8K. NASA LOLA global heights provide measured, unexaggerated lunar relief. Texture resolution describes the display asset, not the precision of the visibility calculations.
- **Terrain** allows orbiting, panning, and zooming around the selected region. Each site spans **81.92 km by 81.92 km**, with progressive geometry down to **10 m sampling near the fixed point**. The three sites contain **399 terrain tiles in total**. These use 5 m regional LOLA source elevations where available and native 80 m polar data for surrounding context; the whole displayed region does not have 10 m source resolution.
- **Horizon** keeps the camera at the selected scientific observer, **2 m above local ground**. Dragging or arrow keys change the viewing direction; scrolling changes optical zoom. Moving the free Terrain camera never moves this observer or recalculates an arbitrary location.
- **Inspection light** adds display-only fill so shaded terrain can be inspected. **Sun lighting** uses the selected time's modeled Sun direction. Both are visual controls; numerical visibility comes from the cached angles and horizon profiles, independently of rendered shadows. The generic lander and observer mast are illustrative scale references.
- Mission setup accepts a custom **UTC** start and duration within the cached period, plus maximum darkness and Earth-visibility gap limits. Results include a three-site comparison and a search for a suitable sampled start at the selected site. This is not a launch-delay comparison or an energy model.
- Mission and results panels collapse independently. **Present** hides them for a larger demonstration view; exiting presentation mode or pressing Escape restores their previous state.

## What is reused

- The upstream [NASA-AMMOS 3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) source provides ellipsoid geometry, globe navigation, and loading of the prepared local 3D Tiles terrain.
- [NASA's CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) supplies the December 2025 Moon color imagery and LRO/LOLA global elevation source. Credit NASA's Scientific Visualization Studio and Ernie Wright, with LRO/LROC and LRO/LOLA source data.
- [NASA Blue Marble](https://svs.gsfc.nasa.gov/2915/) supplies the Earth fallback; [Blue Marble Next Generation](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/) supplies the higher-resolution July 2004 Earth display derivatives. See the asset manifest for item-specific NASA Earth Observatory/Goddard and Reto Stöckli credits.
- [NASA/JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) supplies the Sun and Earth's airless apparent azimuth/elevation at the recorded lunar observer coordinates.
- NASA PGDA regional LOLA surface DEMs and the PDS 80 m south-polar DEM supply regional display terrain and the separately prepared scientific horizon inputs. Per-site provenance records resolution, sampling choices, and horizon assumptions.
- IBM Plex Sans and Mono fonts are bundled locally under the SIL Open Font License; their credits and license accompany the files.

The renderer and this application retain the repository's Apache-2.0 license. NASA images and science data have their own attribution and reuse conditions; they are not relabelled as Apache-licensed code. The app does not contain Cesium ion data or an ion API token. No NASA endorsement is implied.

## Scientific method

The source data includes a fixed UTC date range at an hourly cadence. Mission calculations interpolate angles and horizon crossings and weight visibility by elapsed time, rather than counting samples. Longest gaps are clipped to the chosen mission window. The Moon's longitude, reference radius, observer height, time scale, and terrain sampling are recorded with the dataset.

“Find a window at this site” checks complete mission windows at six-hour start intervals. It first favors windows meeting both gap limits, then less exceedance, greater simultaneous visibility, and greater combined Sun/Earth visibility, with earlier starts breaking ties. The interface reports the search cadence and gaps. This is the best result among those sampled starts, not proof of a global optimum.

The included cache covers **November 1–December 1, 2026 UTC** at three sample points. Horizon profiles combine **5 m regional terrain nearby and 80 m terrain farther away**, with 360 bearings and a 200 km range. The larger v2 display terrain does not replace or expand these scientific profiles. The original public science bundle remains about **865 KB**; the visual package is separate and much larger. Raw GeoTIFFs, downloaded imagery originals, and complete source caches remain outside Git and outside the shipped application. [Method and reproduction](scripts/data-method.md) describes the original science bundle, sampling, and checks; `public/data/science-manifest.json` records source and query hashes.

Visibility means the centre of the Sun or Earth is above the selected horizon. The terrain model uses precomputed elevation profiles; the smooth-horizon toggle is an explicit zero-degree baseline. Numerical analysis consumes these profiles and NASA angles, not the 3D renderer's shadows. The view's celestial discs are illustrative and do not model partial-disc visibility.

This prototype estimates visibility for user-specified limits at the three fixed points. It does not calculate arbitrary observer locations or heights, launch-delay scenarios, electrical power, battery sizing, a radio link budget, specific ground-station availability, eclipse losses, landing hazards, or mission safety. The named locations are sample points in documented lunar regions, rather than NASA-approved landing coordinates. Finite terrain resolution, ray spacing, maximum terrain range, reference-frame consistency, and linear interpolation limit precision. Inspect the app's Sources panel and `public/data/observatory.json` before interpreting a result.

## Asset provenance and preparation

- `public/visuals/assets.json` records imagery URLs, credits, source and derivative hashes, dimensions, color spaces, and elevation decoding. `public/visuals/fonts/fonts.json` records the local font sources and license.
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

`npm test` covers duration-weighted mission analysis, physical display relief and geometry, terrain shadow handling, and the generated offline worker's complete-install, failure, update, and offline-fetch behavior. `npm run build` type-checks the app, builds it, and generates the offline package.

The Python checks use an isolated Python 3.12 environment with `scripts/visual-requirements.txt` (which includes the science requirements):

```sh
python scripts/test-data.py
python scripts/prepare-visuals.py --verify-only
python scripts/prepare-visual-terrain.py --verify-only
```

These check coordinate transforms, horizon geometry, ephemeris metadata, asset hashes and dimensions, terrain structure and orientation, bounds, LOD coverage, quantization, and preservation of the original science bundle. Automated checks must be followed by visual browser verification: inspect progressive imagery and all sites, Terrain versus fixed Horizon controls, inspection versus Sun lighting, UTC/duration editing, panel restoration, and a production reload after the complete cache reports ready. Measure sharpness, responsiveness, and compatibility on the demonstration hardware. These checks establish implementation consistency, not flight readiness or independent landing suitability.
