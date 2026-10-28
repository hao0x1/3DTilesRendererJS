# MOONDA scientific demonstration data

The local dataset combines NASA LOLA surface elevations with NASA/JPL Horizons Sun and Earth directions. It estimates geometric visibility at three demonstration sample points. It is not a flight-qualified landing-site assessment.

## Sources and sample-point selection

- [NASA PGDA regional topography](https://pgda.gsfc.nasa.gov/products/78) defines the named Connecting ridge, Shackleton rim, and Peak near Shackleton regions. Cached region bounds come from their GeoTIFF affine metadata.
- [Native 80 m polar DEM](https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/JP2/LDEM_80S_80M.JP2) and its [PDS label](https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/JP2/LDEM_80S_80M_JP2.LBL) provide the large-area terrain. Signed sample values are multiplied by 0.5 to obtain meters above the 1737.4 km reference sphere. The data frame is the mean Earth/polar axis of DE421.
- The full build also uses the regional 5 m surface DEM near each point. The `--coarse-only` build explicitly uses 80 m terrain throughout.
- To keep the points reproducible and stable between resolution upgrades, the generator selects the center of the highest mean 1.6 km bin inside an 8 km square centered in each regional footprint. These coordinates are our demonstration samples, not NASA-approved landing points.

## Coordinates and visibility

South-polar stereographic coordinates use a 1737400 m spherical radius and central meridian zero, with east-positive longitude. The generator converts to spherical longitude/latitude and checks every selected point against its documented regional bounds.

The observer is 2 m above the interpolated surface. Horizons receives the surface elevation plus 2 m as kilometers above the reference sphere. It uses `coord@301`, airless apparent angles, target 10 for the Sun and 399 for Earth, and quantity 4 for azimuth/elevation. The cache spans 2026-11-01 through 2026-12-01 UTC at hourly steps. Queries are sequential, have an application-specific User-Agent, and are cached by their exact URL. The browser makes no runtime NASA API request.

The horizon is computed at 360 bearings, with great-circle terrain samples out to 200 km. Sample spacing is 10 m nearby, 20 m through 8 km, 100 m through 30 km, and 500 m farther away. At each sample, the generator compares target radius and observer radius in the observer's spherical tangent frame, including lunar curvature. The highest elevation angle on each bearing is the horizon value.

Visibility means that the center of the selected body lies above the sampled terrain horizon. It does not model partial-disc visibility, solar-panel orientation, battery capacity, ground-station location, antenna pointing, or link budget. Hourly temporal sampling limits crossing-time accuracy. Narrow ridges between bearing/range samples may be missed. The [Horizons manual](https://ssd.jpl.nasa.gov/horizons/manual.html#user-defined-topocentric-site-coordinates) specifies mean Earth of DE421 coordinates for lunar observing sites, consistent with these DEM products. An independent alignment check and propagation of elevation uncertainties remain future validation work.

## Display mesh

`heightsM` contains absolute radial surface elevation relative to the 1737400 m sphere. The 65 by 65 display grid spans 8 km; rows run north to south and columns west to east. Grid coordinates are local east/north arc offsets. The GLB projects these samples into a local tangent frame with x east, y up, and z south. Its up coordinate includes spherical curvature and has no vertical exaggeration. The mesh's horizontal sampling is 125 m, so it is a resampled overview of the source data. Numerical horizons use the larger 200 km terrain extent independently of the displayed mesh.

The model is packaged as a local Y-up GLB and minimal 3D Tiles 1.1 tileset for NASA-AMMOS TilesRenderer. Tileset bounding volumes use standard x-east/y-north/z-up tile coordinates, matching the renderer's glTF Y-to-Z-up conversion. The application rotates the tiles group by minus 90 degrees about X to return it to its local Y-up scene. Globe textures serve visual orientation and do not determine scientific results.

## Reproduction and checks

Use an isolated Python environment with the pinned `data-requirements.txt` and a command-line `curl` executable. The validated build used Python 3.12, NumPy 2.3.5, Rasterio 1.5.2, and its GDAL 3.12.2. Run `generate-data.py --cache-dir <local-cache> --coarse-only` for a fast 80 m build or omit `--coarse-only` for the regional 5 m upgrade. `--prefetch-regions` optionally downloads the three independent terrain files concurrently; Horizons requests always remain sequential. Raw sources and complete NASA responses stay in the external cache, outside public application assets. Then run `test-data.py`. The public `science-manifest.json` records source-file hashes, exact Horizons request URLs, API signatures, result hashes, generator hash, and final dataset hash.

Checks cover projection round trips, bearing orientation, analytic horizon dip on a smooth sphere, raised-terrain occlusion, pixel-center interpolation, sample-point containment, finite terrain values, complete matching hourly ephemerides, and GLB/tileset structure. They validate implementation consistency, not independent mission suitability.
