#!/usr/bin/env python3
"""Prepare exact NASA DEM rasters for independent nearby-point scenarios.

Uses existing cached original GeoTIFF/JP2 files. Only public/scenarios/terrain/
and public/scenarios/manifest.json are written. No baseline data is changed.
  python scripts/prepare-scenario-terrain.py --cache-dir ../../research/terrain-build/raw
  python scripts/prepare-scenario-terrain.py --verify-only
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
import rasterio

APP = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("scenario_science_baseline", APP / "scripts/generate-data.py")
SCIENCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCIENCE)
R = SCIENCE.RADIUS_M
ROOT = APP / "public/scenarios"
REGIONS = {ident: region for ident, _, region in SCIENCE.SITE_REGIONS}
RANGES = np.unique(np.r_[np.arange(.25, 100, .25), np.arange(100, 500, 1),
                         np.arange(500, 1000, 2.5), np.arange(1000, 24000, 5),
                         np.arange(24000, 200001, 80)])
SAMPLING = {"azimuthStepDeg": .25, "maxRangeM": 200000,
    "radialIntervals": [{"fromM": .25, "toExclusiveM": 100, "stepM": .25},
                        {"fromM": 100, "toExclusiveM": 500, "stepM": 1},
                        {"fromM": 500, "toExclusiveM": 1000, "stepM": 2.5},
                        {"fromM": 1000, "toExclusiveM": 24000, "stepM": 5},
                        {"fromM": 24000, "toInclusiveM": 200000, "stepM": 80}],
    "rangeSampleCount": len(RANGES), "curvatureModel": "sphere", "nearSourceResolutionM": 5,
    "farSourceResolutionM": 80, "observerHeightRangeM": {"min": 0, "max": 100}}


def encode_json(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    SCIENCE.atomic_write(path, encode_json(value))


def baseline_pins():
    return {str(p.relative_to(APP)): SCIENCE.file_hash(p) for p in sorted((APP / "public/data").rglob("*")) if p.is_file()}


def pin_dataset_identity(manifest):
    rasters = [manifest["farField"]] + [r["nearRaster"] for r in manifest["regions"].values()]
    identity = {"frame": manifest["frame"], "referenceRadiusM": manifest["referenceRadiusM"],
                "horizonSampling": manifest["horizonSampling"],
                "rasters": [{"dtype": r["dtype"], "affine": r["affine"], "scale": r["scale"],
                             "rawHashes": [c["uncompressedSha256"] for c in r["chunks"]]} for r in rasters]}
    manifest["datasetId"] = "moonda-scenarios-" + hashlib.sha256(encode_json(identity)).hexdigest()[:20]


def read_raster(path):
    with rasterio.open(path) as source:
        return source.read(1), source.transform


def write_raster(array, affine, name, dtype, scale, rows_per_chunk):
    a = array.astype(dtype)
    files = []
    for start in range(0, len(a), rows_per_chunk):
        rows = a[start:start + rows_per_chunk]
        raw = rows.tobytes()
        compressed = gzip.compress(raw, compresslevel=6, mtime=0)
        path = ROOT / "terrain" / f"{name}-{start:04d}.bin.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        SCIENCE.atomic_write(path, compressed)
        if len(compressed) >= 100_000_000:
            raise ValueError("Public data chunks must stay below GitHub's file-size limit")
        files.append({"url": f"./scenarios/terrain/{path.name}", "rowStart": start, "rowCount": len(rows),
            "encoding": "gzip", "byteLength": len(compressed), "uncompressedBytes": len(raw),
            "sha256": hashlib.sha256(compressed).hexdigest(), "uncompressedSha256": hashlib.sha256(raw).hexdigest()})
    return {"dtype": "int16-le" if dtype == "<i2" else "float32-le", "width": a.shape[1], "height": a.shape[0],
            "affine": list(affine)[:6], "scale": scale, "offsetM": 0,
            "nodata": None if dtype == "<i2" else "NaN", "chunks": files,
            "layout": "row-major, north to south; columns west to east; affine describes pixel corners; sample at pixel centres"}


def ecef_basis(lon, lat):
    l, p = np.radians([lon, lat])
    up = np.array([np.cos(p) * np.cos(l), np.cos(p) * np.sin(l), np.sin(p)])
    east = np.array([-np.sin(l), np.cos(l), 0.])
    north = np.cross(up, east)
    return up, east, north


def sample_height(lon, lat, near, nt, far, ft):
    x, y = SCIENCE.stereographic(lon, lat)
    fine = SCIENCE.bilinear(near, nt, x, y)
    coarse = SCIENCE.bilinear(far, ft, x, y) * .5
    return np.where(np.isfinite(fine), fine, coarse)


def point_horizons(lon, lat, heights, near, nt, far, ft, step=.25, ranges=RANGES):
    surface = float(sample_height(lon, lat, near, nt, far, ft))
    up, east, north = ecef_basis(lon, lat)
    azimuths = np.arange(0., 360., step)
    delta = ranges / R
    cs, sn = np.cos(delta), np.sin(delta)
    result = np.empty((len(heights), len(azimuths)))
    for start in range(0, len(azimuths), 32):
        az = np.radians(azimuths[start:start + 32])
        direction = np.sin(az)[:, None] * east + np.cos(az)[:, None] * north
        target = up[None, None, :] * cs[None, :, None] + direction[:, None, :] * sn[None, :, None]
        x = 2 * R * target[:, :, 1] / (1 - target[:, :, 2])
        y = 2 * R * target[:, :, 0] / (1 - target[:, :, 2])
        fine = SCIENCE.bilinear(near, nt, x, y)
        coarse = SCIENCE.bilinear(far, ft, x, y) * .5
        height = np.where(np.isfinite(fine), fine, coarse)
        assert np.isfinite(height).all()
        radius = R + height
        horizontal = radius * sn
        for i, observer_height in enumerate(heights):
            vertical = radius * cs - (R + surface + observer_height)
            result[i, start:start + len(az)] = np.degrees(np.arctan(np.max(vertical / horizontal, axis=1)))
    return surface, result


def fixtures(sites, rasters, far, ft):
    output = {"description": "Independent Python reference for TS raster projection, pixel-centre interpolation and curved horizon computation.",
              "frame": "MOON_ME_DE421", "referenceRadiusM": R, "sampling": SAMPLING, "points": [], "convergence": []}
    for site in sites:
        near, nt = rasters[site["id"]]
        # Nearby references exercise point changes; corners prove supported coverage.
        offsets = [(0, 0), (100, 75), (-2560, -2560), (2560, 2560)]
        for east_m, north_m in offsets:
            lon, lat = map(float, SCIENCE.destination(site["longitudeDeg"], site["latitudeDeg"],
                np.degrees(np.arctan2(east_m, north_m)), np.hypot(east_m, north_m)))
            surface, profiles = point_horizons(lon, lat, [2., 10.], near, nt, far, ft)
            output["points"].append({"regionId": site["id"], "latitudeDeg": lat, "longitudeDeg": lon,
                "eastM": east_m, "northM": north_m, "surfaceHeightM": surface,
                "components": [{"heightAboveGroundM": h, "azimuthStepDeg": .25, "horizonElevationDeg": profile.tolist()} for h, profile in zip([2., 10.], profiles)]})
            assert np.all(profiles[1] <= profiles[0] + 1e-12), "Raised observers must not raise the terrain horizon"
            if east_m == north_m == 0:
                _, refined = point_horizons(lon, lat, [2.], near, nt, far, ft, .125)
                # Refined odd bearings expose features that interpolation misses.
                coarse_interpolated = (profiles[0] + np.roll(profiles[0], -1)) / 2
                error = refined[0, 1::2] - coarse_interpolated
                half_ranges = np.unique(np.r_[RANGES, (RANGES[:-1] + RANGES[1:]) / 2])
                _, range_refined = point_horizons(lon, lat, [2.], near, nt, far, ft, ranges=half_ranges)
                range_error = range_refined[0] - profiles[0]
                output["convergence"].append({"regionId": site["id"], "coarseStepDeg": .25, "refinedStepDeg": .125,
                    "maxAbsoluteMidBearingDifferenceDeg": float(np.max(np.abs(error))),
                    "p95AbsoluteMidBearingDifferenceDeg": float(np.percentile(np.abs(error), 95)),
                    "meanAbsoluteMidBearingDifferenceDeg": float(np.mean(np.abs(error))),
                    "halfRangeStepMaxHorizonIncreaseDeg": float(np.max(range_error)),
                    "halfRangeStepP95HorizonIncreaseDeg": float(np.percentile(range_error, 95)),
                    "interpretation": "Sampled convergence at the default observer only; not a guaranteed angular error bound or propagation of source elevation uncertainty."})
        print("Prepared reference horizons", site["id"], flush=True)
    write_json(ROOT / "terrain/reference-fixtures.json", output)
    return output


def build(cache_dir):
    pins = baseline_pins()
    sites = json.loads((APP / "public/data/observatory.json").read_text())["sites"]
    far_path = cache_dir / "LDEM_80S_80M.JP2"
    far, ft = read_raster(far_path)
    assert far.dtype == np.dtype("int16") and far.shape == (7600, 7600)
    assert tuple(ft)[:6] == (80, 0, -304000, 0, -80, 304000)
    manifest = {"schemaVersion": 1, "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "frame": "MOON_ME_DE421", "referenceRadiusM": R,
        "heightDatum": "Radial surface elevation in metres above a 1,737,400 m sphere; observer component heights are above sampled ground.",
        "ephemerisManifestUrl": "./scenarios/ephemeris/manifest.json", "scienceBaselinePins": pins,
        "horizonSampling": SAMPLING, "regions": {},
        "limitations": [
            "Independent scenario model; the original three-site hourly demonstration remains unchanged for regression.",
            "NASA 5 m pixels are a sampling grid, not a 5 m position or height accuracy guarantee. Interpolated terrain and source elevation uncertainty limit visibility and energy estimates.",
            "Horizon bearings and range samples are finite. Narrow obstructions between rays or samples may be missed; terrain beyond 200 km is excluded.",
            "5 m regional and 80 m polar products can differ at their boundary. No blending or synthetic relief is added.",
            "The supported point domain is a 5.12 km geodesic square around each demonstration origin. Rendering a location does not establish scientific coverage.",
        ]}
    manifest["farField"] = write_raster(far, ft, "polar-80m", "<i2", .5, 1900)
    manifest["farField"].update(validProjectedRadiusM=303900,
        source={"url": SCIENCE.GLOBAL_URL, "sha256": SCIENCE.file_hash(far_path), "bytes": far_path.stat().st_size,
                "labelUrl": "https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/JP2/LDEM_80S_80M_JP2.LBL",
                "title": "NASA LOLA PDS LDEM_80S_80M v2.1", "detail": "Signed 16-bit values multiplied by 0.5 m; PDS offset 1,737,400 m describes radius, not a second offset to add to elevations."})
    rasters = {}
    for site in sites:
        region = REGIONS[site["id"]]
        path = cache_dir / f"{region}_final_adj_5mpp_surf.tif"
        near, nt = read_raster(path)
        assert near.shape == (3200, 3200) and near.dtype == np.dtype("float32") and nt.a == 5
        rasters[site["id"]] = near, nt
        raster = write_raster(near, nt, region + "-5m", "<f4", 1, 3200)
        raster["source"] = {"url": f"https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/{region}/{path.name}",
            "sha256": SCIENCE.file_hash(path), "bytes": path.stat().st_size,
            "documentationUrl": "https://pgda.gsfc.nasa.gov/products/78", "title": f"NASA PGDA LOLA 5 m {region}"}
        surface = float(sample_height(site["longitudeDeg"], site["latitudeDeg"], near, nt, far, ft))
        manifest["regions"][site["id"]] = {"id": site["id"], "name": site["name"],
            "origin": {"latitudeDeg": site["latitudeDeg"], "longitudeDeg": site["longitudeDeg"], "surfaceHeightM": surface,
                       "visualCenterHeightM": site["terrain"]["centerHeightM"]},
            "supportedDomain": {"type": "azimuthal-equidistant-square", "bounds": {
                "eastMinM": -2560, "eastMaxM": 2560, "northMinM": -2560, "northMaxM": 2560}},
            "nearRaster": raster,
            "pointPolicy": "Use requested coordinates and re-sample native DEM surface height. Never accept a display-mesh hit elevation as scientific ground height."}
        print("Prepared scientific region", site["id"], flush=True)
    reference = fixtures(sites, rasters, far, ft)
    manifest["referenceFixturesUrl"] = "./scenarios/terrain/reference-fixtures.json"
    manifest["horizonConvergence"] = reference["convergence"]
    all_chunks = manifest["farField"]["chunks"] + [c for region in manifest["regions"].values() for c in region["nearRaster"]["chunks"]]
    manifest["terrainCompressedBytes"] = sum(c["byteLength"] for c in all_chunks)
    manifest["terrainUncompressedBytes"] = sum(c["uncompressedBytes"] for c in all_chunks)
    pin_dataset_identity(manifest)
    assert baseline_pins() == pins
    write_json(ROOT / "manifest.json", manifest)
    verify()


def verify():
    manifest = json.loads((ROOT / "manifest.json").read_text())
    assert baseline_pins() == manifest["scienceBaselinePins"]
    assert manifest["frame"] == "MOON_ME_DE421" and manifest["referenceRadiusM"] == R
    recorded_id = manifest["datasetId"]
    pin_dataset_identity(manifest)
    assert manifest["datasetId"] == recorded_id
    rasters = [manifest["farField"]] + [r["nearRaster"] for r in manifest["regions"].values()]
    arrays = []
    for raster in rasters:
        chunks = []
        next_row = 0
        for chunk in raster["chunks"]:
            path = APP / "public" / chunk["url"].removeprefix("./")
            compressed = path.read_bytes()
            assert len(compressed) == chunk["byteLength"] < 100_000_000
            assert hashlib.sha256(compressed).hexdigest() == chunk["sha256"]
            raw = gzip.decompress(compressed)
            assert len(raw) == chunk["uncompressedBytes"]
            assert hashlib.sha256(raw).hexdigest() == chunk["uncompressedSha256"]
            assert chunk["rowStart"] == next_row
            dtype = "<i2" if raster["dtype"] == "int16-le" else "<f4"
            a = np.frombuffer(raw, dtype=dtype).reshape(chunk["rowCount"], raster["width"])
            assert np.isfinite(a).all()
            chunks.append(a)
            next_row += chunk["rowCount"]
        assert next_row == raster["height"]
        arrays.append(np.concatenate(chunks))
    for index, region in enumerate(manifest["regions"].values(), 1):
        origin, raster = region["origin"], region["nearRaster"]
        from affine import Affine
        transform = Affine(*raster["affine"])
        # All corners plus edge midpoints must remain in native fine coverage.
        for east_m in (-2560., 0., 2560.):
            for north_m in (-2560., 0., 2560.):
                lon, lat = SCIENCE.destination(origin["longitudeDeg"], origin["latitudeDeg"],
                    np.degrees(np.arctan2(east_m, north_m)), np.hypot(east_m, north_m))
                x, y = SCIENCE.stereographic(lon, lat)
                assert np.isfinite(SCIENCE.bilinear(arrays[index], transform, x, y)), "Supported point must have native5m coverage"
                maximum_polar_angle = np.radians(float(lat) + 90) + 200000 / R
                maximum_projected_radius = 2 * R * np.tan(maximum_polar_angle / 2)
                assert maximum_projected_radius < manifest["farField"]["validProjectedRadiusM"], "Supported200km horizon rays must fit valid far field"
    reference = json.loads((ROOT / "terrain/reference-fixtures.json").read_text())
    assert len(reference["points"]) == 12 and len(reference["convergence"]) == 3
    for point in reference["points"]:
        assert len(point["components"]) == 2
        assert all(len(c["horizonElevationDeg"]) == 1440 for c in point["components"])
    report = {"rastersChecked": len(rasters), "chunksChecked": sum(len(r["chunks"]) for r in rasters),
        "referencePoints": len(reference["points"]), "horizonProfiles": 24,
        "nativeValuesPreserved": True, "scienceBaselineUnchanged": True,
        "compressedBytes": manifest["terrainCompressedBytes"], "uncompressedBytes": manifest["terrainUncompressedBytes"],
        "checks": ["source frame and radius", "baseline hashes", "compressed and raw hashes", "complete ordered row coverage",
                   "valid little-endian dimensions", "finite source values", "public files below100MB", "independent horizon fixtures",
                   "supported points have native5m data", "supported200km rays fit far-field validity"]}
    write_json(ROOT / "terrain/verification.json", report)
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=APP.parent.parent / "research/terrain-build/raw")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--fixtures-only", action="store_true", help="Refresh numerical reference/convergence cases without recompressing unchanged source rasters")
    args = parser.parse_args()
    if args.fixtures_only:
        cache_dir = args.cache_dir.resolve()
        sites = json.loads((APP / "public/data/observatory.json").read_text())["sites"]
        far, ft = read_raster(cache_dir / "LDEM_80S_80M.JP2")
        rasters = {site["id"]: read_raster(cache_dir / f"{REGIONS[site['id']]}_final_adj_5mpp_surf.tif") for site in sites}
        reference = fixtures(sites, rasters, far, ft)
        manifest = json.loads((ROOT / "manifest.json").read_text())
        manifest["horizonSampling"] = SAMPLING
        manifest["horizonConvergence"] = reference["convergence"]
        manifest["generatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        pin_dataset_identity(manifest)
        assert baseline_pins() == manifest["scienceBaselinePins"]
        write_json(ROOT / "manifest.json", manifest)
        verify()
    else:
        verify() if args.verify_only else build(args.cache_dir.resolve())
