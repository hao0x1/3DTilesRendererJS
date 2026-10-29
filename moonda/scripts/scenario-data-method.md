# Nearby-point scenario data

The `public/scenarios/` package is independent of the original three fixed-site
demonstration. The original `public/data/` files are preserved and pinned for
regression. These data support a sampled educational planning model, not a
flight-qualified landing-site, radio-link, or power assessment.

## Terrain

The three original [NASA PGDA LOLA 5 m regional surface DEMs](https://pgda.gsfc.nasa.gov/products/78)
are stored without numeric alteration as little-endian float32 arrays. A shared
[NASA PDS 80 m polar DEM](https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/JP2/LDEM_80S_80M.JP2)
retains signed int16 samples, multiplied by 0.5 to obtain elevation metres.
The [PDS label](https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/JP2/LDEM_80S_80M_JP2.LBL)
specifies east-positive planetocentric longitude/latitude, south-polar spherical
stereographic coordinates, and mean Earth/polar axis of DE421. Elevations are
relative to a 1737400 m sphere. Its radial offset is not an additional offset
to add to the elevation array.

The manifest records affine pixel-corner transforms; interpolation uses pixel
centres. Four gzip row stripes hold the far field and one gzip file holds each
regional raster. Each file is below 100 MB. Compressed and uncompressed hashes
are pinned. The seven compressed files total 202534052 bytes and expand to
238400000 bytes.

Selectable points lie within an azimuthal-equidistant square, east/north arc
offsets ±2560 m from each existing demonstration origin. Ground height must be
sampled from the scientific raster at the requested coordinates. A rendered
mesh hit supplies coordinates, not authoritative ground elevation. Supported
corners and edge midpoints have native 5 m coverage. Every supported point's
200 km rays stay inside the far field's conservative 303900 m projected-radius
validity boundary.

Panel and antenna observers may be 0–100 m above sampled ground. A spherical
line-of-sight calculation includes curvature and independently recomputes the
horizon for each component height. The default profile samples 0.25° bearings
and ranges at these intervals:

| Range | Step |
| --- | --- |
| 0.25–100 m | 0.25 m |
| 100–500 m | 1 m |
| 500–1000 m | 2.5 m |
| 1–24 km | 5 m |
| 24–200 km | 80 m |

The fine first interval resolves extrema in the DEM's interpolated surface;
it does not create subpixel measurements. The initial coarser near-field grid
missed a rim extremum by 0.133°. After refinement, selected default-point
half-range tests differ by at most 0.0159° (95th percentile at most 0.00332°).
Half-bearing tests at 0.125° differ by at most 0.0312° (95th percentile at most
0.00491°). These are measured convergence examples, not guaranteed error bounds
at all selectable points. Source elevation uncertainty, interpolated pixels,
regional/polar joins, finite bearings/ranges, and excluded terrain beyond
200 km remain limitations. Pixel spacing is not elevation accuracy.

`terrain/reference-fixtures.json` supplies 12 point cases and 24 complete
height-specific profiles for independent runtime checks. `datasetId` fingerprints
the frame, radius, raw raster hashes, transforms, scales, and sampling. Horizon
caches must also include coordinates and component height.

## Sun and Earth geometry

The ephemeris generator uses NASA/JPL NAIF kernels `de421.bsp`,
`moon_pa_de421_1900-2050.bpc`, `moon_080317.tf`, and `naif0012.tls` with their
source URLs and hashes recorded in the ephemeris manifest. The explicit frame
is `MOON_ME_DE421`; a different lunar principal-axis or IAU frame is not a
drop-in replacement for these DEM coordinates.

The cache contains 17521 hourly rows from 2026-01-01 through 2028-01-01 UTC,
inclusive. Each little-endian float64 row has 13 values: exact ET seconds past
J2000 TDB, Sun position XYZ and velocity XYZ, then Earth position XYZ and
velocity XYZ. Positions are metres and derivatives metres per ET second.
Corresponding UTC epochs are supplied explicitly. UI UTC must be bracketed on
that axis, then mapped to the stored ET interval; Unix time is not ET. The
pinned leap-second kernel cannot anticipate future leap-second announcements.

States come from SPICE `spkezr` with `CN+S`, observer `MOON`, in the rotating
Moon frame. Cubic Hermite interpolation uses the matching rotating-frame
derivatives and ET interval. The actual fixed observer position, including
sampled ground and component height, is subtracted to obtain a topocentric
vector. This apparent-vector translation is a measured approximation to exact
SPICE [`spkcpo`](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spkcpo_c.html).
It is not a reuse of the original three observers' azimuth/elevation arrays.

At 269 withheld epochs including March 3, 2026 eclipse phases, validation
compared 80700 actual observers per body against exact `spkcpo`. Sampled maximum
direction differences were 0.00008374 arcsec for the Sun and 0.0961814 arcsec for
Earth; range differences were 10.426 m and 9.322 m. These tested maxima are not
universal physical error bounds. Interpolation error is smaller than the
observer-dependent apparent-vector approximation. A separate comparison against
cached Horizons DE441 results distinguishes kernel differences from this
approximation.

Twenty-one public golden fixtures include exact observer geometry and eclipse
phases. Real topocentric ranges support Sun distance in AU and angular radii.
An energy model using spherical Earth occultation must state that approximation
and exclude unsupported atmosphere, thermal, electrical, and link-budget claims.

## Reproduction

Use the existing pinned terrain Python requirements and the separate pinned
SPICE generation requirements. Keep source caches and kernels on the SSD.

```sh
python scripts/prepare-scenario-terrain.py --cache-dir ../../research/terrain-build/raw
python scripts/prepare-scenario-ephemeris.py
python scripts/prepare-scenario-terrain.py --verify-only
python -I -S scripts/prepare-scenario-ephemeris.py --verify-only
```

The ephemeris verification needs only the Python standard library and published
files. Terrain verification requires the existing NumPy/Rasterio environment,
but no raw NASA source or network access. Both verify hashes, schemas and
baseline preservation; independent TypeScript runtime tests should consume the
published golden fixtures as a separate cross-check.
