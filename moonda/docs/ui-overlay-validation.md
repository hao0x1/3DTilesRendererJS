# UI overlay validation

Checked on 29 October 2026 for MOONDA 0.3.1.

## Scope

Coincident A/B points now retain separate buttons and true-position leader lines, with a single shared caption. Keyboard focus, pointer hover, a candidate and the active observer determine caption ownership in that order. Captions avoid the measured scene HUD or hide when no safe placement exists. Globe region labels use the same caption system. Mode changes and HUD layout changes clear stale captions before repositioning.

The mission workspace measures its header and wrapping control dock to reserve space for loading, picking and tour cards. Presentation readings have natural height. Narrow desktop windows keep one side panel open, short desktop windows scroll, and tours dismiss when point picking or presentation starts. The reference explorer retains its separate control layout. Calendar portals stay within the viewport and close at their keyboard tab boundaries.

## Browser matrix

Chrome and the existing Codex in-app preview were exercised on the Mac. Dimensions below are CSS pixels. DOM rectangle checks covered the header, control dock, status, candidate card, tour card and shared caption; screenshots were inspected as well.

| Viewport | States checked |
| --- | --- |
| 1680 × 824 | Terrain, inactive A keyboard focus while B remains active, Horizon with both panels |
| 824 × 959 | Existing split-pane preview, Terrain, narrow Horizon, panel resize, all four tour steps |
| 1000 × 600 | Short desktop Horizon, candidate actions, geometry-loading status |
| 390 × 844 | Phone candidate card, tour, ready and pending presentation readings, calendar portal |
| 320 × 720 | Ready phone presentation with wrapped controls and readings |
| 1920 × 1080 | Presentation, guided story and comparison workspace |

Final checks found no overlaps between these UI blocks, no blocks outside the scene and no document-wide horizontal overflow. Scene cards remain scrollable with accessible actions when space is limited. A stale caption during a phone tour transition was found and fixed during this audit.

The calendar's Shift+Tab boundary restored focus to its trigger. Tab from Apply closed the portal and advanced to the next enabled page control. The 390-pixel calendar stayed within all viewport edges.

## Build and regression checks

- 90 Vitest tests passed; focused caption tests and TypeScript checks also passed after the transition fix.
- Production build passed. Offline package: 462 URLs, approximately 614 MB, revision `01baa6d124f5`.
- The existing in-app browser reported that matching build ready, then reloaded and rendered terrain with the production server stopped. The server was restarted afterward.
- NASA rasters, SPICE states, analysis workers and energy/scenario calculation modules are unchanged by this UI follow-up. The production worker filenames remain `scenario.worker-Dfo2p0sX.js` and `analysis.worker-Ch07vOoK.js`.

Earlier science, convergence and offline checks are recorded separately in [scenario-validation.md](./scenario-validation.md).
