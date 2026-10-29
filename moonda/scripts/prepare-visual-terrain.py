#!/usr/bin/env python3
"""Prepare optional progressive LOLA terrain without changing science data.

Run from moonda with the existing data-requirements.txt Python environment:
  python scripts/prepare-visual-terrain.py --cache-dir ../../research/terrain-build/raw
  python scripts/prepare-visual-terrain.py --verify-only

No downloads, API requests, synthetic relief, or vertical exaggeration. The
cached original 5 m regional DEMs and the cached scaled 80 m polar DEM are used.
Only public/visuals/terrain/ and public/visuals/terrain.json are written.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import struct

import numpy as np
import rasterio


APP = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("moonda_science_data", APP / "scripts/generate-data.py")
SCIENCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCIENCE)
RADIUS_M = SCIENCE.RADIUS_M
GRID_SIZE = 129
EXTENT_M = 81920.0
FAR_LEVEL = 3
FINE_LEVEL = 6
REGIONS = {ident: region for ident, _, region in SCIENCE.SITE_REGIONS}


def json_bytes(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode()


def write(path, contents):
    path.parent.mkdir(parents=True, exist_ok=True)
    SCIENCE.atomic_write(path, contents)


def baseline_pins():
    return {str(p.relative_to(APP)): SCIENCE.file_hash(p) for p in sorted((APP / "public/data").rglob("*")) if p.is_file()}


def read_raster(path):
    if not path.is_file():
        raise FileNotFoundError(f"Required cached DEM is missing: {path}; this script does not download files")
    with rasterio.open(path) as source:
        return source.read(1), source.transform


class TerrainSampler:
    def __init__(self, site, near, near_transform, far, far_transform):
        self.site = site
        self.near, self.near_transform = near, near_transform
        self.far, self.far_transform = far, far_transform
        self.center_height = site["terrain"]["centerHeightM"]

    def sample(self, east, north):
        distance = np.hypot(east, north)
        bearing = np.degrees(np.arctan2(east, north))
        lon, lat = SCIENCE.destination(self.site["longitudeDeg"], self.site["latitudeDeg"], bearing, distance)
        x, y = SCIENCE.stereographic(lon, lat)
        local = SCIENCE.bilinear(self.near, self.near_transform, x, y)
        coarse = SCIENCE.bilinear(self.far, self.far_transform, x, y)
        native_fine = np.isfinite(local)
        height = np.where(native_fine, local, coarse)
        if not np.isfinite(height).all():
            raise ValueError("Visual terrain extends outside valid source DEM coverage")
        return height, lon, lat, native_fine

    def positions(self, east, north):
        height, lon, lat, native_fine = self.sample(east, north)
        distance = np.hypot(east, north)
        delta = distance / RADIUS_M
        ratio = np.ones_like(distance, dtype=float)
        np.divide((RADIUS_M + height) * np.sin(delta), distance, out=ratio, where=distance > 0)
        up = (RADIUS_M + height) * np.cos(delta) - (RADIUS_M + self.center_height)
        position = np.stack([east * ratio, up, -north * ratio], axis=-1)
        return position, height, lon, lat, native_fine

    def normals(self, east, north, step):
        # Common global neighbours give identical normals along same-LOD edges.
        # Cross(dP/deast,dP/dnorth) points up in xEast/yUp/zSouth coordinates.
        tangent_e = self.positions(east + step, north)[0] - self.positions(east - step, north)[0]
        tangent_n = self.positions(east, north + step)[0] - self.positions(east, north - step)[0]
        normal = np.cross(tangent_e, tangent_n)
        normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
        return normal


def mesh_arrays(sampler, bounds, spacing):
    emin, emax, nmin, nmax = bounds
    east, north = np.meshgrid(np.linspace(emin, emax, GRID_SIZE), np.linspace(nmax, nmin, GRID_SIZE))
    position, height, lon, lat, native_fine = sampler.positions(east, north)
    normal_step = max(5.0, min(spacing / 2, 80.0))
    normal = sampler.normals(east, north, normal_step)
    # Destination longitudes may extend beyond [-180,180] around the pole.
    uv = np.stack([(lon / 360 + .5) % 1, lat / 180 + .5], axis=-1)
    position, normal, uv = [a.reshape(-1, a.shape[-1]) for a in (position, normal, uv)]
    n = GRID_SIZE
    a = (np.arange(n - 1)[:, None] * n + np.arange(n - 1)[None, :]).ravel()
    indices = np.stack([a, a + n, a + 1, a + 1, a + n, a + n + 1], axis=-1).reshape(-1, 3)

    # Skirts hide cracks when neighbouring tiles are displayed at different LODs.
    # They are display-only and never enter science horizon calculations.
    edge = np.r_[np.arange(n), np.arange(1, n) * n + n - 1,
                 (n - 1) * n + np.arange(n - 2, -1, -1), np.arange(n - 2, 0, -1) * n]
    lower = position[edge].copy()
    skirt_depth = max(8.0, min(spacing / 2, 160.0))
    lower[:, 1] -= skirt_depth
    edge_normal = lower.copy()
    edge_normal[:, 0] -= (emin + emax) / 2
    edge_normal[:, 1] = 0
    edge_normal[:, 2] += (nmin + nmax) / 2
    edge_normal /= np.linalg.norm(edge_normal, axis=-1, keepdims=True)
    skirt_index = np.arange(len(edge)) + len(position)
    following = np.roll(np.arange(len(edge)), -1)
    skirt_faces = np.stack([edge, edge[following], skirt_index, edge[following], skirt_index[following], skirt_index], axis=-1).reshape(-1, 3)
    position = np.r_[position, lower]
    normal = np.r_[normal, edge_normal]
    uv = np.r_[uv, uv[edge]]
    indices = np.r_[indices, skirt_faces]

    # Equirectangular textures repeat in U. Duplicate only seam-crossing vertices
    # so triangles interpolate across U=1 rather than across the whole atlas.
    us = uv[indices, 0]
    crossing = np.ptp(us, axis=1) > .5 + 1e-10
    face_ids = np.flatnonzero(crossing)
    seam_map = {}
    extra_position, extra_normal, extra_uv = [], [], []
    for face_id in face_ids:
        for corner in range(3):
            original = int(indices[face_id, corner])
            if uv[original, 0] < .5:
                if original not in seam_map:
                    seam_map[original] = len(position) + len(extra_position)
                    extra_position.append(position[original])
                    extra_normal.append(normal[original])
                    shifted_uv = uv[original].copy()
                    shifted_uv[0] += 1
                    extra_uv.append(shifted_uv)
                indices[face_id, corner] = seam_map[original]
    if extra_position:
        position = np.r_[position, extra_position]
        normal = np.r_[normal, extra_normal]
        uv = np.r_[uv, extra_uv]
    if len(position) > 65535:
        raise ValueError("Tile exceeds unsigned-short index range")
    return position, normal, uv, indices.astype("<u2").ravel(), {
        "surfaceVertexCount": n * n, "gridSize": n, "meshSpacingM": spacing,
        "skirtDepthM": skirt_depth, "normalStepM": normal_step,
        "native5mVertexFraction": round(float(np.mean(native_fine)), 5),
        "sourceResolutionM": 5 if native_fine.all() else 80,
        "sourceMinResolutionM": 5 if native_fine.any() else 80,
        "sourceMaxResolutionM": 5 if native_fine.all() else 80,
    }


def glb_bytes(position, normal, uv, indices, extras):
    # One origin for every mesh is essential for shared GPU vertices. Per-tile
    # origins can produce exact world edges yet round differently after their
    # model-view translations are converted to float32 at noninteger cameras.
    # This common local site frame spans only +/-40.96km, so float32 retains
    # millimetre precision at its edge and much finer precision near the point.
    center = np.zeros(3)
    packed_position = (position - center).astype("<f4")
    packed_normal = np.zeros((len(normal), 4), dtype="i1")
    packed_normal[:, :3] = np.clip(np.rint(normal * 127), -127, 127).astype("i1")
    uv = uv.astype("<f4")
    blobs, views, offset = [], [], 0
    for array, target, stride in [(packed_position, 34962, 12), (packed_normal, 34962, 4),
                                  (uv, 34962, 8), (indices, 34963, None)]:
        raw = array.tobytes()
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(raw), "target": target}
        if stride:
            view["byteStride"] = stride
        views.append(view)
        padded = raw + b"\0" * (-len(raw) % 4)
        blobs.append(padded)
        offset += len(padded)
    accessors = [
        {"bufferView": 0, "componentType": 5126, "count": len(position), "type": "VEC3",
         "min": packed_position.min(axis=0).tolist(), "max": packed_position.max(axis=0).tolist()},
        {"bufferView": 1, "componentType": 5120, "normalized": True, "count": len(normal), "type": "VEC3"},
        {"bufferView": 2, "componentType": 5126, "count": len(uv), "type": "VEC2"},
        {"bufferView": 3, "componentType": 5123, "count": len(indices), "type": "SCALAR"},
    ]
    decoded = packed_position.astype(float) + center
    encoding_error = float(np.max(np.abs(decoded - position)))
    extras.update(maxPositionEncodingErrorM=encoding_error,
                  positionEncoding="FLOAT32 common site-frame metres; identical zero-translation nodes, no position quantization or scale",
                  normalEncoding="Normalized signed int8; KHR_mesh_quantization applies to normals only", verticalScale=1,
                  gltfCoordinateFrame="xEast/yUp/zSouth, relative to fixed site surface origin")
    gltf = {
        "asset": {"version": "2.0", "generator": "MOONDA optional NASA LOLA visual terrain v2"},
        "extensionsUsed": ["KHR_mesh_quantization"], "extensionsRequired": ["KHR_mesh_quantization"],
        "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "translation": center.tolist()}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}, "indices": 3, "material": 0}], "extras": extras}],
        "materials": [{"name": "Lunar regolith display material", "pbrMetallicRoughness": {
            "baseColorFactor": [.38, .39, .4, 1], "metallicFactor": 0, "roughnessFactor": 1}, "doubleSided": True}],
        "buffers": [{"byteLength": offset}], "bufferViews": views, "accessors": accessors,
    }
    js = json_bytes(gltf)
    js += b" " * (-len(js) % 4)
    binary = b"".join(blobs)
    contents = struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(binary))
    contents += struct.pack("<II", len(js), 0x4E4F534A) + js
    contents += struct.pack("<II", len(binary), 0x004E4942) + binary
    return contents, decoded


def box_for(lo, hi):
    center, half = (lo + hi) / 2, (hi - lo) / 2
    return {"box": [*center.tolist(), float(half[0]), 0, 0, 0, float(half[1]), 0, 0, 0, float(half[2])]}


def should_split(level, bounds):
    if level < FAR_LEVEL:
        return True
    emin, emax, nmin, nmax = bounds
    return level < FINE_LEVEL and emin <= 0 <= emax and nmin <= 0 <= nmax


def build_node(sampler, output_dir, level, column, row, bounds, inventory):
    extent = bounds[1] - bounds[0]
    spacing = extent / (GRID_SIZE - 1)
    position, normal, uv, indices, extras = mesh_arrays(sampler, bounds, spacing)
    extras.update(level=level, bounds={"eastMinM": bounds[0], "eastMaxM": bounds[1], "northMinM": bounds[2], "northMaxM": bounds[3]})
    contents, decoded = glb_bytes(position, normal, uv, indices, extras)
    filename = f"{level}-{column}-{row}.glb"
    write(output_dir / filename, contents)
    inventory.append({"url": f"./visuals/terrain/{sampler.site['id']}/{filename}", "bytes": len(contents),
                      "sha256": hashlib.sha256(contents).hexdigest()})
    # Standard glTF Y-up -> standard 3D Tiles Z-up: [east,north,up].
    tile_positions = decoded[:, [0, 2, 1]].copy()
    tile_positions[:, 1] *= -1
    lo, hi = tile_positions.min(axis=0) - .01, tile_positions.max(axis=0) + .01
    content_bounds = box_for(lo, hi)
    children = []
    error = 0.0
    if should_split(level, bounds):
        emin, emax, nmin, nmax = bounds
        emid, nmid = (emin + emax) / 2, (nmin + nmax) / 2
        for subrow, (snmin, snmax) in enumerate([(nmid, nmax), (nmin, nmid)]):
            for subcol, (semin, semax) in enumerate([(emin, emid), (emid, emax)]):
                child, child_lo, child_hi = build_node(sampler, output_dir, level + 1, column * 2 + subcol,
                    row * 2 + subrow, (semin, semax, snmin, snmax), inventory)
                children.append(child)
                lo, hi = np.minimum(lo, child_lo), np.maximum(hi, child_hi)
        error = spacing * .75
    node = {"boundingVolume": box_for(lo, hi), "geometricError": error, "refine": "REPLACE",
            "content": {"uri": filename, "boundingVolume": content_bounds}, "extras": extras}
    if children:
        node["children"] = children
    return node, lo, hi


def fallback(sampler):
    n = 65
    east, north = np.meshgrid(np.linspace(-EXTENT_M / 2, EXTENT_M / 2, n), np.linspace(EXTENT_M / 2, -EXTENT_M / 2, n))
    heights = sampler.sample(east, north)[0]
    return {"size": n, "bounds": {"eastMinM": -EXTENT_M / 2, "eastMaxM": EXTENT_M / 2,
            "northMinM": -EXTENT_M / 2, "northMaxM": EXTENT_M / 2},
            "heightsM": np.round(heights, 2).ravel().tolist(), "referenceRadiusM": RADIUS_M,
            "centerHeightM": sampler.center_height}


def build(cache_dir):
    pins = baseline_pins()
    data = json.loads((APP / "public/data/observatory.json").read_text())
    output_dir = APP / "public/visuals/terrain"
    far_path = cache_dir / "polar-far-80m.tif"
    far, far_transform = read_raster(far_path)
    if tuple(far.shape) != (7600, 7600) or far_transform.a != 80:
        raise ValueError("Expected the previously scaled native 80 m polar cache")
    manifest = {
        "version": "visual-v2", "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "description": "Optional progressive terrain for exploration; fixed scientific observers and cached analyses are unchanged.",
        "referenceRadiusM": RADIUS_M, "verticalScale": 1, "sciencePins": pins,
        "positionEncoding": "FLOAT32 common site-frame metres; identical zero-translation nodes; normals remain normalized int8",
        "coordinateFrame": "GLB xEast/yUp/zSouth relative to fixed site surface height; standard 3D Tiles bounding volumes xEast/yNorth/zUp. Renderer group rotates -pi/2 about X after glTF Y-up conversion.",
        "boundsCoordinateFrame": "East/north great-circle arc offsets in metres, with grid rows north to south; GLB vertices are exact radial-to-local-tangent projections, not flat map offsets.",
        "sources": [{"file": far_path.name, "bytes": far_path.stat().st_size, "sha256": SCIENCE.file_hash(far_path),
                     "url": SCIENCE.GLOBAL_URL, "detail": "Scaled cache: PDS signed half-meter values multiplied by 0.5; 80 m native grid; heights relative to a 1737400 m sphere."}],
        "sites": {}, "assets": [],
    }
    for site in data["sites"]:
        region = REGIONS[site["id"]]
        near_path = cache_dir / f"{region}_final_adj_5mpp_surf.tif"
        near, near_transform = read_raster(near_path)
        if near_transform.a != 5 or tuple(near.shape) != (3200, 3200):
            raise ValueError("Expected the original 16km-square 5 m regional DEM")
        sampler = TerrainSampler(site, near, near_transform, far, far_transform)
        point_height = float(sampler.sample(np.asarray(0.), np.asarray(0.))[0])
        if abs(point_height - sampler.center_height) > .02:
            raise ValueError("Visual and science terrain origins disagree")
        target = output_dir / site["id"]
        assets = []
        root, _, _ = build_node(sampler, target, 0, 0, 0, (-EXTENT_M / 2, EXTENT_M / 2, -EXTENT_M / 2, EXTENT_M / 2), assets)
        tileset = {"asset": {"version": "1.1", "gltfUpAxis": "Y"}, "geometricError": root["geometricError"], "root": root,
                   "extras": {"scienceSiteId": site["id"], "referenceRadiusM": RADIUS_M, "verticalScale": 1,
                              "heightDatum": "Radial surface elevations above a 1737400 m sphere", "sourceFrame": "Moon mean Earth/DE421"}}
        tileset_contents = json_bytes(tileset)
        write(target / "tileset.json", tileset_contents)
        assets.append({"url": f"./visuals/terrain/{site['id']}/tileset.json", "bytes": len(tileset_contents),
                       "sha256": hashlib.sha256(tileset_contents).hexdigest()})
        near_url = f"https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/{region}/{near_path.name}"
        manifest["sources"].append({"file": near_path.name, "bytes": near_path.stat().st_size,
            "sha256": SCIENCE.file_hash(near_path), "url": near_url,
            "detail": "Original 5 m NASA PGDA surface heights in metres above a 1737400 m sphere; Moon mean Earth/DE421."})
        grid = fallback(sampler)
        manifest["sites"][site["id"]] = {
            "tilesetUrl": f"./visuals/terrain/{site['id']}/tileset.json", "bounds": grid["bounds"],
            "origin": {"latitudeDeg": site["latitudeDeg"], "longitudeDeg": site["longitudeDeg"], "centerHeightM": sampler.center_height},
            "levels": [{"level": level, "spacingM": EXTENT_M / 2**level / (GRID_SIZE - 1), "extentM": EXTENT_M / 2**level} for level in range(FINE_LEVEL + 1)],
            "highDetailBounds": {"eastMinM": -2560, "eastMaxM": 2560, "northMinM": -2560, "northMaxM": 2560},
            "source": {"title": f"NASA LOLA 5 m {region} with 80 m polar context", "url": near_url,
                       "detail": "Real 5 m regional surface heights where available, native 80 m elsewhere. Geometry sample spacing varies with the displayed LOD."},
            "fallback": grid, "tileCount": len(assets) - 1, "totalBytes": sum(asset["bytes"] for asset in assets),
            "limitations": [
                "Exploration geometry only: moving the camera does not move the fixed scientific observer or recompute cached horizons.",
                "Regional 5 m data has finite coverage; missing or outside samples use 80 m polar data. Source-product boundaries may differ slightly.",
                "The finest 10 m mesh is confined to a 5.12 km square near the fixed point; wider context refines to 80 m. Initial LOD is coarser while detail loads.",
                "Finite 81.92 km patch (40.96 km cardinal range); scientific horizon rays extend to 200 km, so distant numeric obstructions need not appear in this mesh. Standard spherical curvature, no vertical exaggeration; display-only skirts hide LOD cracks.",
                "Common-site-frame float32 positions have bounded display rounding; none of these meshes replace the scientific DEM or horizon cache.",
            ],
        }
        manifest["assets"].extend(assets)
        print(f"Prepared {site['id']}: {len(assets) - 1} tiles, {manifest['sites'][site['id']]['totalBytes']:,} bytes", flush=True)
    if baseline_pins() != pins:
        raise ValueError("Science baseline changed during visual generation; refusing to publish visual manifest")
    manifest["totalBytes"] = sum(asset["bytes"] for asset in manifest["assets"])
    write(APP / "public/visuals/terrain.json", json_bytes(manifest))
    verify()


def decode_glb(path):
    raw = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", raw)
    assert magic == 0x46546C67 and version == 2 and length == len(raw)
    json_length, kind = struct.unpack_from("<II", raw, 12)
    assert kind == 0x4E4F534A
    doc = json.loads(raw[20:20 + json_length])
    bin_length, kind = struct.unpack_from("<II", raw, 20 + json_length)
    assert kind == 0x004E4942
    binary = raw[28 + json_length:]
    assert len(binary) == bin_length
    arrays = []
    for accessor in doc["accessors"]:
        view = doc["bufferViews"][accessor["bufferView"]]
        dtype = {5120: "i1", 5122: "<i2", 5123: "<u2", 5126: "<f4"}[accessor["componentType"]]
        dims = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[accessor["type"]]
        stride = view.get("byteStride", np.dtype(dtype).itemsize * dims)
        assert view["byteOffset"] % 4 == 0
        if view.get("target") == 34962:
            assert stride % 4 == 0
        a = np.ndarray((accessor["count"], dims), dtype=dtype, buffer=binary, offset=view["byteOffset"], strides=(stride, np.dtype(dtype).itemsize)).copy()
        if "min" in accessor:
            assert np.array_equal(a.min(axis=0), accessor["min"])
            assert np.array_equal(a.max(axis=0), accessor["max"])
        if accessor.get("normalized"):
            divisor = {5120: 127, 5122: 32767}[accessor["componentType"]]
            a = np.maximum(a.astype(float) / divisor, -1)
        arrays.append(a)
    position = arrays[0].astype(float) * doc["nodes"][0].get("scale", [1, 1, 1]) + doc["nodes"][0]["translation"]
    return doc, position, arrays[1], arrays[2], arrays[3].ravel()


def unbox(box):
    b = np.asarray(box)
    assert np.all(b[[4, 5, 6, 8, 9, 10]] == 0)
    center, half = b[:3], b[[3, 7, 11]]
    return center - half, center + half


def verify():
    manifest = json.loads((APP / "public/visuals/terrain.json").read_text())
    assert baseline_pins() == manifest["sciencePins"], "Science baseline was modified"
    source_data = json.loads((APP / "public/data/observatory.json").read_text())
    assert set(manifest["sites"]) == {s["id"] for s in source_data["sites"]}
    assets = {a["url"]: a for a in manifest["assets"]}
    for asset in assets.values():
        path = APP / "public" / asset["url"].removeprefix("./")
        assert path.stat().st_size == asset["bytes"]
        assert SCIENCE.file_hash(path) == asset["sha256"]
    max_error, count, fine_count = 0., 0, 0
    edge_data = {}

    def check_node(node, directory, center_height):
        nonlocal max_error, count, fine_count
        lo, hi = unbox(node["boundingVolume"]["box"])
        doc, position, normal, uv, indices = decode_glb(directory / node["content"]["uri"])
        assert doc["extensionsRequired"] == ["KHR_mesh_quantization"]
        assert doc["accessors"][0]["componentType"] == 5126
        assert not doc["accessors"][0].get("normalized", False)
        assert "scale" not in doc["nodes"][0], "FLOAT32 positions must have no decode scale"
        assert doc["nodes"][0]["translation"] == [0, 0, 0], "Every tile must share the fixed site origin"
        assert np.isfinite(position).all() and np.isfinite(normal).all() and np.isfinite(uv).all()
        assert indices.max() < len(position)
        assert np.min(np.linalg.norm(normal, axis=1)) > .99
        assert np.max(np.linalg.norm(normal, axis=1)) < 1.01
        extras = node["extras"]
        assert extras["verticalScale"] == 1
        max_error = max(max_error, extras["maxPositionEncodingErrorM"])
        assert extras["maxPositionEncodingErrorM"] < .005
        tile_position = position[:, [0, 2, 1]] * [1, -1, 1]
        assert np.all(tile_position >= lo - 1e-6) and np.all(tile_position <= hi + 1e-6)
        content_lo, content_hi = unbox(node["content"]["boundingVolume"]["box"])
        assert np.all(tile_position >= content_lo - 1e-6) and np.all(tile_position <= content_hi + 1e-6)
        n = extras["gridSize"]
        grid = position[:n*n].reshape(n, n, 3)
        b = extras["bounds"]
        edge_key = tuple(b[key] for key in ("eastMinM", "eastMaxM", "northMinM", "northMaxM"))
        edge_data.setdefault(directory.name, {}).setdefault(extras["level"], {})[edge_key] = {
            "north": grid[0].copy(), "south": grid[-1].copy(), "west": grid[:, 0].copy(), "east": grid[:, -1].copy()}
        surface_faces = indices[:(n - 1)**2 * 6].reshape(-1, 3)
        p = position[surface_faces]
        cross = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
        assert np.min(cross[:, 1]) > 0, "Terrain triangle winding must face up"
        assert np.min(normal[:n*n, 1]) > 0, "Surface normals must face up"
        assert np.max(np.ptp(uv[indices.reshape(-1, 3), 0], axis=1)) < .50001, "UV seam must not stretch across the lunar atlas"
        if extras["level"] == FINE_LEVEL:
            assert extras["meshSpacingM"] == 10
            assert extras["sourceMaxResolutionM"] == 5
            assert extras["maxPositionEncodingErrorM"] < .00025
            fine_count += 1
        children = node.get("children", [])
        if children:
            assert len(children) == 4, "Every replacement tile needs all four child quadrants"
            b = extras["bounds"]
            emid = (b["eastMinM"] + b["eastMaxM"]) / 2
            nmid = (b["northMinM"] + b["northMaxM"]) / 2
            expected = {(emin, emax, nmin, nmax) for emin, emax in [(b["eastMinM"], emid), (emid, b["eastMaxM"])]
                        for nmin, nmax in [(b["northMinM"], nmid), (nmid, b["northMaxM"])]}
            actual = {tuple(c["extras"]["bounds"][key] for key in ("eastMinM", "eastMaxM", "northMinM", "northMaxM")) for c in children}
            assert actual == expected, "Child tiles must cover their parent without gaps"
        for child in children:
            child_lo, child_hi = unbox(child["boundingVolume"]["box"])
            assert np.all(child_lo >= lo - 1e-6) and np.all(child_hi <= hi + 1e-6)
            assert node["geometricError"] >= child["geometricError"]
            check_node(child, directory, center_height)
        count += 1

    for site in source_data["sites"]:
        visual = manifest["sites"][site["id"]]
        assert visual["origin"] == {"latitudeDeg": site["latitudeDeg"], "longitudeDeg": site["longitudeDeg"], "centerHeightM": site["terrain"]["centerHeightM"]}
        tileset_path = APP / "public" / visual["tilesetUrl"].removeprefix("./")
        tileset = json.loads(tileset_path.read_text())
        assert tileset["asset"]["version"] == "1.1"
        assert len(visual["fallback"]["heightsM"]) == 65**2
        check_node(tileset["root"], tileset_path.parent, visual["origin"]["centerHeightM"])
    edge_report = {}
    finest_max_gap = 0.
    gpu_max_gap = 0.
    bitwise_edge_pairs = 0
    camera_cases = [([16.125, 9.375, 18.1], 37.25, -12.5),
                    ([-5.3, 2.05, 13.7], -23.75, 6.2),
                    ([0.03125, 2.125, -16.1], 114.3, -4.125)]

    def camera_space_float32(vertices, case):
        camera, yaw_deg, pitch_deg = case
        yaw, pitch = np.radians([yaw_deg, pitch_deg])
        cy, sy, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
        rotation = np.array([[cy, 0, -sy], [sy * sp, cp, cy * sp], [sy * cp, -sp, cy * cp]])
        translation = (-rotation @ np.asarray(camera)).astype("<f4")
        rotation = rotation.astype("<f4")
        p = vertices.astype("<f4")
        # Explicit float32 products and additions emulate shader arithmetic.
        return np.stack([((p[:, 0] * row[0] + p[:, 1] * row[1]) + p[:, 2] * row[2]) + translation[i]
                         for i, row in enumerate(rotation)], axis=1).astype("<f4")

    def check_shared_edge(a, b):
        nonlocal gpu_max_gap, bitwise_edge_pairs
        assert np.array_equal(a.astype("<f4").view("<u4"), b.astype("<f4").view("<u4")), "Shared POSITION values must match bit for bit"
        for case in camera_cases:
            ca, cb = camera_space_float32(a, case), camera_space_float32(b, case)
            assert np.array_equal(ca.view("<u4"), cb.view("<u4")), "Shared camera-space vertices must match bit for bit"
            gpu_max_gap = max(gpu_max_gap, float(np.max(np.linalg.norm(ca.astype(float) - cb.astype(float), axis=1))))
        bitwise_edge_pairs += 1
        return float(np.max(np.linalg.norm(a - b, axis=1)))

    for ident, levels in edge_data.items():
        edge_report[ident] = {}
        for level, tiles in levels.items():
            gaps = []
            for (emin, emax, nmin, nmax), edges in tiles.items():
                extent = emax - emin
                east_neighbour = tiles.get((emax, emax + extent, nmin, nmax))
                south_neighbour = tiles.get((emin, emax, nmin - extent, nmin))
                if east_neighbour:
                    gaps.append(check_shared_edge(edges["east"], east_neighbour["west"]))
                if south_neighbour:
                    gaps.append(check_shared_edge(edges["south"], south_neighbour["north"]))
            maximum = max(gaps, default=0.)
            assert maximum < .005, "Same-level float32 edge gap exceeds5mm"
            if level == FINE_LEVEL:
                assert maximum < .00015, "Near observer float32 tile edges must agree within0.15mm"
                finest_max_gap = max(finest_max_gap, maximum)
            edge_report[ident][level] = {"adjacentEdgePairs": len(gaps), "maximumWorldEdgeGapM": maximum}
    old_origin_0 = np.float32(-18.1)
    old_origin_1280 = np.float32(np.float32(1280 - 18.1) + np.float32(-1280))
    regression_gap = float(abs(old_origin_0 - old_origin_1280))
    assert regression_gap > 0, "The regression example must reproduce differing per-tile model-view rounding"
    report = {"tilesChecked": count, "finest10mTiles": fine_count, "maxPositionEncodingErrorM": max_error,
              "positionEncoding": "FLOAT32 common site-frame metres with identical zero-translation nodes", "maxFinestTileEdgeGapM": finest_max_gap,
              "gpuPrecision": {"bitwiseEqualAdjacentEdgePairs": bitwise_edge_pairs, "nonintegerCameraCases": camera_cases,
                               "maximumEmulatedCameraSpaceGapM": gpu_max_gap,
                               "priorPerTileOriginRegressionGapM": regression_gap},
              "sameLevelEdgeConsistency": edge_report,
              "scienceBaselineUnchanged": True, "totalBytes": manifest["totalBytes"],
              "checks": ["science hashes", "all asset hashes", "GLB structure/accessor alignment", "finite geometry",
                         "outward triangle winding", "upward surface normals", "Z-up content bounds", "descendant bounds",
                         "monotone LOD error", "complete child coverage", "wrapped lunar albedo UVs", "10 m near-point geometry from 5 m source",
                         "float32 common-site-frame positions", "position encoding bounds", "adjacent tile world-edge consistency",
                         "bitwise shared POSITION values", "noninteger-camera float32 GPU edge consistency", "fixed origins"]}
    write(APP / "public/visuals/terrain/verification.json", json_bytes(report))
    print(json.dumps(report, indent=2), flush=True)


def compare_horizons(cache_dir):
    """Measure display-source expansion against unchanged fixed science profiles."""
    pins = baseline_pins()
    data = json.loads((APP / "public/data/observatory.json").read_text())
    far, far_transform = read_raster(cache_dir / "polar-far-80m.tif")
    report = {"description": "Full original regional 5 m coverage versus unchanged cropped 5 m/80 m baseline; identical fixed points, observer heights, distances and azimuth rays.",
              "sciencePins": pins, "azimuthStepDeg": 1, "maximumRayRangeKm": 200,
              "interpolatedClassificationStepMinutes": 1, "sites": {}}

    def profile_for(site, near, transform):
        def terrain_at(lon, lat):
            x, y = SCIENCE.stereographic(lon, lat)
            fine = SCIENCE.bilinear(near, transform, x, y)
            return np.where(np.isfinite(fine), fine, SCIENCE.bilinear(far, far_transform, x, y))
        return SCIENCE.horizons(site, terrain_at)

    def horizon_at(profile, azimuth):
        lower = np.floor(azimuth).astype(int) % 360
        fraction = azimuth % 1
        return profile[lower] * (1 - fraction) + profile[(lower + 1) % 360] * fraction

    def continuous_comparison(old_profile, new_profile, az, el):
        # Exact integration within the app's piecewise-linear interpolation:
        # partition at every horizon bearing knot and every clearance zero.
        old_hours, new_hours, changed_hours = 0., 0., 0.
        for i in range(len(az) - 1):
            da = (az[i + 1] - az[i] + 540) % 360 - 180
            de = el[i + 1] - el[i]
            cuts = [0., 1.]
            if abs(da) > 1e-12:
                lower_az, upper_az = sorted((az[i], az[i] + da))
                for bearing in range(int(np.floor(lower_az)) + 1, int(np.ceil(upper_az))):
                    t = (bearing - az[i]) / da
                    if 0 < t < 1:
                        cuts.append(float(t))
            cuts.sort()
            for a, b in zip(cuts[:-1], cuts[1:]):
                def clearance(profile, t):
                    return float(el[i] + de * t - horizon_at(profile, np.asarray(az[i] + da * t)))
                oa, ob = clearance(old_profile, a), clearance(old_profile, b)
                na, nb = clearance(new_profile, a), clearance(new_profile, b)
                roots = [a, b]
                for ca, cb in ((oa, ob), (na, nb)):
                    if ca * cb < 0:
                        roots.append(a - ca * (b - a) / (cb - ca))
                roots.sort()
                for left, right in zip(roots[:-1], roots[1:]):
                    fraction = ((left + right) / 2 - a) / (b - a)
                    old_visible = oa + (ob - oa) * fraction > 0
                    new_visible = na + (nb - na) * fraction > 0
                    old_hours += (right - left) * old_visible
                    new_hours += (right - left) * new_visible
                    changed_hours += (right - left) * (old_visible != new_visible)
        return {"baselineVisibleHours": old_hours, "expandedVisibleHours": new_hours,
                "changedVisibilityDurationMinutes": changed_hours * 60,
                "method": "Exact partition at integer azimuth knots and clearance zeroes within linear hourly ephemeris interpolation; no claim of sub-hour physical ephemeris accuracy."}

    for site in data["sites"]:
        region = REGIONS[site["id"]]
        full, transform = read_raster(cache_dir / f"{region}_final_adj_5mpp_surf.tif")
        cropped, cropped_transform = read_raster(cache_dir / f"{region}-near.tif")
        baseline_recomputed = profile_for(site, cropped, cropped_transform)
        expanded = np.round(profile_for(site, full, transform), 4)
        baseline = np.asarray(site["horizon"]["elevationDeg"])
        baseline_reproduction_error = float(np.max(np.abs(baseline_recomputed - baseline)))
        assert baseline_reproduction_error <= .000051, "Failed to reproduce baseline horizon; width comparison would not be isolated"
        delta = expanded - baseline
        stats = {"baselineReproductionMaxErrorDeg": baseline_reproduction_error,
                 "maximumHorizonChangeDeg": float(np.max(np.abs(delta))), "meanAbsoluteHorizonChangeDeg": float(np.mean(np.abs(delta))),
                 "changedBearings": int(np.sum(delta != 0)), "fullRegionalHorizonDeg": expanded.tolist(),
                 "deltaDeg": np.round(delta, 5).tolist(), "visibility": {}}
        ephemeris = site["ephemeris"]
        intervals = len(ephemeris["timesUtc"]) - 1
        minute_axis = np.arange(intervals * 60 + 1) / 60
        lower = np.minimum(np.floor(minute_axis).astype(int), intervals - 1)
        fraction = minute_axis - lower
        for body in ("sun", "earth"):
            az = np.asarray(ephemeris[f"{body}AzDeg"])
            el = np.asarray(ephemeris[f"{body}ElDeg"])
            old_hourly_h = horizon_at(baseline, az)
            new_hourly_h = horizon_at(expanded, az)
            old_hourly, new_hourly = el > old_hourly_h, el > new_hourly_h
            angular_delta = (az[1:] - az[:-1] + 540) % 360 - 180
            minute_az = (az[lower] + angular_delta[lower] * fraction) % 360
            minute_el = el[lower] * (1 - fraction) + el[lower + 1] * fraction
            old_minutes = minute_el > horizon_at(baseline, minute_az)
            new_minutes = minute_el > horizon_at(expanded, minute_az)
            changed = np.flatnonzero(old_hourly != new_hourly)
            stats["visibility"][body] = {
                "hourlyEpochs": len(az), "changedHourlyEpochs": len(changed),
                "changedHourlyTimesUtc": [ephemeris["timesUtc"][int(i)] for i in changed],
                "baselineHourlyVisibleEpochs": int(np.sum(old_hourly)), "expandedHourlyVisibleEpochs": int(np.sum(new_hourly)),
                "changedInterpolatedMinuteSamples": int(np.sum(old_minutes != new_minutes)),
                "baselineInterpolatedVisibleHours": float(np.sum(old_minutes[:-1]) / 60),
                "expandedInterpolatedVisibleHours": float(np.sum(new_minutes[:-1]) / 60),
                "maximumBodyAzimuthHorizonChangeDeg": float(np.max(np.abs(new_hourly_h - old_hourly_h))),
                "continuousLinearInterpolation": continuous_comparison(baseline, expanded, az, el),
            }
        report["sites"][site["id"]] = stats
        print(json.dumps({"id": site["id"], **{k: v for k, v in stats.items() if k not in ("fullRegionalHorizonDeg", "deltaDeg")}}), flush=True)
    assert baseline_pins() == pins
    write(APP / "public/visuals/terrain/horizon-comparison.json", json_bytes(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=APP.parent.parent / "research/terrain-build/raw")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--compare-horizons", action="store_true", help="Requires cached DEMs; quantify source-width effects without changing science data")
    args = parser.parse_args()
    if args.compare_horizons:
        compare_horizons(args.cache_dir.resolve())
    elif args.verify_only:
        verify()
    else:
        build(args.cache_dir.resolve())
