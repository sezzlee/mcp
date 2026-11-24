import { createOllamaOcrProvider } from "@sezzlee/ocr-ollama";
import type {
  OcrProvider as AdapterOcrProvider,
  RecognizeJob as AdapterRecognizeJob,
  RecognizedPage as AdapterRecognizedPage,
  RenderedPage as AdapterRecognizedInput,
} from "@sezzlee/ocr-ollama";
import { createPdfjsRasterizer } from "@sezzlee/pdf-raster-pdfjs";
import type {
  PageRasterizer as AdapterPageRasterizer,
  RenderJob as AdapterRenderJob,
  RenderedPage as AdapterRenderedPage,
} from "@sezzlee/pdf-raster-pdfjs";
import { describe, expect, it } from "vitest";
import { asOcrBinding } from "../src/ocr/load.js";
import type {
  OcrBinding,
  OcrProvider,
  PageRasterizer,
  RecognizeJob,
  RecognizedPage,
  RenderJob,
  RenderedPage,
} from "../src/ocr/port.js";
import { SezzleePdfError } from "../src/platform/errors.js";

/**
 * Port compatibility, checked where method syntax hides it.
 *
 * Guard: `recognize` and `render` are declared with method syntax, so TypeScript
 * checks their parameters bivariantly — a plain
 * `const provider: OcrProvider = adapterProvider` keeps compiling after an
 * adapter has narrowed what it is willing to accept. Restating each call as a
 * property gets the contravariant check that strictFunctionTypes performs, which
 * is the one that matters: an adapter must accept every job pdf-mcp can send.
 *
 * Output is checked covariantly so an adapter can support a subset of MIME types.
 */
type StrictPageRasterizer = {
  readonly render: (job: RenderJob) => Promise<readonly RenderedPage[]>;
};

type StrictOcrProvider = {
  readonly name: string;
  readonly recognize: (job: RecognizeJob) => Promise<readonly RecognizedPage[]>;
};

function assertPortCompatible<_T extends true>(): void {
  // The assertion lives entirely in the type argument.
}

describe("port copies stay compatible", () => {
  it("keeps the pdf.js rasterizer able to accept every render job", () => {
    assertPortCompatible<
      AdapterPageRasterizer extends StrictPageRasterizer ? true : false
    >();
    assertPortCompatible<RenderJob extends AdapterRenderJob ? true : false>();
    assertPortCompatible<
      AdapterRenderedPage extends RenderedPage ? true : false
    >();
    expect(true).toBe(true);
  });

  it("keeps the Ollama provider able to accept every recognize job", () => {
    assertPortCompatible<
      AdapterOcrProvider extends StrictOcrProvider ? true : false
    >();
    assertPortCompatible<
      RecognizeJob extends AdapterRecognizeJob ? true : false
    >();
    assertPortCompatible<
      RenderedPage extends AdapterRecognizedInput ? true : false
    >();
    assertPortCompatible<
      AdapterRecognizedPage extends RecognizedPage ? true : false
    >();
    expect(true).toBe(true);
  });
});

describe("adapter conformance", () => {
  it("accepts the pdf.js rasterizer as a PageRasterizer", () => {
    const rasterizer: PageRasterizer = createPdfjsRasterizer();
    expect(typeof rasterizer.render).toBe("function");
  });

  it("accepts the Ollama provider as an OcrProvider", () => {
    const provider: OcrProvider = createOllamaOcrProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "deepseek-ocr:3b",
    });
    expect(provider.name).toBe("ollama/deepseek-ocr:3b");
  });

  it("composes the two into an OcrBinding", () => {
    const binding: OcrBinding = {
      rasterizer: createPdfjsRasterizer(),
      provider: createOllamaOcrProvider({
        baseUrl: "http://127.0.0.1:11434",
        model: "deepseek-ocr:3b",
      }),
    };
    expect(asOcrBinding(binding, "inline")).toBe(binding);
  });
});

describe("binding validation", () => {
  it.each([
    ["undefined", undefined],
    ["a plain object", {}],
    ["a rasterizer alone", { rasterizer: { render: () => [] } }],
    [
      "a provider with no recognize",
      { rasterizer: { render: () => [] }, provider: { name: "x" } },
    ],
  ])("refuses %s before any document is opened", (_label, value) => {
    expect(() => asOcrBinding(value, "broken")).toThrow(SezzleePdfError);
  });

  it("refuses a provider with no name", () => {
    expect(() =>
      asOcrBinding(
        {
          rasterizer: { render: () => [] },
          provider: { name: "", recognize: () => [] },
        },
        "nameless",
      ),
    ).toThrow(/no name/);
  });
});
