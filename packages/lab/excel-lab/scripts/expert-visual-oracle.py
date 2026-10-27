import argparse
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path


def palette_bands(path, bands):
    data = Path(path).read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Rendered page is not PNG")
    offset, compressed, width, height, channels = 8, bytearray(), 0, 0, 0
    while offset + 12 <= len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        body = data[offset + 8:offset + 8 + size]
        if kind == b"IHDR":
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or color not in (2, 6) or compression or filtering or interlace:
                raise ValueError("Unsupported rendered PNG profile")
            channels = 3 if color == 2 else 4
        if kind == b"IDAT":
            compressed.extend(body)
        offset += size + 12
    if not width or not height or width * height > 8_000_000 or bands < 1:
        raise ValueError("Rendered page exceeds the visual budget")
    stride = width * channels
    decoder = zlib.decompressobj()
    raw = decoder.decompress(compressed, height * (stride + 1) + 1)
    if len(raw) != height * (stride + 1) or not decoder.eof:
        raise ValueError("Rendered PNG pixels are incomplete")
    previous = bytearray(stride)
    counts = [0] * bands
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        row = bytearray(raw[start + 1:start + stride + 1])
        for x in range(stride):
            left = row[x - channels] if x >= channels else 0
            up = previous[x]
            corner = previous[x - channels] if x >= channels else 0
            if kind == 1:
                row[x] = (row[x] + left) & 255
            elif kind == 2:
                row[x] = (row[x] + up) & 255
            elif kind == 3:
                row[x] = (row[x] + (left + up) // 2) & 255
            elif kind == 4:
                estimate = left + up - corner
                distances = [abs(estimate - left), abs(estimate - up), abs(estimate - corner)]
                predictor = [left, up, corner][distances.index(min(distances))]
                row[x] = (row[x] + predictor) & 255
            elif kind != 0:
                raise ValueError("Invalid PNG scanline filter")
        for x in range(0, stride, channels):
            if row[x:x + 3] == b"\x44\x72\xc4":
                counts[min(bands - 1, y * bands // height)] += 1
        previous = row
    return counts


def check(workbook, out, charts):
    workbook, out = Path(workbook).resolve(), Path(out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    office, raster = shutil.which("soffice"), shutil.which("pdftoppm")
    if office is None or raster is None:
        raise ValueError("LibreOffice and pdftoppm are required for visual acceptance")
    with tempfile.TemporaryDirectory(prefix="expert-visual-profile-") as profile:
        command = [office, "-env:UserInstallation=" + Path(profile).as_uri(), "--headless", "--convert-to", 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}', "--outdir", str(out), str(workbook)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise ValueError("PDF rendering failed: " + result.stderr[-500:])
    pdf = out / (workbook.stem + ".pdf")
    result = subprocess.run([raster, "-r", "100", "-png", "-f", "2", "-l", "2", "-scale-to", "2400", str(pdf), str(out / "report")], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise ValueError("PDF rasterization failed: " + result.stderr[-500:])
    png = out / "report-2.png"
    counts = palette_bands(png, charts)
    if any(count < 250 for count in counts):
        raise ValueError("An expert-report chart has no visible plotted series: " + json.dumps(counts))
    return {"passed": True, "page": str(png), "chartBands": charts, "seriesColorPixels": counts}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook")
    parser.add_argument("--out", required=True)
    parser.add_argument("--charts", required=True, type=int)
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.workbook, args.out, args.charts)))
    except Exception as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        sys.exit(1)
