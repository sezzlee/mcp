# @sezzlee/pdf-raster-pdfjs

An implementation of `@sezzlee/pdf-mcp`'s `PageRasterizer` port, backed by pdf.js: it renders a
PDF page to PNG or JPEG. A binding supplies the rasterizer to the server.

## Quick start

```ts
import { createPdfjsRasterizer } from "@sezzlee/pdf-raster-pdfjs";

createPdfMcpServer(root, {
  ocr: { rasterizer: createPdfjsRasterizer(), provider, dpi: 200 },
  pageImages: {
    rasterizer: createPdfjsRasterizer({ format: "jpeg" }),
    dpi: 144,
  },
});
```

Pair it with `@sezzlee/ocr-ollama` to build a full `OcrBinding` for `pdf-mcp` — see that package's
README and `packages/servers/pdf-mcp/examples/ollama-binding.ts`.

## API

| Export                           | What it does                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `createPdfjsRasterizer(options)` | Renders each requested page to a `RenderedPage` with `mediaType` set to `image/png` or `image/jpeg`. |

### `PdfjsRasterizerOptions`

| Option        | Default | Meaning                                              |
| ------------- | ------- | ---------------------------------------------------- |
| `maxPixels`   | `4000`  | Upper bound on either rendered dimension, in pixels. |
| `format`      | `"png"` | Output format, `"png"` or `"jpeg"`.                  |
| `jpegQuality` | `80`    | Integer from 1 to 100. Applied when encoding JPEG.   |

## How it plugs into pdf-mcp

`pdf-mcp` defines the `PageRasterizer` port in `src/ocr/port.ts` and never imports this package —
the type is declared structurally here (`src/port.ts`) so the dependency graph stays acyclic and
`pdf-mcp` can devDepend on this package without a cycle. `createPdfjsRasterizer`'s result
satisfies that port as the `rasterizer` in a `PageImageBinding` or an `OcrBinding`.
Compile-time compatibility between the ports is checked by `pdf-mcp/test/adapters.spec.ts`.

The page-image binding accepts `dpi` (144 by default, up to 200), `maxPagesPerCall` (4 by default
and at most), `maxImageBytes` (512 KiB by default, up to 2 MiB per image before base64), and
`timeoutMs` (20,000 ms by default and at most). The server limits the serialized image result
to 8 MiB and refuses the entire result if it exceeds either byte limit.

## Measured output sizes

The table shows the largest encoded page in each renderable fixture in bytes, before base64.
JPEG used quality 80 and both formats used the default dimension cap. Measurements used the
adapter and server test fixtures and the two checked-in sample PDFs. The image-only
`scanned.pdf` fixture stretches a 2 × 2 pixel image, so a supplemental image-only A4 PDF was
generated locally in a temporary directory. It embeds a 1190 × 1684 RGB image with a table and
seeded paper texture to exercise compression on a more detailed page.

| Fixture                 | Pages | PNG 72 DPI | JPEG 72 DPI | PNG 144 DPI | JPEG 144 DPI | PNG 200 DPI | JPEG 200 DPI |
| ----------------------- | ----: | ---------: | ----------: | ----------: | -----------: | ----------: | -----------: |
| Adapter text fixture    |     3 |      6,865 |       4,941 |      17,797 |       15,413 |      28,522 |       27,726 |
| `text.pdf`              |     3 |     15,044 |       9,593 |      33,966 |       25,208 |      52,557 |       43,360 |
| `scanned.pdf`           |     1 |      3,718 |       9,397 |      11,277 |       19,036 |      19,693 |       37,605 |
| `mixed.pdf`             |     3 |     10,465 |       9,397 |      24,174 |       20,136 |      38,578 |       37,605 |
| `many.pdf`              |    40 |      9,084 |       6,181 |      22,229 |       17,961 |      35,680 |       31,988 |
| `wide.pdf`              |     2 |      6,703 |       9,531 |      17,471 |       27,444 |      28,086 |       47,891 |
| `alternating.pdf`       |     4 |      6,761 |       9,397 |      17,527 |       19,036 |      28,485 |       37,605 |
| `long.pdf`              |     2 |     94,858 |      53,856 |     190,218 |      132,164 |     278,838 |      214,036 |
| `annual-report.pdf`     |     4 |     34,132 |      19,416 |      81,127 |       56,107 |     121,461 |       88,182 |
| `supply-agreement.pdf`  |     3 |     60,946 |      24,824 |     192,252 |       69,157 |     316,649 |      109,075 |
| `synthetic-a4-scan.pdf` |     1 |  1,018,525 |      75,696 |   4,623,493 |      323,468 |   5,471,461 |      628,600 |

JPEG is lossy. It fits the 512 KiB default for the synthetic scan at 144 DPI. At 200 DPI that
JPEG needs a higher binding limit. The PNG at 144 DPI exceeds even the 2 MiB ceiling.

## Rules

- **Dependency versions are exact-pinned, no caret.** pdf.js 5 together with `@napi-rs/canvas`
  1.x fails at `ctx.fill(path)` with `Value is none of these types String, Path` the moment the
  first glyph is drawn. The measured working pair is `pdfjs-dist@4.10.38` +
  `@napi-rs/canvas@0.1.100`. Re-measure before moving either pin; `check-npm-tarballs.py` checks
  that both stay pinned.
- **`standardFontDataUrl` is required.** Without it, pdf.js skips every glyph of a non-embedded
  font: the page comes back the right size, error-free, and **blank**. An OCR model would
  faithfully report that as "empty page" — a silent wrong answer.
- **The page is painted white.** A PDF page has no background of its own. A transparent canvas
  can flatten to black during encoding.
- **Page numbers are 1-based**, matching the port's surface. An out-of-range request is refused.
- **A `maxPixels` ceiling bounds the image** regardless of how high `dpi` is set (default 4000
  px).

## Development

```sh
pnpm turbo run build --filter=@sezzlee/pdf-raster-pdfjs
pnpm turbo run test --filter=@sezzlee/pdf-raster-pdfjs
```
