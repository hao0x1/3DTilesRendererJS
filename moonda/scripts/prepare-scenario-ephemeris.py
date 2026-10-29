#!/usr/bin/env python3
"""Prepare MOONDA's offline lunar scenario ephemeris and measured error report.

Generation (from moonda; keep kernels/Python overlays on the SSD):
  PYTHONPATH=../../research/scenario-science/python:../../research/terrain-build/python \
    python scripts/prepare-scenario-ephemeris.py
  python scripts/prepare-scenario-ephemeris.py --verify-only

Generation needs numpy, spiceypy==6.0.0 and rasterio (terrain validation only).
Verification uses the Python standard library, committed files, and no network.
Kernels are downloaded from NASA/JPL NAIF with certificate-verified curl.
The committed cache is an approximation for a surface observer: interpolate the
Moon-center apparent state in ET, then subtract the observer's fixed-frame
Cartesian position. It is explicitly tested against SPKCPO; it is not claimed
to be an exact topocentric aberration calculation.
"""
from __future__ import annotations

import argparse
import array
import csv
import datetime as dt
import hashlib
import io
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
RESEARCH = ROOT.parents[1] / "research"
RADIUS_M = 1737400.0
AU_M = 149597870700.0
FRAME = "MOON_ME_DE421"
CORRECTION = "CN+S"
START = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
END = dt.datetime(2028, 1, 1, tzinfo=dt.timezone.utc)
STEP_S = 3600
UA = "MOONDAObservatory/0.1 (+https://github.com/hao0x1/3DTilesRendererJS)"
KERNEL_URLS = [
    "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/naif0012.tls",
    "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/a_old_versions/de421.bsp",
    "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de421_1900-2050.bpc",
    "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_080317.tf",
]
KERNEL_SHA256 = {
    "naif0012.tls": "678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b",
    "de421.bsp": "08b20db2ae22488650641c5a9033e5bfda4b1c4b440cfeaf20f621cfa18ecdb3",
    "moon_pa_de421_1900-2050.bpc": "656f90616403d75a75f0cd6c8830fc5b44f8cb4facb5ccb8915e752b397520cf",
    "moon_080317.tf": "78732477b96f9863e7b0d65bcee3c22b8707ca5ed0db56d1173319cb2e8c7993",
}
REGIONS = {"connecting-ridge": "Site01", "shackleton-rim": "Site04", "shackleton-peak": "Site07"}
CHANNELS = ["etSecondsPastJ2000TDB"] + [
    f"{body}{component}" for body in ("sun", "earth")
    for component in ("X_M", "Y_M", "Z_M", "Vx_MPerS", "Vy_MPerS", "Vz_MPerS")
]


def stamp(value):
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    if isinstance(value, bytes):
        temp.write_bytes(value)
    else:
        temp.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temp.replace(path)


def file_record(path):
    return {"url": "./scenarios/ephemeris/" + path.name,
            "bytes": path.stat().st_size, "sha256": digest(path)}


def download(url, folder):
    path = folder / url.rsplit("/", 1)[-1]
    if not path.exists():
        folder.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + ".part")
        print("Downloading", path.name, flush=True)
        subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                        "--retry", "2", "--max-time", "240", "--user-agent", UA,
                        "--output", str(temp), url], check=True)
        temp.replace(path)
    if digest(path) != KERNEL_SHA256[path.name]:
        raise ValueError(f"Kernel hash differs from the pinned NASA source: {path.name}")
    return path


def hermite(rows, et, np):
    i = int(np.searchsorted(rows[:, 0], et, side="right") - 1)
    i = min(max(i, 0), len(rows) - 2)
    a, b = rows[i], rows[i + 1]
    h = b[0] - a[0]
    t = (et - a[0]) / h
    return np.concatenate([
        (2*t**3 - 3*t**2 + 1)*a[j:j+3] + (t**3 - 2*t**2 + t)*h*a[j+3:j+6]
        + (-2*t**3 + 3*t**2)*b[j:j+3] + (t**3 - t**2)*h*b[j+3:j+6]
        for j in (1, 7)
    ]).reshape(2, 3)


def destination(lon, lat, east, north, np):
    phi, lam = np.radians([lat, lon])
    bearing, delta = np.arctan2(east, north), np.hypot(east, north) / RADIUS_M
    phi2 = np.arcsin(np.sin(phi)*np.cos(delta) + np.cos(phi)*np.sin(delta)*np.cos(bearing))
    lam2 = lam + np.arctan2(np.sin(bearing)*np.sin(delta)*np.cos(phi),
                          np.cos(delta) - np.sin(phi)*np.sin(phi2))
    return float(np.degrees(lam2)), float(np.degrees(phi2))


def fixed_position(lon, lat, height, np):
    lam, phi = np.radians([lon, lat])
    return (RADIUS_M + height)*np.array([np.cos(phi)*np.cos(lam), np.cos(phi)*np.sin(lam), np.sin(phi)])


def point_set(sites, raw, np):
    import rasterio
    points, stress, terrain = [], [], []
    for site in sites:
        path = raw / f"{REGIONS[site['id']]}_final_adj_5mpp_surf.tif"
        with rasterio.open(path) as raster:
            grid = raster.read(1)
            for north in (-2560, -1280, 0, 1280, 2560):
                for east in (-2560, -1280, 0, 1280, 2560):
                    lon, lat = destination(site["longitudeDeg"], site["latitudeDeg"], east, north, np)
                    rho = 2*RADIUS_M*np.tan((np.pi/2 + np.radians(lat))/2)
                    x, y = rho*np.sin(np.radians(lon)), rho*np.cos(np.radians(lon))
                    col, row = (~raster.transform)*(x, y)
                    col, row = col - .5, row - .5
                    c, r = math.floor(col), math.floor(row)
                    if not (0 <= c < raster.width - 1 and 0 <= r < raster.height - 1):
                        raise ValueError(f"Validation point left {path.name}")
                    dc, dr = col - c, row - r
                    cells = grid[r:r+2, c:c+2].astype(float)
                    if not np.isfinite(cells).all() or (raster.nodata is not None and np.any(cells == raster.nodata)):
                        raise ValueError("Invalid validation terrain")
                    z = float(cells[0, 0]*(1-dc)*(1-dr) + cells[0, 1]*dc*(1-dr)
                              + cells[1, 0]*(1-dc)*dr + cells[1, 1]*dc*dr)
                    for height in (0, 2, 10, 100):
                        points.append({"site": site["id"], "eastM": east, "northM": north,
                                       "latitudeDeg": lat, "longitudeDeg": lon,
                                       "surfaceHeightM": z, "observerHeightM": height,
                                       "positionM": fixed_position(lon, lat, z + height, np)})
                    if east in (-2560, 0, 2560) and north in (-2560, 0, 2560):
                        for surface in (-5000, 11000):
                            for height in (0, 100):
                                stress.append({"site": site["id"], "latitudeDeg": lat, "longitudeDeg": lon,
                                               "surfaceHeightM": surface, "observerHeightM": height,
                                               "positionM": fixed_position(lon, lat, surface + height, np)})
            terrain.append({"site": site["id"], "source": path.name, "sha256": digest(path)})
    return points, stress, terrain


def error_values(approx, exact, np):
    ar, er = float(np.linalg.norm(approx)), float(np.linalg.norm(exact))
    a, e = approx/ar, exact/er
    # atan2 stays well conditioned when the two vectors nearly coincide.
    angle = float(np.arctan2(np.linalg.norm(np.cross(a, e)), np.dot(a, e)))
    return [angle*180/math.pi*3600, abs(ar-er), float(np.linalg.norm(approx-exact))]


def stats(errors, np):
    a = np.asarray(errors)
    result = {"comparisons": len(a)}
    for i, name in enumerate(("angularSeparationArcsec", "absoluteRangeErrorM", "positionDifferenceM")):
        result[name] = {"maximum": float(np.max(a[:, i])), "rms": float(np.sqrt(np.mean(a[:, i]**2))),
                        "p95": float(np.percentile(a[:, i], 95))}
    result["absoluteDistanceErrorAU"] = {k: v/AU_M for k, v in result["absoluteRangeErrorM"].items()}
    return result


def validate_cache(rows, times, sites, raw, spice, np):
    points, stress, terrain = point_set(sites, raw, np)
    # Deterministic withholding over the full two-year interval. Fractions
    # include exact quarter/mid/three-quarter hours and irregular offsets.
    rng = np.random.default_rng(20261029)
    intervals = np.unique(np.r_[np.linspace(0, len(rows)-2, 192).astype(int), rng.integers(0, len(rows)-1, 64)])
    fractions = (.25, .5, .75, .123456789)
    withheld = [(int(i), fractions[n % len(fractions)]) for n, i in enumerate(intervals)]
    eclipse_times = [f"2026-03-03T{hour:02d}:{minute:02d}:00Z"
                     for hour, minute in ((7, 15), (8, 45), (9, 15), (10, 15), (10, 45),
                                          (11, 15), (11, 30), (11, 45), (12, 15), (13, 15), (13, 45), (14, 15), (15, 45))]
    for utc in eclipse_times:
        hour_offset = (dt.datetime.fromisoformat(utc.replace("Z", "+00:00"))-START).total_seconds()/STEP_S
        item = (int(hour_offset), hour_offset % 1)
        if item not in withheld:
            withheld.append(item)
    interpolation = {body: [] for body in ("sun", "earth")}
    combined = {body: [] for body in ("sun", "earth")}
    stressed = {body: [] for body in ("sun", "earth")}
    translation = {body: [] for body in ("sun", "earth")}
    time_mapping = []
    worst = {"sun": (0, None), "earth": (0, None)}
    for n, (index, fraction) in enumerate(withheld):
        utc = START + dt.timedelta(seconds=(index + fraction)*STEP_S)
        # Real browser lookup maps a UTC fraction to the two exact ET rows.
        et = rows[index, 0] + fraction*(rows[index+1, 0] - rows[index, 0])
        exact_et = spice.str2et(utc.isoformat().replace("+00:00", "Z"))
        time_mapping.append(abs(et-exact_et))
        interpolated = hermite(rows, et, np)
        for body_index, body in enumerate(("sun", "earth")):
            exact_center = np.asarray(spice.spkezr(body.upper(), exact_et, FRAME, CORRECTION, "MOON")[0][:3])*1000
            interpolation[body].append(error_values(interpolated[body_index], exact_center, np))
            for point in points:
                exact = np.asarray(spice.spkcpo(body.upper(), exact_et, FRAME, "OBSERVER", CORRECTION,
                                               point["positionM"]/1000, "MOON", FRAME)[0][:3])*1000
                errors = error_values(interpolated[body_index] - point["positionM"], exact, np)
                combined[body].append(errors)
                if errors[0] > worst[body][0]:
                    worst[body] = (errors[0], {**{k: v for k, v in point.items() if k != "positionM"},
                                              "utc": utc.isoformat().replace("+00:00", "Z")})
            if n % 4 == 0:
                for point in stress:
                    exact = np.asarray(spice.spkcpo(body.upper(), exact_et, FRAME, "OBSERVER", CORRECTION,
                                                   point["positionM"]/1000, "MOON", FRAME)[0][:3])*1000
                    stressed[body].append(error_values(interpolated[body_index] - point["positionM"], exact, np))
        if n % 64 == 0:
            print(f"Validated withheld epoch {n + 1}/{len(withheld)}", flush=True)
    sample_indices = np.unique(np.r_[0, 72, len(rows)-1, np.linspace(0, len(rows)-1, 64).astype(int)])
    for index in sample_indices:
        for body_index, body in enumerate(("sun", "earth")):
            j = 1 + 6*body_index
            for point in points:
                exact = np.asarray(spice.spkcpo(body.upper(), rows[index, 0], FRAME, "OBSERVER", CORRECTION,
                                               point["positionM"]/1000, "MOON", FRAME)[0][:3])*1000
                translation[body].append(error_values(rows[index, j:j+3] - point["positionM"], exact, np))
    return {
        "method": "Finite deterministic validation; sampled maxima are not global physical error bounds.",
        "reference": "spkcpo(target, exactEt, MOON_ME_DE421, OBSERVER, CN+S, positionM/1000, MOON, MOON_ME_DE421)",
        "angularMetric": "atan2(norm(cross(unitApprox,unitExact)),dot(unitApprox,unitExact)); no polar azimuth subtraction",
        "withheldEpochCount": len(withheld), "withheldFractionsOfHour": list(fractions),
        "additionalExplicitEclipsePhaseEpochsUtc": eclipse_times,
        "exactSampleEpochCount": len(sample_indices),
        "exactSampleChecksInclude": [times[0], times[72], times[-1]],
        "actualTerrainObserverCount": len(points), "actualTerrainGrid": "5 by 5 points per site's central geodesic square, east/north -2560..2560 m",
        "observerHeightsM": [0, 2, 10, 100],
        "actualSampledSurfaceHeightRangeM": [min(p["surfaceHeightM"] for p in points), max(p["surfaceHeightM"] for p in points)],
        "stressSurfaceHeightsM": [-5000, 11000], "stressObserverHeightsM": [0, 100],
        "terrainSources": terrain, "utcFractionToEtMaximumErrorSeconds": max(time_mapping),
        "interpolationVsExactMoonCenter": {body: stats(v, np) for body, v in interpolation.items()},
        "exactSampleMoonCenterTranslationVsSpkcpo": {body: stats(v, np) for body, v in translation.items()},
        "interpolatedActualObserverVsSpkcpo": {body: {**stats(v, np), "worstAngularCase": worst[body][1]} for body, v in combined.items()},
        "interpolatedStressObserverVsSpkcpo": {body: stats(v, np) for body, v in stressed.items()},
    }


def compare_horizons(sites, raw, rows, spice, np):
    comparisons, sources = {}, []
    for site in sites:
        for body, target in (("sun", "10"), ("earth", "399")):
            selected = None
            for path in sorted(raw.glob(f"{site['id']}-{body}*.json")):
                data = json.loads(path.read_text())
                params = urllib.parse.parse_qs(urllib.parse.urlsplit(data.get("requestUrl", "")).query)
                try:
                    coords = [float(v) for v in params["SITE_COORD"][0].strip("'").split(",")]
                    command = params["COMMAND"][0].strip("'")
                except (KeyError, ValueError):
                    continue
                if command != target or abs(coords[0]-site["longitudeDeg"]) > 1e-7 or abs(coords[1]-site["latitudeDeg"]) > 1e-7:
                    continue
                if abs(coords[2]*1000 - site["terrain"]["centerHeightM"] - 2) > .01:
                    continue
                if "$$SOE" in data.get("result", ""):
                    selected = path, data, coords
                    break
            if selected is None:
                raise ValueError(f"No matching independent Horizons baseline for {site['id']}/{body}")
            path, data, (lon, lat, height_km) = selected
            position = fixed_position(lon, lat, height_km*1000, np)
            lam, phi = np.radians([lon, lat])
            east = np.array([-np.sin(lam), np.cos(lam), 0])
            north = np.array([-np.sin(phi)*np.cos(lam), -np.sin(phi)*np.sin(lam), np.cos(phi)])
            up = position/np.linalg.norm(position)
            errors, exact_errors = [], []
            csv_rows = csv.reader(io.StringIO(data["result"].split("$$SOE")[1].split("$$EOE")[0]))
            for row in csv_rows:
                if not row or not row[0].strip():
                    continue
                utc = dt.datetime.strptime(row[0].strip(), "%Y-%b-%d %H:%M").replace(tzinfo=dt.timezone.utc)
                et = spice.str2et(utc.isoformat().replace("+00:00", "Z"))
                az, el = np.radians([float(row[3]), float(row[4])])
                reference = east*np.sin(az)*np.cos(el) + north*np.cos(az)*np.cos(el) + up*np.sin(el)
                approx = hermite(rows, et, np)[0 if body == "sun" else 1] - position
                exact = np.asarray(spice.spkcpo(body.upper(), et, FRAME, "OBSERVER", CORRECTION,
                                               position/1000, "MOON", FRAME)[0][:3])*1000
                # Baseline has directions only, so only angular comparisons are meaningful.
                errors.append(error_values(approx/np.linalg.norm(approx), reference, np)[0])
                exact_errors.append(error_values(exact/np.linalg.norm(exact), reference, np)[0])
            if len(errors) != 721:
                raise ValueError("Expected 721 independent baseline epochs")
            summary = lambda values: {"maximum": float(np.max(values)), "rms": float(np.sqrt(np.mean(np.asarray(values)**2))), "p95": float(np.percentile(values, 95))}
            comparisons[f"{site['id']}/{body}"] = {
                "epochs": len(errors), "cacheVsHorizonsAngularArcsec": summary(errors),
                "exactSpkcpoVsHorizonsAngularArcsec": summary(exact_errors),
            }
            sources.append({"site": site["id"], "body": body, "cachedFile": path.name,
                            "cachedFileSha256": digest(path), "resultSha256": hashlib.sha256(data["result"].encode()).hexdigest(),
                            "requestUrl": data["requestUrl"], "signature": data.get("signature"),
                            "sourceDescriptions": [line.strip() for line in data["result"].splitlines()
                                                   if re.match(r"(?:Target body name|Center body name|Center pole/equ|Center radii)", line)]})
    return {"startUtc": "2026-11-01T00:00:00Z", "endUtc": "2026-12-01T00:00:00Z",
            "epochCountPerSiteAndBody": 721, "siteCount": 3, "bodyCount": 2,
            "comparison": "Airless Horizons azimuth/elevation converted to fixed-frame unit directions for validation only; cache is independently generated from SPICE kernels.",
            "limitations": "Horizons baseline uses DE441 and its MEAN_ME realization; this cache uses DE421/MOON_ME_DE421. Differences include ephemeris/frame versions, Horizons' observer corrections, and printed azimuth/elevation precision; they are not solely cache interpolation error. Baseline contains no range quantity.",
            "results": comparisons, "sources": sources}


def reference_fixtures(rows, sites, raw, spice, np):
    """Small public golden cases for independently checking browser workers."""
    import rasterio
    fixtures = []
    offsets = [(-2043.25, 1179.5), (931.75, -1884.125), (151.5, 713.25), (-2251.25, -2367.5),
               (137.25, -391.5), (0, 0), (2456.5, -1598.25)]
    utc_values = [stamp(START), "2026-11-17T06:37:15Z", "2027-08-02T18:22:33Z", stamp(END),
                  "2026-03-03T07:00:00Z", "2026-03-03T11:30:00Z", "2026-03-03T16:00:00Z"]
    for site in sites:
        path = raw / f"{REGIONS[site['id']]}_final_adj_5mpp_surf.tif"
        with rasterio.open(path) as raster:
            grid = raster.read(1)
            for n, (east_offset, north_offset) in enumerate(offsets):
                lon, lat = destination(site["longitudeDeg"], site["latitudeDeg"], east_offset, north_offset, np)
                rho = 2*RADIUS_M*np.tan((np.pi/2 + np.radians(lat))/2)
                x, y = rho*np.sin(np.radians(lon)), rho*np.cos(np.radians(lon))
                col, row = (~raster.transform)*(x, y)
                col, row = col-.5, row-.5
                c, r = math.floor(col), math.floor(row)
                dc, dr = col-c, row-r
                surface = float(grid[r, c]*(1-dc)*(1-dr) + grid[r, c+1]*dc*(1-dr)
                                + grid[r+1, c]*(1-dc)*dr + grid[r+1, c+1]*dc*dr)
                height = (0, 2, 10, 100)[n % 4]
                position = fixed_position(lon, lat, surface + height, np)
                lam, phi = np.radians([lon, lat])
                east = np.array([-np.sin(lam), np.cos(lam), 0])
                north = np.array([-np.sin(phi)*np.cos(lam), -np.sin(phi)*np.sin(lam), np.cos(phi)])
                up = position/np.linalg.norm(position)
                utc = utc_values[n]
                et = spice.str2et(utc)
                seconds = (dt.datetime.fromisoformat(utc.replace("Z", "+00:00"))-START).total_seconds()
                index = min(int(seconds//STEP_S), len(rows)-2)
                fraction = seconds/STEP_S-index
                mapped_et = rows[index, 0] + fraction*(rows[index+1, 0]-rows[index, 0])
                cache_vectors = hermite(rows, mapped_et, np)-position
                expected = {}
                residual = {}
                for j, body in enumerate(("sun", "earth")):
                    vector = np.asarray(spice.spkcpo(body.upper(), et, FRAME, "OBSERVER", CORRECTION,
                                                   position/1000, "MOON", FRAME)[0][:3])*1000
                    distance = float(np.linalg.norm(vector))
                    expected[body + "VectorM"] = vector.tolist()
                    expected[body + "RangeM"] = distance
                    expected[body + "DistanceAU"] = distance/AU_M
                    expected[body + "AzDeg"] = float(np.degrees(np.arctan2(vector@east, vector@north)) % 360)
                    expected[body + "ElDeg"] = float(np.degrees(np.arcsin(np.clip(vector@up/distance, -1, 1))))
                    values = error_values(cache_vectors[j], vector, np)
                    residual[body] = dict(zip(("angularSeparationArcsec", "absoluteRangeErrorM", "positionDifferenceM"), values))
                fixtures.append({"id": f"{site['id']}-{n}", "siteId": site["id"], "utc": utc,
                                 "etSecondsPastJ2000TDB": float(et), "mappedEtSecondsPastJ2000TDB": float(mapped_et),
                                 "latitudeDeg": lat, "longitudeDeg": lon, "surfaceHeightM": surface,
                                 "observerHeightM": height, "observerPositionM": position.tolist(),
                                 "exactSpkcpo": expected, "cacheInterpolatedVectorsM": {"sun": cache_vectors[0].tolist(), "earth": cache_vectors[1].tolist()},
                                 "cacheVsExactResidual": residual})
    return {"schemaVersion": 1, "frame": FRAME, "correction": CORRECTION, "radiusM": RADIUS_M,
            "description": "Independent exact SPKCPO expectations plus golden Hermite cache vectors for arbitrary nearby lunar points; azimuth north-through-east, elevation above radial local horizon.",
            "fixtures": fixtures}


def generate(args):
    import numpy as np
    import spiceypy as spice
    import rasterio
    paths = [download(url, args.kernel_dir) for url in KERNEL_URLS]
    spice.kclear()
    for path in paths:
        spice.furnsh(str(path))
    count = int((END-START).total_seconds()/STEP_S) + 1
    times = [stamp(START + dt.timedelta(seconds=i*STEP_S)) for i in range(count)]
    rows = np.empty((count, 13), dtype="<f8")
    for i, utc in enumerate(times):
        et = spice.str2et(utc)
        rows[i, 0] = et
        for j, body in ((1, "SUN"), (7, "EARTH")):
            rows[i, j:j+6] = np.asarray(spice.spkezr(body, et, FRAME, CORRECTION, "MOON")[0])*1000
    print(f"Generated {count} independent NASA SPICE states for each body", flush=True)
    sites = json.loads((ROOT / "public/data/observatory.json").read_text())["sites"]
    validation = validate_cache(rows, times, sites, args.raw_dir, spice, np)
    horizons = compare_horizons(sites, args.raw_dir, rows, spice, np)
    binary_path = args.output / "states.f64le"
    times_path = args.output / "epochs.utc.json"
    write(binary_path, rows.tobytes())
    write(times_path, times)
    write(args.output / "validation.json", {"spice": validation, "independentHorizons": horizons})
    write(args.output / "reference-fixtures.json", reference_fixtures(rows, sites, args.raw_dir, spice, np))
    kernels = []
    for path, url in zip(paths, KERNEL_URLS):
        record = {"name": path.name, "url": url, "bytes": path.stat().st_size, "sha256": digest(path)}
        if path.suffix == ".bsp":
            record["coverageEtByObject"] = {str(int(obj)): list(spice.spkcov(str(path), int(obj))) for obj in spice.spkobj(str(path))}
        elif path.suffix == ".bpc":
            ids = spice.utils.support_types.SPICEINT_CELL(16)
            spice.pckfrm(str(path), ids)
            coverage = {}
            for obj in ids:
                cover = spice.utils.support_types.SPICEDOUBLE_CELL(128)
                spice.pckcov(str(path), int(obj), cover)
                coverage[str(int(obj))] = list(cover)
            record["coverageEtByFrameClassId"] = coverage
        kernels.append(record)
    manifest = {
        "schemaVersion": 1, "generatedAtUtc": stamp(dt.datetime.now(dt.timezone.utc)),
        "description": "Offline Sun/Earth apparent Moon-center states with measured surface-observer translation approximation.",
        "frame": FRAME, "frameId": 31007, "correction": CORRECTION, "observer": "MOON",
        "radiusM": RADIUS_M, "astronomicalUnitM": AU_M,
        "startUtc": times[0], "endUtc": times[-1], "sampleIntervalSeconds": STEP_S,
        "stepSeconds": STEP_S, "stride": 13, "dtype": "float64-le", "epochsUtc": times,
        "chunks": [{"url": "./scenarios/ephemeris/states.f64le", "byteLength": binary_path.stat().st_size,
                    "sha256": digest(binary_path), "rowStart": 0, "rowCount": count}],
        "binary": {**file_record(binary_path), "sampleCount": count, "strideValues": 13,
                   "channels": CHANNELS, "byteOrder": "little-endian", "scalarType": "float64",
                   "positionUnits": "m", "velocityUnits": "m/s"},
        "times": {**file_record(times_path), "format": "JSON array of ISO-8601 UTC strings; one per binary row"},
        "referenceFixtures": file_record(args.output / "reference-fixtures.json"),
        "timeScale": "ET seconds past J2000 TDB; exact SPICE STR2ET at every UTC sample using naif0012.tls",
        "interpolation": {"method": "Cubic Hermite on Cartesian positions using stored rotating-frame velocity derivatives and ET seconds",
                          "utcToEt": "Bracket UTC sample strings and linearly map the UTC fraction into their exact ET rows; measured mapping error is in validation.json",
                          "surfaceObserver": "Subtract (radiusM + DEM heightM + panel/antenna heightM) times radial unit vector in MOON_ME_DE421 after interpolation",
                          "bounds": "Reject dates outside inclusive startUtc/endUtc; require full mission duration coverage"},
        "approximation": "Moon-center light time and stellar aberration differ slightly from a true surface observer. Stored states are not exact topocentric states; finite sampled comparisons against SPKCPO quantify this error separately from interpolation.",
        "frameEpoch": "SPKEZR evaluates a non-inertial frame at et-ltcent for reception. This frame is centered on Moon and the cache observer is Moon, so ltcent=0 and frame orientation is evaluated at observer epoch et.",
        "eclipseInputs": "Use each actual surface-observer Sun and Earth vector and its norm for angular-sphere overlap. A Moon-center eclipse fraction must not be shared across selectable points.",
        "leapSeconds": "naif0012.tls includes the last listed leap second at 2017-01-01. Future UTC leap-second announcements require regenerating this cache; no unannounced leap second is assumed in 2026-2027.",
        "kernels": kernels,
        "software": {"python": sys.version.split()[0], "numpy": np.__version__, "spiceypy": spice.__version__,
                     "cspice": spice.tkvrsn("TOOLKIT"), "rasterio": rasterio.__version__},
        "validation": {**file_record(args.output / "validation.json"),
                       "sampledMaximaAreNotGlobalBounds": True,
                       "interpolatedActualObserverVsSpkcpo": validation["interpolatedActualObserverVsSpkcpo"],
                       "interpolatedStressObserverVsSpkcpo": validation["interpolatedStressObserverVsSpkcpo"],
                       "horizonsComparison": horizons["results"]},
        "primaryReferences": [
            {"url": "https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spkezr_c.html", "supports": "State velocity is position derivative in km/s; non-inertial frame evaluation epoch and CN+S reception correction."},
            {"url": "https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spkcpo_c.html", "supports": "Constant-position surface observer reference; OBSERVER evaluates output frame at observer epoch; ET is seconds past J2000 TDB."},
            {"url": KERNEL_URLS[3], "supports": "Explicit DE421 lunar Mean Earth frame, frame ID31007, paired binary lunar orientation kernel; generic IAU_MOON is a different realization."},
        ],
        "generator": "scripts/prepare-scenario-ephemeris.py",
    }
    write(args.output / "manifest.json", manifest)
    spice.kclear()
    verify(args.output)


def verify(folder):
    manifest = json.loads((folder / "manifest.json").read_text())
    assert manifest["schemaVersion"] == 1
    assert manifest["frame"] == FRAME and manifest["correction"] == CORRECTION
    assert manifest["radiusM"] == RADIUS_M
    for name in ("binary", "times", "validation", "referenceFixtures"):
        record = manifest[name]
        path = folder / Path(record["url"]).name
        assert path.stat().st_size == record["bytes"], f"Size mismatch: {path}"
        assert digest(path) == record["sha256"], f"Hash mismatch: {path}"
    binary = manifest["binary"]
    assert binary["strideValues"] == len(CHANNELS) == 13 and binary["channels"] == CHANNELS
    assert binary["byteOrder"] == "little-endian" and binary["scalarType"] == "float64"
    times = json.loads((folder / "epochs.utc.json").read_text())
    expected_count = int((END-START).total_seconds()/STEP_S) + 1
    assert len(times) == binary["sampleCount"] == expected_count
    assert times[0] == stamp(START) and times[-1] == stamp(END)
    assert manifest["epochsUtc"] == times
    assert manifest["stride"] == 13 and manifest["dtype"] == "float64-le" and manifest["stepSeconds"] == STEP_S
    assert manifest["chunks"] == [{"url": binary["url"], "byteLength": binary["bytes"], "sha256": binary["sha256"], "rowStart": 0, "rowCount": expected_count}]
    assert {k["name"]: k["sha256"] for k in manifest["kernels"]} == KERNEL_SHA256
    for i, value in enumerate(times):
        assert value == stamp(START + dt.timedelta(seconds=i*STEP_S)), f"UTC cadence mismatch at {i}"
    values = array.array("d")
    values.frombytes((folder / "states.f64le").read_bytes())
    if sys.byteorder != "little":
        values.byteswap()
    assert len(values) == expected_count*13
    last_et = None
    for i in range(expected_count):
        row = values[i*13:(i+1)*13]
        assert all(math.isfinite(v) for v in row), f"Non-finite state at {i}"
        if last_et is not None:
            assert 3599.99 < row[0]-last_et < 3600.01, f"ET cadence mismatch at {i}"
        last_et = row[0]
        for j, minimum, maximum in ((1, 1.4e11, 1.6e11), (7, 3.3e8, 4.2e8)):
            assert minimum < math.hypot(*row[j:j+3]) < maximum, f"Bad position units at {i}/{j}"
    validation = json.loads((folder / "validation.json").read_text())
    for body in ("sun", "earth"):
        measured = validation["spice"]["interpolatedActualObserverVsSpkcpo"][body]
        assert measured["comparisons"] > 10000
        assert measured["angularSeparationArcsec"]["maximum"] < .1, "Surface approximation exceeds 0.1 arcsec acceptance threshold"
    assert len(validation["independentHorizons"]["results"]) == 6
    assert all(v["epochs"] == 721 for v in validation["independentHorizons"]["results"].values())
    fixtures = json.loads((folder / "reference-fixtures.json").read_text())
    assert len(fixtures["fixtures"]) == 21
    print(f"Verified offline ephemeris: {expected_count} rows, {binary['bytes']} bytes, all file hashes and finite state/time checks passed.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--verify-only", action="store_true", help="Validate committed assets using the standard library; no kernels, downloads, or third-party packages")
    parser.add_argument("--output", type=Path, default=ROOT / "public/scenarios/ephemeris")
    parser.add_argument("--kernel-dir", type=Path, default=RESEARCH / "scenario-science/kernels")
    parser.add_argument("--raw-dir", type=Path, default=RESEARCH / "terrain-build/raw")
    args = parser.parse_args()
    if args.verify_only:
        verify(args.output)
    else:
        generate(args)


if __name__ == "__main__":
    main()
