#!/usr/bin/env python3
"""Scientific coordinate and generated-data checks; run after generation."""
import importlib.util
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import unittest
import urllib.parse

import numpy as np

spec = importlib.util.spec_from_file_location("generator", Path(__file__).with_name("generate-data.py"))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


class CoordinateChecks(unittest.TestCase):
    def test_polar_projection_round_trip(self):
        for lon, lat in [(0, -89), (-170, -89.5), (130, -86), (179.9, -88)]:
            x, y = g.stereographic(lon, lat)
            actual_lon, actual_lat = g.inverse_stereographic(x, y)
            self.assertAlmostEqual(float(actual_lon), lon, places=8)
            self.assertAlmostEqual(float(actual_lat), lat, places=8)

    def test_azimuth_north_and_east(self):
        lon, lat = g.destination(0, -89, 0, 1000)
        self.assertAlmostEqual(float(lon), 0, places=8)
        self.assertGreater(lat, -89)
        lon, lat = g.destination(0, -89, 90, 1000)
        self.assertGreater(lon, 0)

    def test_flat_sphere_horizon_matches_analytic_dip(self):
        h = 2
        distances = np.linspace(100, 10000, 20000)
        angles = g.horizon_from_samples(distances, np.zeros_like(distances), 0, h)
        expected = -math.degrees(math.acos(g.RADIUS_M / (g.RADIUS_M + h)))
        self.assertAlmostEqual(float(np.max(angles)), expected, places=5)

    def test_high_terrain_increases_horizon(self):
        low = g.horizon_from_samples(np.array([1000]), np.array([0]), 0)[0]
        high = g.horizon_from_samples(np.array([1000]), np.array([100]), 0)[0]
        self.assertGreater(high, low)

    def test_bilinear_pixel_centers(self):
        from affine import Affine
        data = np.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]], dtype=float)
        t = Affine(5, 0, 0, 0, -5, 15)
        self.assertEqual(g.bilinear(data, t, 7.5, 7.5), 5)
        self.assertAlmostEqual(float(g.bilinear(data, t, 5, 10)), 3)


class OutputChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = Path(os.environ.get("MOONDA_DATA_DIR", Path(__file__).resolve().parents[1] / "public/data"))
        cls.document = json.loads((cls.base / "observatory.json").read_text())

    def test_three_distinct_sites(self):
        sites = self.document["sites"]
        self.assertEqual(len(sites), 3)
        self.assertEqual(len({s["id"] for s in sites}), 3)

    def test_valid_coordinates_and_terrain(self):
        for s in self.document["sites"]:
            self.assertLess(s["latitudeDeg"], -85)
            self.assertTrue(-180 <= s["longitudeDeg"] <= 180)
            h = np.array(s["terrain"]["heightsM"])
            self.assertTrue(np.isfinite(h).all())
            self.assertEqual(len(h), s["terrain"]["size"] ** 2)
            self.assertTrue(np.all(np.abs(h) < 12000))
            self.assertGreater(np.ptp(h), 50)
            x, y = g.stereographic(s["longitudeDeg"], s["latitudeDeg"])
            b = s["regionBoundsM"]
            self.assertTrue(b["xMin"] < x < b["xMax"])
            self.assertTrue(b["yMin"] < y < b["yMax"])
            self.assertEqual(len(s["horizon"]["elevationDeg"]), 360)
            self.assertTrue(all(-15 < v < 80 for v in s["horizon"]["elevationDeg"]))

    def test_matching_hourly_ephemerides(self):
        for s in self.document["sites"]:
            eph = s["ephemeris"]
            self.assertEqual(len(eph["timesUtc"]), 721)
            self.assertEqual(eph["timesUtc"][0], "2026-11-01T00:00:00Z")
            self.assertEqual(eph["timesUtc"][-1], "2026-12-01T00:00:00Z")
            for key in ["sunAzDeg", "sunElDeg", "earthAzDeg", "earthElDeg"]:
                self.assertEqual(len(eph[key]), 721)
                self.assertTrue(np.isfinite(eph[key]).all())
            for key in ["sunAzDeg", "earthAzDeg"]:
                self.assertTrue(all(0 <= v < 360 for v in eph[key]))
            for key in ["sunElDeg", "earthElDeg"]:
                self.assertTrue(all(-90 <= v <= 90 for v in eph[key]))

    def test_query_manifest_matches_points_and_surface_height(self):
        manifest = json.loads((self.base / "science-manifest.json").read_text())
        self.assertEqual(manifest["outputSha256"], hashlib.sha256((self.base / "observatory.json").read_bytes()).hexdigest())
        self.assertEqual(len(manifest["horizonsQueries"]), 6)
        for s in self.document["sites"]:
            targets = set()
            for query in manifest["horizonsQueries"]:
                p = urllib.parse.parse_qs(urllib.parse.urlparse(query["requestUrl"]).query)
                lon, lat, height_km = map(float, p["SITE_COORD"][0].strip("'").split(","))
                if abs(lon - s["longitudeDeg"]) < 1e-7 and abs(lat - s["latitudeDeg"]) < 1e-7:
                    self.assertAlmostEqual(height_km * 1000, s["terrain"]["centerHeightM"] + s["observerHeightM"], delta=0.001)
                    self.assertEqual(p["CENTER"][0], "'coord@301'")
                    targets.add(query["targetId"])
            self.assertEqual(targets, {10, 399})

    def test_local_glb_and_tilesets(self):
        for s in self.document["sites"]:
            base = self.base / s["id"]
            glb = (base / "terrain.glb").read_bytes()
            magic, version, length = struct.unpack("<III", glb[:12])
            self.assertEqual(magic, 0x46546C67)
            self.assertEqual(version, 2)
            self.assertEqual(length, len(glb))
            js_length, js_type = struct.unpack("<II", glb[12:20])
            js = json.loads(glb[20:20 + js_length])
            self.assertEqual(js_type, 0x4E4F534A)
            self.assertEqual(js["accessors"][0]["count"], s["terrain"]["size"] ** 2)
            tiles = json.loads((base / "tileset.json").read_text())
            self.assertEqual(tiles["root"]["content"]["uri"], "terrain.glb")
            bounds = js["accessors"][0]
            lo, hi = np.asarray(bounds["min"]), np.asarray(bounds["max"])
            center, half = (lo + hi) / 2, (hi - lo) / 2
            expected = [center[0], -center[2], center[1], half[0], 0, 0, 0, half[2], 0, 0, 0, half[1]]
            self.assertTrue(np.allclose(tiles["root"]["boundingVolume"]["box"], expected, atol=0.001))


if __name__ == "__main__":
    unittest.main()
