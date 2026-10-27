import runpy
import struct
import tempfile
import unittest
import zlib
from pathlib import Path

oracle = runpy.run_path(str(Path(__file__).with_name("expert-visual-oracle.py")))


def png(raw):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


class VisualOracleTest(unittest.TestCase):
    def counts(self, raw):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "page.png"
            path.write_bytes(png(bytes(raw)))
            return oracle["palette_bands"](path, 2)

    def test_known_pixels_through_each_png_filter(self):
        vectors = [
            [0, 68, 114, 196, 255, 255, 255, 0, 255, 255, 255, 68, 114, 196],
            [1, 68, 114, 196, 187, 141, 59, 1, 255, 255, 255, 69, 115, 197],
            [2, 68, 114, 196, 255, 255, 255, 2, 187, 141, 59, 69, 115, 197],
            [3, 68, 114, 196, 221, 198, 157, 3, 221, 198, 157, 69, 115, 197],
            [4, 68, 114, 196, 187, 141, 59, 4, 187, 141, 59, 69, 115, 197],
        ]
        for index, vector in enumerate(vectors):
            with self.subTest(filter=index):
                self.assertEqual(self.counts(vector), [1, 1])

    def test_white_plot_does_not_count_as_data(self):
        self.assertEqual(self.counts([0] + [255] * 6 + [0] + [255] * 6), [0, 0])

    def test_truncated_scanline_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "pixels are incomplete"):
            self.counts([0, 68, 114])


if __name__ == "__main__":
    unittest.main()
