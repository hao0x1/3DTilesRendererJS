#!/usr/bin/env python3
"""Prepare real NASA globe assets; retain scientific originals outside the app.

Run with the bundled Python (Pillow and NumPy). Downloads resume into .part files,
retry at most three times, and publish assets/manifest entries only after validation.
This script owns public/visuals only. It does not create local terrain or ephemerides.

Runtime display contract: JPEG/WebP colors are sRGB; renderer-generated mipmaps and
trilinear filtering should be used, with anisotropy selected from GPU capabilities.
The lossless normal texture is linear data, with a unit physical gradient relative
to an undeformed spherical tangent frame. Avoid adding that whole gradient twice
when the displaced render mesh already has physical surface normals.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = 300_000_000
APP = Path(__file__).resolve().parents[1]
WORKSPACE = APP.parent.parent
CACHE = WORKSPACE / "assets/reference/v2"
REFERENCE = CACHE.parent
OUTPUT = APP / "public/visuals"
SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/"
MOON_PAGE = "https://svs.gsfc.nasa.gov/4720/"
EARTH_PAGE = "https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/"
NASA_POLICY = "https://www.nasa.gov/nasa-brand-center/images-and-media/"
ORIENTATION = {
    "projection": "equirectangular", "centerLongitudeDegrees": 0,
    "rowOrder": "north-to-south", "longitudeRangeDegrees": [-180, 180],
    "latitudeRangeDegrees": [90, -90], "pixelRegistration": "pixel-center",
}
SOURCES = {
    "moon8k": ("lroc-color-2025-8k.tif", SVS + "lroc_color_16bit_srgb_8k.tif"),
    "moon16k": ("lroc-color-2025-16k.tif", SVS + "lroc_color_16bit_srgb_16k.tif"),
    "height": ("ldem-16-float.tif", SVS + "ldem_16.tif"),
    "earth": ("earth-bmng-july-2004-21600.jpg", "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x21600x10800.jpg"),
}
PRINT_LOCK = threading.Lock()
STATIC_CONNECTIONS = threading.BoundedSemaphore(4)


def log(message: str) -> None:
    with PRINT_LOCK:
        print(message, flush=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


@contextmanager
def static_response(request, timeout=60):
    """Never use more than four simultaneous static-asset HTTP connections."""
    with STATIC_CONNECTIONS:
        with urlopen(request, timeout=timeout) as response:
            yield response


def download_large_ranges(key: str) -> tuple[str, Path]:
    """Resume the existing prefix plus three bounded, verified static-file ranges."""
    filename, url = SOURCES[key]
    destination = CACHE / filename
    if destination.exists():
        with Image.open(destination) as image:
            image.verify()
        return key, destination
    prefix = destination.with_name(destination.name + ".part")
    metadata_path = destination.with_name(destination.name + ".ranges.json")
    if metadata_path.exists():
        metadata = json.loads(metadata_path.read_text())
    else:
        with static_response(Request(url, headers={"Range": "bytes=0-0", "User-Agent": "MOONDA-static-asset-preparation"})) as response:
            content_range = response.headers.get("Content-Range", "")
            if response.status != 206 or not content_range.startswith("bytes 0-0/"):
                log(f"Range unsupported for {key}; using one resumable connection")
                return download(key, use_ranges=False)
            total = int(content_range.split("/")[1])
            response.read(1)
        prefix_size = prefix.stat().st_size if prefix.exists() else 0
        if prefix_size >= total:
            raise ValueError("Existing prefix is unexpectedly at least the complete source size")
        block_size = math.ceil((total - prefix_size) / 3)
        ranges = []
        for start in range(prefix_size, total, block_size):
            end = min(start + block_size - 1, total - 1)
            ranges.append({"start": start, "end": end, "filename": f"{filename}.range-{start}-{end}.part"})
        metadata = {"sourceUrl": url, "totalBytes": total, "prefixBytes": prefix_size, "ranges": ranges}
        atomic_json(metadata_path, metadata)
    if metadata["sourceUrl"] != url:
        raise ValueError("Resumable range source URL changed")
    prefix_size = metadata["prefixBytes"]
    if prefix_size and (not prefix.exists() or prefix.stat().st_size != prefix_size):
        raise ValueError("Previously downloaded prefix changed; refusing unsafe range merge")

    def segment(item: dict) -> Path:
        path = CACHE / item["filename"]
        expected_size = item["end"] - item["start"] + 1
        for attempt in range(3):
            already = path.stat().st_size if path.exists() else 0
            if already == expected_size:
                return path
            if already > expected_size:
                raise ValueError("A cached segment exceeds its documented byte range")
            start = item["start"] + already
            range_value = f"bytes={start}-{item['end']}"
            try:
                with static_response(Request(url, headers={"Range": range_value, "User-Agent": "MOONDA-static-asset-preparation"})) as response:
                    expected_header = f"bytes {start}-{item['end']}/{metadata['totalBytes']}"
                    if response.status != 206 or response.headers.get("Content-Range") != expected_header:
                        raise ValueError(f"Range verification failed for {range_value}")
                    received = already
                    started = last_report = time.monotonic()
                    with path.open("ab") as stream:
                        while block := response.read(1024 * 1024):
                            stream.write(block)
                            received += len(block)
                            now = time.monotonic()
                            if now - last_report >= 15:
                                speed = (received - already) / max(now - started, 0.01) / 1_000_000
                                log(f"RANGE {key} {item['start']}: {received:,}/{expected_size:,} bytes {received / expected_size:.1%} {speed:.2f} MB/s")
                                last_report = now
                    if received != expected_size:
                        raise ValueError("Range ended before its documented final byte")
                log(f"RANGE COMPLETE {key}: {item['start']}-{item['end']}")
                return path
            except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
                log(f"RANGE RETRY {key} {attempt + 1}/3: {error}")
                if attempt == 2:
                    raise
                time.sleep(2 * (attempt + 1))
        raise RuntimeError("Unreachable")

    log(f"RESUME {key}: retaining {prefix_size:,} verified-prefix bytes; three remaining ranges")
    with ThreadPoolExecutor(max_workers=3) as pool:
        segments = list(pool.map(segment, metadata["ranges"]))
    merged = destination.with_name(destination.name + ".merge.part")
    with merged.open("wb") as output:
        if prefix_size:
            with prefix.open("rb") as stream:
                shutil.copyfileobj(stream, output, length=4 * 1024 * 1024)
        for path in segments:
            with path.open("rb") as stream:
                shutil.copyfileobj(stream, output, length=4 * 1024 * 1024)
    if merged.stat().st_size != metadata["totalBytes"]:
        raise ValueError("Merged TIFF size does not match the server's declared source size")
    with Image.open(merged) as image:
        image.verify()
    merged.replace(destination)
    for path in [prefix, metadata_path, *segments]:
        path.unlink(missing_ok=True)
    log(f"DOWNLOADED {key}: {destination.stat().st_size:,} bytes, merged and TIFF-verified")
    return key, destination


def download(key: str, use_ranges: bool = True) -> tuple[str, Path]:
    if key == "moon16k" and use_ranges:
        return download_large_ranges(key)
    filename, url = SOURCES[key]
    destination = CACHE / filename
    if destination.exists():
        with Image.open(destination) as image:
            image.verify()
        log(f"CACHED {key}: {destination.stat().st_size:,} bytes")
        return key, destination
    partial = destination.with_name(destination.name + ".part")
    for attempt in range(3):
        offset = partial.stat().st_size if partial.exists() else 0
        headers = {"User-Agent": "MOONDA-NASA-asset-preparation/1.0"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        try:
            with static_response(Request(url, headers=headers), timeout=60) as response:
                status = getattr(response, "status", 200)
                if offset and status != 206:
                    log(f"RESTART {key}: source ignored Range; replacing partial")
                    offset = 0
                if status == 206:
                    expected = f"bytes {offset}-"
                    if not response.headers.get("Content-Range", "").startswith(expected):
                        raise ValueError(f"Unexpected Content-Range for {key}")
                content_length = response.headers.get("Content-Length")
                total = offset + int(content_length) if content_length else None
                received = offset
                started = time.monotonic()
                last_report = started
                with partial.open("ab" if offset else "wb") as stream:
                    while block := response.read(1024 * 1024):
                        stream.write(block)
                        received += len(block)
                        now = time.monotonic()
                        if now - last_report >= 15:
                            percent = f" {received / total:.1%}" if total else ""
                            speed = (received - offset) / max(now - started, 0.01) / 1_000_000
                            log(f"DOWNLOAD {key}: {received:,}/{total or '?'} bytes{percent} {speed:.2f} MB/s")
                            last_report = now
                if total is not None and received != total:
                    raise ValueError(f"Incomplete {key}: {received} != {total}")
            with Image.open(partial) as image:
                image.verify()
            partial.replace(destination)
            log(f"DOWNLOADED {key}: {received:,} bytes")
            return key, destination
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
            log(f"RETRY {key} {attempt + 1}/3: {type(error).__name__}: {error}")
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("Unreachable")


def asset(path: Path, source: Path, url: str, page: str, credit: str, **extra) -> dict:
    result = {
        "url": "/visuals/" + path.relative_to(OUTPUT).as_posix(),
        "bytes": path.stat().st_size, "sha256": sha256(path),
        "sourceUrl": url, "sourcePage": page,
        "sourceFilename": source.name, "sourceSha256": sha256(source),
        "credit": credit, "usageGuidelinesUrl": NASA_POLICY,
    }
    result.update(extra)
    return result


def image_asset(path: Path, source: Path, url: str, page: str, credit: str, **extra) -> dict:
    with Image.open(path) as image:
        width, height = image.size
        mode = image.mode
        image_format = image.format
    return asset(path, source, url, page, credit, width=width, height=height,
                 colorSpace="srgb", mode=mode, imageFormat=image_format, **extra)


def publish_image(image: Image.Image, path: Path, format: str, **options) -> None:
    temporary = path.with_name(path.name + ".tmp")
    try:
        image.save(temporary, format=format, **options)
        with Image.open(temporary) as verification:
            verification.verify()
        temporary.replace(path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def prepare_color(key: str, source: Path, manifest: dict) -> None:
    _, url = SOURCES[key]
    is_moon = key.startswith("moon")
    body = manifest["moon" if is_moon else "earth"]
    credit = "NASA's Scientific Visualization Studio / Ernie Wright / LRO-LROC" if is_moon else "NASA Earth Observatory / Reto Stöckli"
    page = MOON_PAGE if is_moon else EARTH_PAGE
    if key == "moon8k":
        sizes = [(8192, 4096, "high", "8k")]
    elif key == "moon16k":
        sizes = [(16384, 8192, "ultra", "16k")]
        if "high" not in body["color"]:
            sizes.insert(0, (8192, 4096, "high", "8k"))
    else:
        sizes = [(4096, 2048, "high", "4k"), (8192, 4096, "ultra", "8k")]
    with Image.open(source) as original:
        original.load()
        rgb = original.convert("RGB")
        for width, height, tier, suffix in sizes:
            reduced = rgb if rgb.size == (width, height) else rgb.resize((width, height), Image.Resampling.LANCZOS)
            prefix = "moon" if is_moon else "earth"
            # JPEG publishes quickly while WebP is encoded. Both are real derivatives.
            jpeg = OUTPUT / f"{prefix}-color-{suffix}.jpg"
            publish_image(reduced, jpeg, "JPEG", quality=96, subsampling=0, optimize=True)
            runtime = jpeg
            # WebP dimensions stop at 16383; preserve the complete 16384px map in JPEG.
            if width <= 16383 and height <= 16383:
                runtime = OUTPUT / f"{prefix}-color-{suffix}.webp"
                publish_image(reduced, runtime, "WEBP", quality=94, method=4)
            body["color"][tier] = image_asset(runtime, source, url, page, credit,
                jpegUrl="/visuals/" + jpeg.name,
                jpeg={"url": "/visuals/" + jpeg.name, "width": width, "height": height,
                      "bytes": jpeg.stat().st_size, "sha256": sha256(jpeg)},
                lossyDisplayDerivative=True,
                scientificUse="visualization only; use georeferenced source DEMs for terrain analysis")
            atomic_json(OUTPUT / "assets.json", manifest)
            log(f"READY {prefix} {suffix}: {runtime.stat().st_size:,} bytes ({runtime.suffix})")
            if reduced is not rgb:
                reduced.close()
        rgb.close()


def prepare_height(source: Path, manifest: dict) -> None:
    with Image.open(source) as original:
        # NASA's float TIFF is in km above the 1737.4 km reference sphere.
        heights = np.asarray(original, dtype=np.float32) * np.float32(1000.0)
    if heights.ndim != 2 or not np.isfinite(heights).all():
        raise ValueError("Height source must be one finite numeric elevation plane")
    minimum, maximum = float(heights.min()), float(heights.max())
    encoded_float = np.rint((heights + 10000.0) * 2.0)
    if encoded_float.min() < 0 or encoded_float.max() > 65535:
        raise ValueError("Height range cannot fit documented unsigned half-meter encoding")
    encoded = encoded_float.astype("<u2")
    height, width = encoded.shape
    binary = OUTPUT / f"moon-height-{width}x{height}.u16"
    temporary = binary.with_name(binary.name + ".tmp")
    encoded.tofile(temporary)
    temporary.replace(binary)
    decoded = encoded.astype(np.float32) * 0.5 - 10000.0
    maximum_error = float(np.max(np.abs(decoded - heights)))
    if maximum_error > 0.251:
        raise ValueError(f"Height encoding error too large: {maximum_error}")
    png = OUTPUT / f"moon-height-{width}x{height}-16bit.png"
    publish_image(Image.fromarray(encoded), png, "PNG", optimize=True)
    info = asset(binary, source, SOURCES["height"][1], MOON_PAGE,
        "NASA's Scientific Visualization Studio / LRO-LOLA",
        width=width, height=height, format="uint16-le", units="meters",
        scale=0.5, bias=-10000, referenceRadiusMeters=1737400,
        noData=None, allFinite=True, minMeters=minimum, maxMeters=maximum,
        maximumQuantizationErrorMeters=maximum_error,
        png16Url="/visuals/" + png.name,
        png16={"url": "/visuals/" + png.name, "width": width, "height": height,
               "bytes": png.stat().st_size, "sha256": sha256(png), "bitDepth": 16},
        png16DecodeNote="Decode the full 16-bit grayscale plane; ordinary browser color textures are not a numeric elevation decoder.",
        **ORIENTATION)
    manifest["moon"]["height"] = info
    atomic_json(OUTPUT / "assets.json", manifest)
    log(f"READY global height: {width}x{height}, {minimum:.2f} to {maximum:.2f} m, encoding error {maximum_error:.4f} m")

    # Tangent axes follow equirectangular UVs: east +U, north +V, radial up +Z.
    # Metric derivatives use the true latitude-dependent circumference; no exaggeration.
    latitude = np.deg2rad(90.0 - (np.arange(height, dtype=np.float32) + 0.5) * 180.0 / height)
    longitude_step = np.float32(2.0 * math.pi / width)
    latitude_step = np.float32(math.pi / height)
    radius = heights + np.float32(1737400.0)
    slope_east = (np.roll(heights, -1, axis=1) - np.roll(heights, 1, axis=1)) / (2.0 * longitude_step)
    slope_east /= radius * np.cos(latitude)[:, None]
    slope_north = -np.gradient(heights, axis=0) / latitude_step
    slope_north /= radius
    length = np.sqrt(slope_east * slope_east + slope_north * slope_north + 1.0)
    normal = np.empty((height, width, 3), dtype=np.uint8)
    normal[:, :, 0] = np.rint(np.clip(-slope_east / length * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8)
    normal[:, :, 1] = np.rint(np.clip(-slope_north / length * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8)
    normal[:, :, 2] = np.rint(np.clip(1.0 / length * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8)
    normal_path = OUTPUT / f"moon-normal-{width}x{height}.webp"
    publish_image(Image.fromarray(normal), normal_path, "WEBP", lossless=True, method=4)
    manifest["moon"]["normal"] = asset(normal_path, source, SOURCES["height"][1], MOON_PAGE,
        "Derived by MOONDA from NASA LRO-LOLA elevation data",
        width=width, height=height, normalSpace="tangent", colorSpace="linear",
        scaleFactor=1, method="metric central longitude and finite latitude gradients at source resolution; no vertical exaggeration",
        tangentAxes={"x": "east/increasing-U", "y": "north/increasing-V", "z": "radial up"}, **ORIENTATION)
    atomic_json(OUTPUT / "assets.json", manifest)
    log(f"READY global physical normal map: {normal_path.stat().st_size:,} bytes")


def initial_manifest() -> dict:
    path = OUTPUT / "assets.json"
    if path.exists():
        manifest = json.loads(path.read_text())
    else:
        manifest = {"version": 2, "generatedAt": datetime.now(timezone.utc).isoformat(),
            "moon": {"referenceRadiusMeters": 1737400, "orientation": ORIENTATION, "color": {}},
            "earth": {"referenceRadiusMeters": 6371000, "orientation": ORIENTATION, "color": {}},
            "usageGuidelinesUrl": NASA_POLICY,
            "reuseNote": "NASA imagery/data reuse follows item credits and NASA media guidelines. This is distinct from the application code license; NASA has not endorsed this application."}
    fallbacks = [
        ("moon", "moon-color-2025-2k.jpg", "moon-color-2k.jpg", SVS + "lroc_color_2k.jpg", MOON_PAGE, "NASA's Scientific Visualization Studio / Ernie Wright / LRO-LROC"),
        ("earth", "earth-blue-marble-2k.png", "earth-color-2k.png", "https://svs.gsfc.nasa.gov/vis/a000000/a002900/a002915/bluemarble-2048.png", "https://svs.gsfc.nasa.gov/2915/", "NASA/Goddard Space Flight Center Scientific Visualization Studio / Reto Stöckli"),
    ]
    for body, filename, output, url, page, credit in fallbacks:
        source = REFERENCE / filename
        target = OUTPUT / output
        shutil.copyfile(source, target)
        manifest[body]["color"]["fallback"] = image_asset(target, source, url, page, credit)
    atomic_json(path, manifest)
    return manifest


def prepare_fonts() -> None:
    """Keep IBM's unmodified complete WOFF2 files and the required OFL together."""
    directory = OUTPUT / "fonts"
    directory.mkdir(parents=True, exist_ok=True)
    metadata = {"license": "OFL-1.1", "licenseUrl": "/visuals/fonts/OFL-IBM-Plex.txt", "fonts": []}
    base = "https://raw.githubusercontent.com/IBM/plex/master/"
    for family, package, prefix in [("IBM Plex Sans", "plex-sans", "IBMPlexSans"), ("IBM Plex Mono", "plex-mono", "IBMPlexMono")]:
        for style, weight in [("Regular", 400), ("Medium", 500), ("SemiBold", 600)]:
            filename = f"{prefix}-{style}.woff2"
            url = base + f"packages/{package}/fonts/complete/woff2/{filename}"
            path = directory / filename
            if not path.exists():
                with urlopen(Request(url, headers={"User-Agent": "MOONDA-font-preparation"}), timeout=30) as response:
                    data = response.read(1024 * 1024)
                if data[:4] != b"wOF2":
                    raise ValueError(f"Invalid WOFF2 response: {filename}")
                temporary = path.with_name(path.name + ".tmp")
                temporary.write_bytes(data)
                temporary.replace(path)
            metadata["fonts"].append({"family": family, "weight": weight, "style": "normal", "url": "/visuals/fonts/" + filename,
                "bytes": path.stat().st_size, "sha256": sha256(path), "sourceUrl": url,
                "credit": "IBM Corp.; Reserved Font Name Plex", "license": "OFL-1.1"})
    license_path = directory / "OFL-IBM-Plex.txt"
    if not license_path.exists():
        with urlopen(base + "LICENSE.txt", timeout=30) as response:
            license_path.write_bytes(response.read(100_000))
    if "SIL OPEN FONT LICENSE" not in license_path.read_text():
        raise ValueError("Downloaded IBM Plex license is not the expected OFL text")
    metadata["totalBytes"] = sum(item["bytes"] for item in metadata["fonts"]) + license_path.stat().st_size
    atomic_json(directory / "fonts.json", metadata)
    log(f"READY IBM Plex Sans + Mono 400/500/600: {metadata['totalBytes']:,} bytes including OFL")


def verify_manifest() -> None:
    manifest = json.loads((OUTPUT / "assets.json").read_text())
    checked = 0

    def visit(value):
        nonlocal checked
        if isinstance(value, dict):
            url = value.get("url", "")
            if url.startswith("/visuals/"):
                path = OUTPUT / url.removeprefix("/visuals/")
                if not path.is_file():
                    raise ValueError(f"Manifest references a missing output: {url}")
                if "bytes" in value and value["bytes"] != path.stat().st_size:
                    raise ValueError(f"Output byte count changed: {url}")
                if "sha256" in value and value["sha256"] != sha256(path):
                    raise ValueError(f"Output hash changed: {url}")
                if path.suffix in {".jpg", ".png", ".webp"}:
                    with Image.open(path) as image:
                        if image.size != (value["width"], value["height"]):
                            raise ValueError(f"Image dimensions changed: {url}")
                        image.verify()
                if value.get("format") == "uint16-le":
                    if path.stat().st_size != value["width"] * value["height"] * 2:
                        raise ValueError("Invalid numeric elevation byte count")
                    encoded = np.fromfile(path, dtype="<u2")
                    decoded = encoded.astype(np.float32) * value["scale"] + value["bias"]
                    if not np.isfinite(decoded).all():
                        raise ValueError("Non-finite decoded elevations")
                    if abs(float(decoded.min()) - value["minMeters"]) > 0.251 or abs(float(decoded.max()) - value["maxMeters"]) > 0.251:
                        raise ValueError("Decoded elevation extrema disagree with the manifest")
                checked += 1
            for item in value.values():
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(manifest)
    fonts_path = OUTPUT / "fonts/fonts.json"
    if fonts_path.exists():
        visit(json.loads(fonts_path.read_text()))
    log(f"VERIFIED {checked} published asset entries, dimensions, byte counts, hashes and numeric elevation encoding")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fallback-only", action="store_true")
    parser.add_argument("--fonts-only", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--only", choices=list(SOURCES))
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if args.verify_only:
        verify_manifest()
        return
    if args.fonts_only:
        prepare_fonts()
        return
    manifest = initial_manifest()
    log("READY fallback textures and /visuals/assets.json")
    if args.fallback_only:
        return
    keys = [args.only] if args.only else ["moon8k", "moon16k", "height", "earth"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(download, key): key for key in keys}
        for future in as_completed(futures):
            key, source = future.result()
            if key == "height":
                if manifest["moon"].get("normal", {}).get("sourceSha256") == sha256(source):
                    log("CACHED height and normal display derivatives")
                else:
                    prepare_height(source, manifest)
            else:
                body = manifest["moon" if key.startswith("moon") else "earth"]
                tier = "high" if key == "moon8k" else "ultra"
                if body["color"].get(tier, {}).get("sourceSha256") == sha256(source):
                    log(f"CACHED {key} display derivatives")
                else:
                    prepare_color(key, source, manifest)
    if (OUTPUT / "fonts/fonts.json").exists():
        manifest["fontsManifestUrl"] = "/visuals/fonts/fonts.json"
        manifest["fonts"] = json.loads((OUTPUT / "fonts/fonts.json").read_text())
    # Add validation metadata for derivatives produced by an earlier resumable run.
    for body in [manifest["moon"], manifest["earth"]]:
        for entry in body["color"].values():
            entry["mipmapPolicy"] = "Generate GPU mipmaps; trilinear minification; choose anisotropy from renderer capabilities. JPEG/WebP files do not contain a stored mip chain."
            if "imageFormat" not in entry:
                with Image.open(OUTPUT / entry["url"].removeprefix("/visuals/")) as image:
                    entry["imageFormat"] = image.format
            if "jpegUrl" in entry and "jpeg" not in entry:
                path = OUTPUT / entry["jpegUrl"].removeprefix("/visuals/")
                entry["jpeg"] = {"url": entry["jpegUrl"], "width": entry["width"], "height": entry["height"],
                                 "bytes": path.stat().st_size, "sha256": sha256(path)}
    height = manifest["moon"].get("height")
    if height and "png16" not in height:
        path = OUTPUT / height["png16Url"].removeprefix("/visuals/")
        height["png16"] = {"url": height["png16Url"], "width": height["width"], "height": height["height"],
                           "bytes": path.stat().st_size, "sha256": sha256(path), "bitDepth": 16}
    normal = manifest["moon"].get("normal")
    if normal:
        normal["referenceGeometry"] = "undeformed sphere; total physical terrain gradient, not a residual detail map"
        normal["applicationNote"] = "Use linear/NoColorSpace. Do not double-count coarse terrain slopes when normals are already computed from displaced geometry."
    atomic_json(OUTPUT / "assets.json", manifest)
    verify_manifest()
    log("DONE all requested display derivatives and provenance manifest")


if __name__ == "__main__":
    main()
