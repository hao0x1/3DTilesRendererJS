# Interaction stability validation

MOONDA 0.3.2, checked on 29 October 2026.

## Reproduced and fixed

The old caption moved from approximately y=448.84 to y=368.35 when the pointer moved from active A to inactive B without activating B. The projected badges differed vertically by less than 0.1 pixel. Clearance against the other badge rejected one side, and the nearest-position solver picked the opposite side.

Captions now belong to a connected badge cluster, with a below-first slot and deterministic alternatives. The last safe side and offset survive owner changes and small camera changes. Terrain captions reserve the same minimum width. Visible badge hit areas are no longer disabled and restored during each update; layout events reposition the caption synchronously instead of inserting a hidden frame.

Other fixes cover the linked chart timestamp, a stable energy readout, preserved result height during recalculation, month-navigation focus at date limits, and the selected navigation button’s hover styling. Horizon mode keeps its skyline region mounted during updates without drawing old measurements. Short laptop windows reserve enough scene height and scroll when needed.

## Browser walkthrough

Computer use in Chrome and the existing in-app preview covered:

- Six alternating real pointer hovers across A/B: the corrected caption stayed visible at the same x/y and width, below both badges. Keyboard ownership is retained. Regression fixtures cover subpixel changes; independent review exercised 2,400 owner transitions with edge and HUD obstacles.
- A nearby point at approximately −89.44763°, −135.46316° was selected and locked, about 620 m east and 430 m north of the region origin. The exact +72-hour clone retained its point and equipment heights, and the comparison identified arrival as the only changed input.
- That comparison showed approximately 28 kWh generation for A and 2.8 kWh for B. Changing the shared panel area from 2 to 4 m² changed B to approximately 5.6 kWh. These are illustrative model outputs for this test case.
- While scrolled down, an energy edit kept scrollTop at 1262.22 pixels. The pending region retained its approximately 582-pixel height and hid old numbers. New results appeared without clamping the scroll position.
- Moving the shared timeline to its end showed November 6 for A and November 9 for B. The scene and energy chart agreed immediately after switching cases. Free-camera movement left the locked coordinates unchanged.
- Calendar focus remained on an enabled day at January 2026 and January 2028. The antenna horizon view displayed the selected 10 m height.
- At a short desktop viewport, the skyline kept its 153-pixel region and the scene stayed 380 pixels high across pending and ready states.
- Phone-width presentation, all four guided-story steps, large-screen presentation, source-dialog navigation, and opening/returning from the original reference explorer worked. Measured layouts included 351- and 433-pixel phone widths and 1728- and 2133-pixel presentation widths; no tested HUD block overlapped, clipped outside the scene, or caused horizontal document overflow. Temporary viewport overrides were reset.
- The final in-app walkthrough reported no browser console errors.

## Automated and build checks

96 Vitest tests, TypeScript, the production build and whitespace checks passed. NASA data and the scientific calculation modules are unchanged. The scenario and analysis worker bundles remain `scenario.worker-Dfo2p0sX.js` and `analysis.worker-Ch07vOoK.js`.

The production offline package contains 462 URLs, approximately 614 MB, with revision `8ab551e25831`. Earlier science and layout checks remain in [scenario-validation.md](./scenario-validation.md) and [ui-overlay-validation.md](./ui-overlay-validation.md).
