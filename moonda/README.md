# MOONDA Lunar Observatory

An exploratory lunar south-pole comparison tool with a guided mission setup, a Moon overview, a surface horizon view, and explained sunlight and Earth-centre visibility estimates. It uses cached NASA/JPL ephemerides and NASA lunar terrain, with the NASA-AMMOS renderer source in this fork.

## Run locally

Use a current Node.js release supported by Vite 8 (Node 20.19+, 22.12+, or newer supported releases).

```sh
cd moonda
npm ci
npm run dev
```

Open the localhost URL printed by Vite. Internet is needed for the initial dependency installation. The app's textures, ephemerides, terrain meshes, and horizon profiles are local files; using it through the local server does not require a NASA or Cesium connection.

After installing Node, you can also double-click `start-local.command` on macOS or `start-local.cmd` on Windows. These build the current source and serve it at `http://127.0.0.1:5183/`. Keep that terminal open during the demonstration.

```sh
npm test
npm run build
npm run preview
```

The production build is in `dist/`. It can be served by a static host and uses relative asset URLs. Its service worker caches the complete demonstration after the first successful load, allowing subsequent offline use in compatible browsers. Keep a local server available as the dependable event backup.

## What is reused

- The upstream [NASA-AMMOS 3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) source provides ellipsoid geometry, globe navigation, and loading of the prepared local 3D Tiles terrain.
- [NASA's CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) supplies the December 2025 Moon color texture. Credit NASA's Scientific Visualization Studio and Ernie Wright (USRA), with LRO/LROC source data.
- [NASA Blue Marble](https://svs.gsfc.nasa.gov/2915/) supplies the Earth texture. Credit NASA Goddard, Reto Stockli, Robert Simmon, and the MODIS Science Team.
- [NASA/JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) supplies the Sun and Earth's airless apparent azimuth/elevation at the recorded lunar observer coordinates.
- The data's per-site provenance identifies NASA LOLA elevation products, resolution, local sampling choices, and horizon assumptions.

The renderer and this application retain the repository's Apache-2.0 license. NASA images and science data have their own attribution and reuse conditions; they are not relabelled as Apache-licensed code. The app does not contain Cesium ion data or an ion API token. No NASA endorsement is implied.

## Scientific method

The source data includes a fixed UTC date range at an hourly cadence. Mission calculations interpolate angles and horizon crossings and weight visibility by elapsed time, rather than counting samples. Longest gaps are clipped to the chosen mission window. The Moon's longitude, reference radius, observer height, time scale, and terrain sampling are recorded with the dataset.

“Find a window at this site” checks complete mission windows at six-hour start intervals. It first favors windows meeting both gap limits, then less exceedance, greater simultaneous visibility, and greater combined Sun/Earth visibility, with earlier starts breaking ties. The interface reports the search cadence and gaps. This is the best result among those sampled starts, not proof of a global optimum.

The included cache covers **November 1–December 1, 2026 UTC** at three sample points. Horizon profiles combine **5 m regional terrain nearby and 80 m terrain farther away**, with 360 bearings and a 200 km range. The 8 km display meshes are resampled to a 125 m grid; their appearance is separate from the finer numerical analysis. The complete public science bundle is about **865 KB**, while the roughly 153 MB original source files remain outside the app. [Method and reproduction](scripts/data-method.md) describes the sampling and checks; `public/data/science-manifest.json` records source and query hashes.

Visibility means the centre of the Sun or Earth is above the selected horizon. The terrain model uses precomputed elevation profiles; the smooth-horizon toggle is an explicit zero-degree baseline. Numerical analysis consumes these profiles and NASA angles, not the 3D renderer's shadows. The view's celestial discs are illustrative and do not model partial-disc visibility.

This prototype estimates visibility for user-specified limits. It does not calculate electrical power, battery sizing, a radio link budget, specific ground-station availability, eclipse losses, landing hazards, or mission safety. The named locations are sample points in documented lunar regions, rather than NASA-approved landing coordinates. Finite terrain resolution, ray spacing, maximum terrain range, reference-frame consistency, and linear interpolation limit precision. Inspect the app's Sources panel and `public/data/observatory.json` before interpreting a result.

## Performance approach

- Local, modestly sized imagery and prepared terrain; no runtime service credentials or terrain streaming from a remote provider.
- On-demand rendering, bounded display pixel ratio, and reused geometry/materials.
- A separate small Vite build, avoiding the upstream build of every engine and example.
- Scientific data and analysis independent of the visual renderer, with usable comparison charts when WebGL is unavailable.
- Reduced-motion support, keyboard controls, and compact layouts for small screens.

Hardware performance and browser compatibility must be measured. The repository does not promise a fixed frame rate across devices.

## Checks

`npm test` exercises the duration-weighted mission analysis. The independent data checks require Python 3.12 with the packages in `scripts/data-requirements.txt`; run `python scripts/test-data.py` after installing them in an isolated environment. They check coordinate transforms, horizon geometry, local mesh orientation, ephemeris metadata, and packaged hashes. Neither suite establishes flight readiness or independently validates landing suitability.
