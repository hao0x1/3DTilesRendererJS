# Electrical energy estimate

The receiver is the selected solar-panel height above the native DEM point.
The antenna is a separate observer. Earth occultation uses Sun and Earth
directions measured at the panel receiver; antenna geometry is not substituted.

`panelNormalEnu` in `src/energy.ts` provides the same east/north/up unit normal
used by the power calculations. Fixed-panel tilt is the panel plane angle from
horizontal, and azimuth is the normal bearing clockwise from local north.
Ideal two-axis tracking follows the Sun centre without articulation limits.

The model samples a uniform-brightness projected solar disc. Each ray is blocked
by the union of the height-specific terrain horizon and opaque spherical Earth.
The ray contributes `max(0, panelNormal · ray) / (sunCentre · ray)` when clear.
This preserves normal-plane irradiance and allows exposed solar limbs to power
a fixed panel even when the centre-ray incidence is zero. Independent terrain
and eclipse fractions are not multiplied.

Panel electrical power uses the reference irradiance (default 1361 W/m² at
1 AU), actual supplied Sun distance with inverse-square scaling, panel area,
conversion efficiency, derating and the combined ray factor. W integrated over
elapsed hours gives Wh. Generation supplies the constant bus load first.
Surplus charges the battery with charge efficiency and any charge-rate limit;
excess is spilled. Deficits discharge the battery with discharge efficiency
and any discharge-rate limit. Load left after depletion or a discharge-rate
limit is reported as unmet Wh. Reserve is a warning threshold, not a cutoff.

Default power quadrature uses at most **one minute and 512 rays**, while the
prepared component geometry remains on a five-minute axis. Source boundaries
are respected and angles/ranges are interpolated within them. Neither denser
integration nor more rays creates new terrain or ephemeris observations.

`src/energy.integration.test.ts` runs the actual `ScenarioEngine` against the
published native DEM and SPICE files. It covers November 4 and +72-hour arrival,
November 5/6 terrain sunrise, fixed panels, and the March 3 eclipse at a point
whose Sun is clear of terrain. The comparison uses 30-second component geometry
and power integration with 4096 rays; two sensitive cases additionally check
15-second/8192-ray quadrature. Assertions target 1% numerical agreement for
nonzero generated Wh, minimum battery and unmet load; zero results use 0.01 Wh.
These are selected-case comparisons, not a global error bound.

Run the validation and explicitly regenerate its small public report:

```sh
MOONDA_UPDATE_ENERGY_REPORT=1 npm test -- src/energy.integration.test.ts
```

The report is `public/scenarios/energy-convergence.json`. It records inputs,
source manifest hash, old and current settings, results, deltas and reference
checks. Normal test runs do not rewrite it. Timing is an informational Node.js
measurement excluding terrain preparation, not a browser performance promise.

This estimate excludes Earth's atmosphere and oblateness, solar limb darkening,
lander self-shadowing, tracking mechanics, dust, degradation and dynamic thermal
effects. Constant electrical efficiencies and battery capacity are user
assumptions. Passing energy conservation and quadrature comparisons does not
validate these physical assumptions or establish flight suitability. Sun-centre
horizon-clearance percentages/gaps exclude eclipses; electrical generation
includes opaque-Earth solar occultation.
