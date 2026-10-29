# Scenario-stage validation

Validated locally on 29 October 2026. App version: 0.3.0.

## Automated checks

- 87 Vitest tests passed, including native raster integrity, independent horizon fixtures, SPICE geometry, cancellation, finite-disc illumination, battery conservation and chart interval boundaries.
- The original ten Python science tests passed.
- Visual asset checks passed for all 25 published entries, and terrain checks passed for 399 GLB tiles, shared edges, geometry and original data hashes.
- The scenario terrain verifier passed for four rasters, seven chunks, 12 reference points and 24 horizon profiles. Original reference data remained unchanged.
- The ephemeris verifier passed for all 17,521 hourly states in the 2026–2028 cache.
- The production TypeScript/Vite build and whitespace checks passed. The offline package contains 462 URLs and approximately 614 MB of local assets and data.

The nine-case energy refinement report and its finer-reference checks are in `public/scenarios/energy-convergence.json`; methodology is in `scripts/energy-method.md`. These measure selected-case numerical convergence, not physical accuracy.

## Browser checks

Chrome on the Mac was tested at its native 1680 × 824 CSS viewport, plus 1920 × 1080 and 390 × 844 CSS layouts. Neither responsive layout introduced document-wide horizontal overflow. The in-app browser was also tested.

A native terrain pick at latitude −89.4639120013802°, longitude −134.90480454600856° was locked, then copied from A to B with an exact three-day arrival delay. Both cases retained the point, 2 m panel and 10 m antenna heights. With the shared 4 m² tracking panel used in this test, A reported approximately 56 kWh generation and B reported zero. Both still failed the Earth-gap requirement. These are illustrative scenario outputs, not a recommendation for a flight landing site.

The comparison identified changed equipment heights before the clone and correctly reported arrival as the only changed input after it. Pending calculations hid previous results. Moving the shared time slider to the end changed the displayed UTC dates from November 4/7 to November 6/9 while preserving their 72-hour difference.

Switching the surface view from the 2 m panel to the 10 m antenna moved the camera from `(0, 2, 0)` to `(0, 10, 0)` in the local frame. A separate free-camera drag changed camera position while leaving the locked scientific observer unchanged. Editing panel area updated energy results without moving that point.

## Offline and regression checks

After both browsers reported the complete package ready, the localhost production server was stopped. Both browsers reloaded successfully. The in-app browser recomputed the default scenario, including 856.6 Wh generation with its default equipment. Chrome selected Shackleton rim, whose native scenario raster had not previously been loaded by its analysis worker, and calculated a complete energy result from the cached package.

The original explorer's lazy-loaded module also opened with the server stopped. Returning to the new workspace preserved the active Shackleton scenario. The server was then restarted for continued local use.

The final display-only label-spacing and source-copy edits preserve the scientific dataset identity and worker bundles. Final offline-cache revision: `1c10dec64bb4`.
