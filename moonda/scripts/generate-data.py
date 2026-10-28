#!/usr/bin/env python3
"""Build small, local MOONDA NASA terrain and ephemeris demonstration data.

Install requirements in an isolated environment, then run from moonda:
  python scripts/generate-data.py --cache-dir ../../research/terrain-build/raw

No runtime API or remote terrain request is required by the resulting app.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import math
import re
from pathlib import Path
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window

RADIUS_M = 1737400.0
UA = "MOONDAObservatory/0.1 (+https://github.com/hao0x1/3DTilesRendererJS)"
GLOBAL_URL = "https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/JP2/LDEM_80S_80M.JP2"
SITE_REGIONS = [
    ("connecting-ridge", "Connecting ridge", "Site01"),
    ("shackleton-rim", "Shackleton rim", "Site04"),
    ("shackleton-peak", "Peak near Shackleton", "Site07"),
]
# Verified against the GeoTIFF affine metadata from each NASA regional file.
# Explicit cached metadata also avoids making remote requests during this build.
REGION_BOUNDS = {
    "Site01": (-19000.0, -20000.0, -3000.0, -4000.0),
    "Site04": (-9000.0, -15000.0, 7000.0, 1000.0),
    "Site07": (22000.0, -28000.0, 38000.0, -12000.0),
}
ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="90", GDAL_HTTP_USERAGENT=UA)
QUERY_RECORDS = []


def atomic_write(path, content):
    temp = path.with_name(path.name + ".tmp")
    if isinstance(content, bytes):
        temp.write_bytes(content)
    else:
        temp.write_text(content)
    temp.replace(path)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def download(url, path):
    if path.exists() and path.stat().st_size > 1_000_000:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".part")
    for attempt in range(3):
        print("Downloading source", path.name, flush=True)
        try:
            start = temp.stat().st_size if temp.exists() else 0
            headers = {"User-Agent": UA}
            if start:
                headers["Range"] = f"bytes={start}-"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=180) as stream:
                resumed = start > 0 and stream.status == 206
                if resumed:
                    content_range = stream.headers.get("Content-Range", "")
                    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
                    if not match or int(match.group(1)) != start:
                        raise ValueError(f"Server returned an inconsistent range: {content_range}")
                if not resumed:
                    start = 0
                expected = int(stream.headers.get("Content-Length", 0)) + start
                total = start
                out = temp.open("ab" if resumed else "wb")
                while block := stream.read(1024 * 1024):
                    out.write(block)
                    total += len(block)
                out.close()
            if expected and total != expected:
                raise ValueError(f"Incomplete source: {total} / {expected}")
            temp.replace(path)
            return path
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


def stereographic(lon_deg, lat_deg):
    lon = np.radians(lon_deg)
    rho = 2 * RADIUS_M * np.tan((np.pi / 2 + np.radians(lat_deg)) / 2)
    return rho * np.sin(lon), rho * np.cos(lon)


def inverse_stereographic(x, y):
    rho = np.hypot(x, y)
    return np.degrees(np.arctan2(x, y)), np.degrees(2 * np.arctan(rho / (2 * RADIUS_M)) - np.pi / 2)


def destination(lon_deg, lat_deg, bearing_deg, distance_m):
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    b, delta = np.radians(bearing_deg), np.asarray(distance_m) / RADIUS_M
    lat2 = np.arcsin(np.sin(lat) * np.cos(delta) + np.cos(lat) * np.sin(delta) * np.cos(b))
    lon2 = lon + np.arctan2(np.sin(b) * np.sin(delta) * np.cos(lat), np.cos(delta) - np.sin(lat) * np.sin(lat2))
    return np.degrees(lon2), np.degrees(lat2)


def bilinear(a, transform, x, y):
    # Raster affine is defined at pixel corners; sample elevations at centers.
    c = (np.asarray(x) - transform.c) / transform.a - 0.5
    r = (np.asarray(y) - transform.f) / transform.e - 0.5
    valid = (c >= 0) & (r >= 0) & (c < a.shape[1] - 1) & (r < a.shape[0] - 1)
    ci = np.clip(np.floor(c).astype(int), 0, a.shape[1] - 2)
    ri = np.clip(np.floor(r).astype(int), 0, a.shape[0] - 2)
    dc, dr = c - ci, r - ri
    z = a[ri, ci] * (1 - dc) * (1 - dr) + a[ri, ci + 1] * dc * (1 - dr)
    z += a[ri + 1, ci] * (1 - dc) * dr + a[ri + 1, ci + 1] * dc * dr
    return np.where(valid, z, np.nan)


def cache_raster(url, path, *, coarse=False, center_xy=None):
    if path.exists():
        with rasterio.open(path) as d:
            return d.read(1), d.transform
    print("Reading NASA DEM", url, flush=True)
    source = download(url, path.parent / Path(urllib.parse.urlparse(url).path).name)
    with rasterio.Env(**ENV):
        with rasterio.open(source) as d:
            if coarse:
                # PDS label gives signed int16 samples in half meters relative
                # to the 1737.4km reference radius. Keep the native 80m grid.
                a = d.read(1).astype(np.float32) * 0.5
                from affine import Affine
                t = Affine(80, 0, -304000, 0, -80, 304000)
                if a.shape != (7600, 7600):
                    raise ValueError("Unexpected native PDS polar DEM size")
            else:
                if center_xy is None:
                    # Read only the central half's rows. The source is striped,
                    # so remote row ranges are cached rather than the entire file.
                    w = Window(d.width // 4, d.height // 4, d.width // 2, d.height // 2)
                else:
                    col, row = (~d.transform) * center_xy
                    half = 800
                    w = Window(int(col) - half, int(row) - half, 1601, 1601)
                    w = w.intersection(Window(0, 0, d.width, d.height))
                a, t = d.read(1, window=w), d.window_transform(w)
            meta = dict(driver="GTiff", count=1, dtype="float32", height=a.shape[0], width=a.shape[1],
                        crs=d.crs, transform=t, compress="deflate", nodata=float("nan"))
            with rasterio.open(path, "w", **meta) as out:
                out.write(a, 1)
    return a, t


def select_point(a, t):
    # Highest 20-by-20-pixel-bin mean within the supplied selection window,
    # not a NASA-selected landing coordinate. Binning avoids one noisy pixel.
    step = 20
    rows, cols = a.shape[0] // step, a.shape[1] // step
    bins = a[: rows * step, : cols * step].reshape(rows, step, cols, step)
    count = np.sum(np.isfinite(bins), axis=(1, 3))
    means = np.nansum(bins, axis=(1, 3)) / np.maximum(count, 1)
    means[count < step * step * 0.9] = -np.inf
    br, bc = np.unravel_index(np.argmax(means), means.shape)
    row, col = br * step + step / 2, bc * step + step / 2
    return t * (col + 0.5, row + 0.5)


def horizon_from_samples(distance_m, elevations_m, observer_surface_m, observer_height_m=2.0):
    delta = np.asarray(distance_m) / RADIUS_M
    target_r = RADIUS_M + np.asarray(elevations_m)
    vertical = target_r * np.cos(delta) - (RADIUS_M + observer_surface_m + observer_height_m)
    horizontal = target_r * np.sin(delta)
    return np.degrees(np.arctan2(vertical, horizontal))


def horizons(site, terrain_at):
    # Sampling becomes coarser as distance increases. Far terrain comes from
    # an 80m native polar DEM; narrow distant peaks may be underestimated.
    distances = np.unique(np.r_[np.arange(10, 1000, 10), np.arange(1000, 8000, 20),
                                np.arange(8000, 30000, 100), np.arange(30000, 200001, 500)])
    az = np.arange(360)[:, None]
    lon, lat = destination(site["longitudeDeg"], site["latitudeDeg"], az, distances[None, :])
    z = terrain_at(lon, lat)
    if not np.isfinite(z).all():
        raise ValueError("Terrain horizon rays left available terrain coverage")
    angles = horizon_from_samples(distances, z, site["terrain"]["centerHeightM"])
    return np.max(angles, axis=1)


def request_ephemeris(lon, lat, height_m, target, path):
    parameters = dict(format="json", EPHEM_TYPE="'OBSERVER'", CENTER="'coord@301'",
                      COORD_TYPE="'GEODETIC'", SITE_COORD=f"'{lon:.10f},{lat:.10f},{height_m / 1000:.8f}'",
                      START_TIME="'2026-11-01 00:00'", STOP_TIME="'2026-12-01 00:00'", STEP_SIZE="'1 h'",
                      QUANTITIES="'4'", APPARENT="'AIRLESS'", CSV_FORMAT="'YES'", ANG_FORMAT="'DEG'",
                      TIME_DIGITS="'MINUTES'", TIME_TYPE="'UT'", COMMAND=f"'{target}'")
    url = "https://ssd.jpl.nasa.gov/api/horizons.api?" + urllib.parse.urlencode(parameters)
    legacy = path
    path = path.with_name(path.stem + "-" + hashlib.sha256(url.encode()).hexdigest()[:10] + path.suffix)
    response = None
    for candidate in (path, legacy):
        if candidate.exists():
            cached = json.loads(candidate.read_text())
            if cached.get("requestUrl") == url:
                response = cached
                break
    if response is None:
        # Deliberately sequential. Never issue parallel JPL API requests.
        for attempt in range(3):
            try:
                result = subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                                         "--max-time", "100", "--user-agent", UA, url],
                                        check=True, capture_output=True, text=True)
                response = json.loads(result.stdout)
                if "error" in response or "$$SOE" not in response.get("result", ""):
                    raise ValueError(response.get("error", response))
                response["requestUrl"] = url
                path.write_text(json.dumps(response))
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(3 * (attempt + 1))
        time.sleep(1)
    rows = csv.reader(io.StringIO(response["result"].split("$$SOE")[1].split("$$EOE")[0]))
    times, az, el = [], [], []
    for row in rows:
        if not row or not row[0].strip():
            continue
        date = dt.datetime.strptime(row[0].strip(), "%Y-%b-%d %H:%M").replace(tzinfo=dt.timezone.utc)
        times.append(date.isoformat().replace("+00:00", "Z"))
        az.append(float(row[3]))
        el.append(float(row[4]))
    if len(times) != 721:
        raise ValueError(f"Unexpected hourly ephemeris length: {len(times)}")
    QUERY_RECORDS.append({"targetId": target, "requestUrl": url, "signature": response.get("signature"),
                          "resultSha256": hashlib.sha256(response["result"].encode()).hexdigest()})
    return times, az, el


def write_glb(site, output):
    terrain = site["terrain"]
    n, b, z0 = terrain["size"], terrain["bounds"], terrain["centerHeightM"]
    heights = np.asarray(terrain["heightsM"], dtype=float).reshape(n, n)
    xs = np.linspace(b["eastMinM"], b["eastMaxM"], n)
    ns = np.linspace(b["northMaxM"], b["northMinM"], n)
    xx, nn = np.meshgrid(xs, ns)
    distance = np.hypot(xx, nn)
    delta = distance / RADIUS_M
    horizontal = (RADIUS_M + heights) * np.sin(delta)
    ratio = np.divide(horizontal, distance, out=np.ones_like(distance), where=distance > 0)
    # Exact radial-to-local tangent projection for the great-circle samples:
    # x east, y up, z south. Lunar curvature is represented without exaggeration.
    yy = (RADIUS_M + heights) * np.cos(delta) - (RADIUS_M + z0)
    positions = np.stack([xx * ratio, yy, -nn * ratio], axis=-1).astype("<f4").reshape(-1, 3)
    gradient_n, gradient_e = np.gradient(yy, ns, xs)
    normals = np.stack([-gradient_e, np.ones_like(heights), gradient_n], axis=-1)
    normals /= np.linalg.norm(normals, axis=-1, keepdims=True)
    normals = normals.astype("<f4").reshape(-1, 3)
    # Neutral lunar stone color; source is real terrain, colors illustrative.
    shade = np.clip((heights - np.min(heights)) / max(np.ptp(heights), 1), 0, 1)
    colors = np.stack([.22 + shade * .40, .23 + shade * .40, .25 + shade * .42], axis=-1).astype("<f4").reshape(-1, 3)
    indices = []
    for r in range(n - 1):
        for c in range(n - 1):
            a = r * n + c
            indices.extend([a, a + n, a + 1, a + 1, a + n, a + n + 1])
    indices = np.asarray(indices, dtype="<u2")
    blobs, views, offset = [], [], 0
    for array, target in [(positions, 34962), (normals, 34962), (colors, 34962), (indices, 34963)]:
        raw = array.tobytes()
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(raw), "target": target})
        padded = raw + b"\x00" * ((-len(raw)) % 4)
        blobs.append(padded)
        offset += len(padded)
    accessors = []
    for i, array in enumerate([positions, normals, colors]):
        accessor = dict(bufferView=i, componentType=5126, count=len(array), type="VEC3")
        if i == 0:
            accessor.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        accessors.append(accessor)
    accessors.append(dict(bufferView=3, componentType=5123, count=len(indices), type="SCALAR"))
    gltf = {"asset": {"version": "2.0", "generator": "MOONDA NASA LOLA local terrain"},
            "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2},
                                        "indices": 3, "material": 0}]}],
            "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0,
                                                     "roughnessFactor": .95}, "doubleSided": True}],
            "buffers": [{"byteLength": offset}], "bufferViews": views, "accessors": accessors}
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    binary = b"".join(blobs)
    glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary))
    glb += struct.pack("<II", len(js), 0x4E4F534A) + js
    glb += struct.pack("<II", len(binary), 0x004E4942) + binary
    atomic_write(output / "terrain.glb", glb)
    # 3D Tiles uses Z-up tile coordinates; glTF is Y-up. TilesRenderer applies
    # +90deg about X to the glTF, yielding xEast/yNorth/zUp before app placement.
    tile_positions = positions[:, [0, 2, 1]].copy()
    tile_positions[:, 1] *= -1
    lo, hi = tile_positions.min(axis=0), tile_positions.max(axis=0)
    center, half = (lo + hi) / 2, (hi - lo) / 2
    tileset = {"asset": {"version": "1.1"}, "geometricError": 0,
               "root": {"boundingVolume": {"box": [*center.tolist(), float(half[0]), 0, 0, 0, float(half[1]), 0, 0, 0, float(half[2])]},
                        "geometricError": 0, "refine": "REPLACE", "content": {"uri": "terrain.glb"}}}
    atomic_write(output / "tileset.json", json.dumps(tileset, separators=(",", ":")))


def build(cache_dir, output_dir, coarse_only=False):
    cache_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    far, far_t = cache_raster(GLOBAL_URL, cache_dir / "polar-far-80m.tif", coarse=True)
    sites = []
    for ident, name, region in SITE_REGIONS:
        url = f"https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/{region}/{region}_final_adj_5mpp_surf.tif"
        xmin, ymin, xmax, ymax = REGION_BOUNDS[region]
        xmid, ymid = (xmin + xmax) / 2, (ymin + ymax) / 2
        col, row = (~far_t) * (xmid, ymid)
        half = 50
        row, col = int(row), int(col)
        select = far[row-half:row+half, col-half:col+half]
        select_t = far_t * far_t.translation(col-half, row-half)
        # Keep demonstration coordinates stable across resolution upgrades.
        x0, y0 = select_point(select, select_t)
        if coarse_only:
            near, near_t = far, far_t
        else:
            near, near_t = cache_raster(url, cache_dir / f"{region}-near.tif", center_xy=(x0, y0))
        lon0, lat0 = map(float, inverse_stereographic(x0, y0))
        xmin, ymin, xmax, ymax = REGION_BOUNDS[region]
        if not (xmin < x0 < xmax and ymin < y0 < ymax):
            raise ValueError(f"Sample point left its documented region: {region}")

        def terrain_at(lon, lat):
            x, y = stereographic(lon, lat)
            local = bilinear(near, near_t, x, y)
            coarse = bilinear(far, far_t, x, y)
            return np.where(np.isfinite(local), local, coarse)

        z0 = float(terrain_at(lon0, lat0))
        n = 65
        xs = np.linspace(-4000, 4000, n)
        ns = np.linspace(4000, -4000, n)
        xx, nn = np.meshgrid(xs, ns)
        lons, lats = destination(lon0, lat0, np.degrees(np.arctan2(xx, nn)), np.hypot(xx, nn))
        grid = terrain_at(lons, lats)
        if not np.isfinite(grid).all():
            raise ValueError("Non-finite mesh height")
        site = {"id": ident, "name": name, "latitudeDeg": round(lat0, 8), "longitudeDeg": round(lon0, 8),
                "observerHeightM": 2,
                "regionBoundsM": {"projection": "South polar stereographic, radius 1737400m, central meridian 0 degrees", "xMin": xmin, "yMin": ymin, "xMax": xmax, "yMax": ymax},
                "description": f"Demonstration high-ground sample within NASA PGDA {region}; not an approved landing point.",
                "terrain": {"size": n, "bounds": {"eastMinM": -4000, "eastMaxM": 4000, "northMinM": -4000, "northMaxM": 4000},
                            "heightsM": np.round(grid, 2).ravel().tolist(), "referenceRadiusM": RADIUS_M,
                            "centerHeightM": round(z0, 3), "tilesetUrl": f"./data/{ident}/tileset.json",
                            "coordinateFrame": "Grid bounds are east/north great-circle arc offsets. Rows run north to south. GLB x=east, y=up, z=south in local tangent frame, including spherical curvature; no vertical exaggeration.",
                            "heightReference": "heightsM are absolute radial surface elevations in meters relative to a 1737400m sphere, not local mesh y coordinates."},
                "provenance": [
                    {"title": f"NASA LOLA 5 m {region} DEM", "url": url, "detail": "Surface heights in meters above 1737.4 km reference sphere; DE421 mean-Earth frame."},
                    {"title": "NASA high-resolution south-pole site documentation", "url": "https://pgda.gsfc.nasa.gov/products/78"},
                    {"title": "NASA PDS 80 m south-polar LOLA topography", "url": GLOBAL_URL, "detail": "Native 80 m signed half-meter PDS product; heights relative to 1737.4 km reference radius."},
                    {"title": "PDS DEM scaling and projection label", "url": "https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/JP2/LDEM_80S_80M_JP2.LBL"},
                    {"title": "NASA/JPL Horizons", "url": "https://ssd.jpl.nasa.gov/horizons/", "detail": "Airless apparent Sun/Earth center azimuth and elevation from coord@301; observer height includes DEM surface elevation."}],
                "limitations": [
                    "Sample point chosen from a high 1.6 km-bin mean of the native 80 m DEM within the central half of a named NASA region; not a NASA-approved landing coordinate.",
                    "Horizon is sampled every 1 degree in azimuth and to 200 km range; narrow ridges between rays may be missed.",
                    "Near terrain uses 5 m source data; far terrain uses an 80 m grid and may underestimate narrow peaks.",
                    "Sun and Earth center visibility only; not a confirmed ground-station radio link or electrical-power estimate.",
                    "Hourly time sampling limits event timing; verify and refine near horizon crossings.",
                    "NASA's documented lunar mean-Earth coordinate convention is used; independent alignment checks and elevation uncertainty propagation remain future validation work.",
                    "The local 3D mesh is resampled to 125 m spacing and only spans 8 km; the horizon profile uses terrain out to 200 km."]}
        if coarse_only:
            site["description"] = f"80 m DEM demonstration sample within NASA PGDA {region} bounds; not an approved landing point."
            site["provenance"][0]["title"] = f"NASA PGDA {region} region definition"
            site["provenance"][0]["detail"] = "Regional bounds used to select demonstration area; this first build uses the PDS 80 m DEM throughout."
            site["limitations"][0] = "Sample point selected from the native 80 m DEM within the central portion of a named NASA region; not an approved landing coordinate."
            site["limitations"][2] = "All terrain currently uses an 80 m grid; narrow features below that resolution may be missed."
        profile = horizons(site, terrain_at)
        site["horizon"] = {"azimuthStepDeg": 1, "elevationDeg": np.round(profile, 4).tolist(), "maxRangeKm": 200,
                           "terrainResolutionM": 80, "nearTerrainResolutionM": 80 if coarse_only else 5,
                           "farTerrainResolutionM": 80,
                           "method": ("Spherical line-of-sight, 2 m observer; native 80 m terrain; 1 degree bearing sampling." if coarse_only else
                                      "Spherical line-of-sight, 2 m observer; 5 m near-field DEM, native 80 m far-field terrain; 1 degree bearing sampling.")}
        print("SITE", name, site["latitudeDeg"], site["longitudeDeg"], "height", z0, "horizon range", float(profile.min()), float(profile.max()), flush=True)
        ts, saz, sel = request_ephemeris(lon0, lat0, z0 + 2, 10, cache_dir / f"{ident}-sun.json")
        te, eaz, eel = request_ephemeris(lon0, lat0, z0 + 2, 399, cache_dir / f"{ident}-earth.json")
        if ts != te:
            raise ValueError("Sun/Earth epochs differ")
        site["ephemeris"] = {"timesUtc": ts, "sunAzDeg": saz, "sunElDeg": sel, "earthAzDeg": eaz, "earthElDeg": eel}
        target = output_dir / ident
        target.mkdir(exist_ok=True)
        write_glb(site, target)
        sites.append(site)
    document = {"generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "version": "0.1.0",
                "description": "Local NASA LOLA terrain and NASA/JPL Horizons demonstration; 2026-11-01 through 2026-12-01 UTC.",
                "sites": sites, "limitations": [
                    "This prototype estimates geometric visibility at demonstration points, not flight-certified landing suitability.",
                    "A textured global Moon is illustrative. Numeric terrain analysis uses the cited elevation data.",
                    "All runtime data is packaged locally; no NASA API request is made while scrubbing the timeline."]}
    path = output_dir / "observatory.json"
    atomic_write(path, json.dumps(document, separators=(",", ":"), allow_nan=False))
    source_urls = [GLOBAL_URL]
    if not coarse_only:
        source_urls += [f"https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/{region}/{region}_final_adj_5mpp_surf.tif"
                        for _, _, region in SITE_REGIONS]
    sources = []
    for url in source_urls:
        raw_path = cache_dir / Path(urllib.parse.urlparse(url).path).name
        sources.append({"url": url, "filename": raw_path.name, "bytes": raw_path.stat().st_size,
                        "sha256": file_hash(raw_path)})
    manifest = {"generatedAt": document["generatedAt"], "generatorSha256": file_hash(Path(__file__)),
                "terrainBuild": "80m throughout" if coarse_only else "5m near-field plus 80m far-field",
                "sources": sources, "horizonsQueries": QUERY_RECORDS,
                "outputSha256": file_hash(path)}
    atomic_write(output_dir / "science-manifest.json", json.dumps(manifest, indent=2))
    print("WROTE", path, path.stat().st_size, "bytes", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "public" / "data")
    parser.add_argument("--coarse-only", action="store_true", help="Build a valid native 80m initial dataset before downloading 5m regional sources")
    parser.add_argument("--prefetch-regions", action="store_true", help="Download the three independent regional terrain files concurrently; JPL API queries remain sequential")
    args = parser.parse_args()
    if args.prefetch_regions and not args.coarse_only:
        from concurrent.futures import ThreadPoolExecutor
        def prefetch_region(region):
            url = f"https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/{region}/{region}_final_adj_5mpp_surf.tif"
            return download(url, args.cache_dir.resolve() / f"{region}_final_adj_5mpp_surf.tif")
        with ThreadPoolExecutor(max_workers=3) as executor:
            list(executor.map(prefetch_region, [region for _, _, region in SITE_REGIONS]))
    build(args.cache_dir.resolve(), args.output_dir.resolve(), args.coarse_only)
