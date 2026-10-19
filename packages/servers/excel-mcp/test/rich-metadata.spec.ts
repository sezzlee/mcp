import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { limits } from "../src/platform/limits.js";
import { createExcelMcpServer } from "../src/server.js";
import { richWorkbook } from "./fixtures/rich-workbook.js";

const richNs =
  "http://schemas.microsoft.com/office/spreadsheetml/2017/richdata";
const sheetPart = "xl/worksheets/sheet1.xml";
const metadataPart = "xl/metadata.xml";
const valuesPart = "xl/richData/rdrichvalue.xml";
const structuresPart = "xl/richData/rdrichvaluestructure.xml";
const relationshipsPart = "xl/richData/_rels/richValueRel.xml.rels";
const altText = "店舗 — München — متجر <A&B>";
const escapedAlt = "店舗 — München — متجر &lt;A&amp;B&gt;";
let directory: string;
let client: Client;
let server: ReturnType<typeof createExcelMcpServer>;
let nextFile = 0;

async function edit(
  zip: JSZip,
  part: string,
  transform: (text: string) => string,
): Promise<void> {
  const source = zip.file(part);
  if (source === null) throw new Error(`Fixture part missing: ${part}`);
  zip.file(part, transform(await source.async("string")));
}

async function variant(change: (zip: JSZip) => Promise<void>): Promise<string> {
  const zip = await JSZip.loadAsync(richWorkbook());
  await change(zip);
  const file = `variant-${nextFile++}.xlsx`;
  await writeFile(
    join(directory, file),
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return file;
}

async function request(
  name: string,
  filePath: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await client.callTool({
    name,
    arguments: { filePath, sheetName: "Rich", ...args },
  });
  const content = response.content[0];
  if (content?.type !== "text") throw new Error("Missing text response");
  return {
    ...(JSON.parse(content.text) as Record<string, unknown>),
    isError: response.isError === true,
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-rich-metadata-"));
  server = createExcelMcpServer(await createWorkbookRoot(directory));
  client = new Client({ name: "rich-metadata-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
});
afterAll(async () => {
  await client.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

describe("rich metadata indices and bounded presentation", () => {
  it.each(["read_sheet", "get_images"] as const)(
    "keeps relocated rich images distinct and IDs stable when %s opens another sheet first",
    async (firstTool) => {
      const file = await variant(async (zip) => {
        for (const [source, target] of [
          ["xl/media/image1.png", "xl/richAssets/z.png"],
          ["xl/media/image2.png", "xl/richAssets/a.png"],
        ] as const) {
          const image = zip.file(source);
          if (image === null) throw new Error(`Missing source image ${source}`);
          zip.file(target, await image.async("nodebuffer"));
        }
        await edit(zip, relationshipsPart, (text) =>
          text
            .replace("../media/image1.png", "/xl/richAssets/z.png")
            .replace("../media/image2.png", "../richAssets/a.png"),
        );
        zip.file(
          valuesPart,
          `<rvData xmlns="${richNs}" count="3"><rv s="0"><v>0</v><v>6</v></rv><rv s="0"><v>1</v><v>6</v></rv><rv s="999"><v>unused invalid record</v></rv></rvData>`,
        );
        await edit(zip, "xl/worksheets/sheet2.xml", (text) =>
          text
            .replace(
              /<c r="A2"[^>]*>[\s\S]*?<\/c>/,
              '<c r="A2" t="e" vm="2"><v>#VALUE!</v></c>',
            )
            .replace(
              /<c r="B2"[^>]*>[\s\S]*?<\/c>/,
              '<c r="B2" t="e" vm="1"><v>#VALUE!</v></c>',
            ),
        );
      });
      const secondSheet = {
        sheetName: "Records",
        range: "A2:B2",
        headerRow: 0,
      };
      const first = await request(
        firstTool,
        file,
        firstTool === "read_sheet" ? secondSheet : { sheetName: "Records" },
      );
      expect(first["isError"]).toBe(false);
      const rows = [
        [{ imageId: 3, decorative: true }],
        [{ imageId: 2, decorative: true }],
      ];
      expect(
        (await request("read_sheet", file, { range: "A2:A3" }))["values"],
      ).toEqual(rows);
      expect(
        (await request("read_sheet", file, secondSheet))["values"],
      ).toEqual([
        [
          { imageId: 2, decorative: true },
          { imageId: 3, decorative: true },
        ],
      ]);
      expect((await request("get_images", file))["images"]).toEqual([
        expect.objectContaining({ imageId: 3, cell: "A2", anchor: "inCell" }),
        expect.objectContaining({ imageId: 2, cell: "A3", anchor: "inCell" }),
      ]);
      expect(
        (await request("get_images", file, { sheetName: "Records" }))["images"],
      ).toEqual([
        expect.objectContaining({ imageId: 2, cell: "A2", anchor: "inCell" }),
        expect.objectContaining({ imageId: 3, cell: "B2", anchor: "inCell" }),
      ]);
      expect(
        (
          await request("aggregate_sheet", file, {
            range: "A2:A3",
            headerRow: 0,
            columnMode: "letter",
            metrics: [
              { fn: "countValues", column: "A" },
              { fn: "countDistinct", column: "A" },
            ],
          })
        )["rows"],
      ).toEqual([[2, 2]]);
    },
  );

  it("reports drawing alternative text and its decorative extension alongside in-cell images", async () => {
    const relNs =
      "http://schemas.openxmlformats.org/package/2006/relationships";
    const office =
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const file = await variant(async (zip) => {
      await edit(zip, sheetPart, (text) =>
        text.replace("</worksheet>", '<drawing r:id="rDrawing"/></worksheet>'),
      );
      zip.file(
        "xl/worksheets/_rels/sheet1.xml.rels",
        `<Relationships xmlns="${relNs}"><Relationship Id="rDrawing" Type="${office}/drawing" Target="../drawings/alt.xml"/></Relationships>`,
      );
      zip.file(
        "xl/drawings/alt.xml",
        `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${office}"><xdr:oneCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="19050" cy="19050"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Original pixels" descr="${escapedAlt}"><a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst></xdr:cNvPr><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rImage"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`,
      );
      zip.file(
        "xl/drawings/_rels/alt.xml.rels",
        `<Relationships xmlns="${relNs}"><Relationship Id="rImage" Type="${office}/image" Target="../media/image1.png"/></Relationships>`,
      );
    });
    const report = await request("get_images", file);
    expect(report["isError"]).toBe(false);
    expect(report["count"]).toBe(3);
    expect(report["images"]).toEqual([
      expect.objectContaining({
        imageId: 0,
        anchor: "oneCell",
        cell: "C5",
        widthPx: 2,
        heightPx: 2,
        altText,
        decorative: true,
      }),
      expect.objectContaining({
        imageId: 0,
        anchor: "inCell",
        cell: "A2",
        altText,
        decorative: false,
      }),
      expect.objectContaining({
        imageId: 1,
        anchor: "inCell",
        cell: "A3",
        decorative: true,
      }),
    ]);
  });

  it("selects metadata types, structures and value fields by their declared indices and names", async () => {
    const file = await variant(async (zip) => {
      await edit(zip, metadataPart, (text) =>
        text
          .replace(
            /(<metadataType name="XLDAPR"[^>]*\/>)(<metadataType name="XLRICHVALUE"[^>]*\/>)/,
            "$2$1",
          )
          .replace(
            /<rc t="([12])"/g,
            (_match, type: string) => `<rc t="${type === "1" ? "2" : "1"}"`,
          ),
      );
      zip.file(
        structuresPart,
        `<rvStructures xmlns="${richNs}" count="3"><s t="_unrelated"><k n="Unrelated" t="s"/></s><s t="_localImage"><k n="Text" t="s"/><k n="CalcOrigin" t="i"/><k n="_rvRel:LocalImageIdentifier" t="i"/></s><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/><k n="Text" t="s"/></s></rvStructures>`,
      );
      zip.file(
        valuesPart,
        `<rvData xmlns="${richNs}" count="2"><rv s="1"><v>${escapedAlt}</v><v>5</v><v>0</v></rv><rv s="2"><v>1</v><v>6</v></rv></rvData>`,
      );
    });
    expect(
      (await request("read_sheet", file, { range: "A2:A3", headerRow: 1 }))[
        "values"
      ],
    ).toEqual([
      [{ imageId: 0, altText, decorative: false }],
      [{ imageId: 1, decorative: true }],
    ]);
    expect(
      (await request("read_sheet", file, { range: "C2:C4", headerRow: 1 }))[
        "cellNotes"
      ],
    ).toMatchObject({
      C3: { kind: "array", array: { anchor: "C2", dynamic: true } },
    });
  });

  it("uses rc.v to select a reordered future block", async () => {
    const file = await variant(async (zip) => {
      await edit(zip, metadataPart, (text) =>
        text
          .replace(
            /(<futureMetadata name="XLRICHVALUE"[^>]*>)(<bk>[\s\S]*?<\/bk>)(<bk>[\s\S]*?<\/bk>)/,
            "$1$3$2",
          )
          .replace(
            /(<valueMetadata[^>]*>)([\s\S]*?)(<\/valueMetadata>)/,
            (_match, open: string, body: string, close: string) =>
              open +
              body.replace(
                /v="([01])"/g,
                (_record, value: string) => `v="${value === "0" ? "1" : "0"}"`,
              ) +
              close,
          ),
      );
    });
    expect(
      (await request("read_sheet", file, { range: "A2:A3" }))["values"],
    ).toEqual([
      [{ imageId: 0, altText, decorative: false }],
      [{ imageId: 1, decorative: true }],
    ]);
  });

  it("keeps sparse vm/cm attached to the final sorted cell after duplicate coordinates", async () => {
    const file = await variant(async (zip) => {
      await edit(zip, sheetPart, (text) =>
        text.replace(
          /<sheetData>[\s\S]*?<\/sheetData>/,
          '<sheetData><row r="3"><c r="A3" t="e" vm="2"><v>#VALUE!</v></c></row><row r="2"><c r="A2" t="e" vm="1"><v>#VALUE!</v></c><c r="A2" t="e" vm="2"><v>#VALUE!</v></c></row><row r="5"><c r="C5" cm="1"><f t="array" ref="C5:C6">_xlfn.SEQUENCE(2,1,4,2)</f><v>4</v></c></row><row r="6"><c r="C6"><v>6</v></c></row></sheetData>',
        ),
      );
    });
    expect(
      (await request("read_sheet", file, { range: "A2:A3", headerRow: 0 }))[
        "values"
      ],
    ).toEqual([
      [{ imageId: 1, decorative: true }],
      [{ imageId: 1, decorative: true }],
    ]);
    const images = await request("get_images", file);
    expect(images["count"]).toBe(2);
    expect(
      (await request("read_sheet", file, { range: "C5:C6", headerRow: 0 }))[
        "cellNotes"
      ],
    ).toMatchObject({
      C6: { array: { anchor: "C5", ref: "C5:C6", dynamic: true } },
    });
  });

  it.each([
    [sheetPart, 'vm="1"', 'vm="999"', "cell value metadata"],
    [sheetPart, 'cm="1"', 'cm="999"', "cell metadata"],
    [metadataPart, '<rc t="2"', '<rc t="999"', "metadata type"],
    [metadataPart, 'rvb i="0"', 'rvb i="999"', "rich value"],
    [valuesPart, '<rv s="0">', '<rv s="999">', "structure"],
    [valuesPart, "<v>0</v>", "<v>999</v>", "image relationship index"],
    [
      relationshipsPart,
      'Target="../media/image1.png"',
      'Target="https://example.invalid/image.png" TargetMode="External"',
      "external image",
    ],
    [
      relationshipsPart,
      '/relationships/image"',
      '/relationships/hyperlink"',
      "wrong relationship type",
    ],
  ])("refuses an invalid %s chain at %s", async (part, before, after) => {
    const file = await variant(async (zip) => {
      await edit(zip, part, (text) => {
        if (!text.includes(before))
          throw new Error("Fixture mutation did not match");
        return text.replace(before, after);
      });
    });
    const result = await request("read_sheet", file, { range: "A2:C3" });
    expect(result["isError"]).toBe(true);
    expect(result["error"]).toBe("corrupt_workbook");
  });

  it("retains the fallback with an explicit note for an unsupported rich structure", async () => {
    const file = await variant(async (zip) => {
      await edit(zip, structuresPart, (text) =>
        text.replace('t="_localImage"', 't="_unhandledType"'),
      );
    });
    const result = await request("read_sheet", file, { range: "A2:A3" });
    expect(result["values"]).toEqual([
      [{ error: "#VALUE!" }],
      [{ error: "#VALUE!" }],
    ]);
    expect(result["cellNotes"]).toMatchObject({
      A2: { kind: "richValue", type: "_unhandledType", supported: false },
    });
  });

  it.each(["formula", "hyperlink", "truncated"] as const)(
    "preserves unsupported rich metadata alongside a %s note",
    async (kind) => {
      const file = await variant(async (zip) => {
        await edit(zip, structuresPart, (text) =>
          text.replace('t="_localImage"', 't="_unhandledType"'),
        );
        await edit(zip, sheetPart, (text) => {
          if (kind === "formula")
            return text.replace(
              '<c r="A2" t="e" vm="1"><v>',
              '<c r="A2" t="e" vm="1"><f>SUM(1)</f><v>',
            );
          if (kind === "hyperlink")
            return text.replace(
              "</worksheet>",
              '<hyperlinks><hyperlink ref="A2" location="Other!A1"/></hyperlinks></worksheet>',
            );
          return text.replace(
            '<c r="A2" t="e" vm="1"><v>#VALUE!</v>',
            `<c r="A2" t="str" vm="1"><v>${"x".repeat(600)}</v>`,
          );
        });
      });
      const result = await request("read_sheet", file, {
        range: "A2:A2",
        valueMode: "both",
        includeHyperlinks: true,
      });
      expect(result["isError"]).toBe(false);
      expect(result["cellNotes"]).toMatchObject({
        A2: {
          kind,
          richValue: {
            type: "_unhandledType",
            supported: false,
            explanation: expect.stringContaining("compatibility value"),
          },
        },
      });
    },
  );

  it("does not label a legacy array formula dynamic without the cm metadata", async () => {
    const file = await variant(async (zip) => {
      await edit(zip, sheetPart, (text) => text.replace(' cm="1"', ""));
    });
    const result = await request("read_sheet", file, { range: "C2:C4" });
    expect(result["values"]).toEqual([[10], [20], [30]]);
    expect(result["cellNotes"]).toMatchObject({
      C3: {
        kind: "array",
        array: { anchor: "C2", ref: "C2:C4", dynamic: false },
      },
    });
    expect(JSON.stringify(result["cellNotes"])).not.toContain('"collapsed"');
  });

  it("searches full alt text but clips every returned image and profile example", async () => {
    const long = "漢字🌍".repeat(1000) + "TAIL";
    const file = await variant(async (zip) => {
      await edit(zip, valuesPart, (text) => text.replace(escapedAlt, long));
    });
    const found = await request("find_in_sheet", file, {
      query: "TAIL",
      matchMode: "contains",
    });
    expect(found["total"]).toBe(1);
    expect(found["matches"]).toEqual([
      expect.objectContaining({
        value: { imageId: 0, altText: long.slice(0, 512), decorative: false },
      }),
    ]);
    const read = await request("read_sheet", file, { range: "A2:A3" });
    expect(read["cellNotes"]).toMatchObject({
      A2: { kind: "truncated", length: long.length },
    });
    const images = await request("get_images", file);
    expect(images["images"]).toEqual([
      expect.objectContaining({
        altText: long.slice(0, 512),
        altTextTruncatedFrom: long.length,
      }),
      expect.objectContaining({ decorative: true }),
    ]);
    const profile = await request("profile_sheet", file, {
      range: "A1:A3",
      headerRow: 1,
    });
    expect(profile["isError"]).toBe(false);
    expect(JSON.stringify(profile)).not.toContain(long.slice(0, 161));
    expect(JSON.stringify(profile)).toContain('"inferredType":"image"');
  });

  it("keeps a large image report and grid within the existing MCP byte budget", async () => {
    const long = "漢字🌍".repeat(1000);
    const file = await variant(async (zip) => {
      await edit(zip, valuesPart, (text) => text.replace(escapedAlt, long));
      const rows = Array.from(
        { length: 300 },
        (_, index) =>
          `<row r="${index + 1}"><c r="A${index + 1}" t="e" vm="1"><v>#VALUE!</v></c></row>`,
      ).join("");
      await edit(zip, sheetPart, (text) =>
        text.replace(
          /<sheetData>[\s\S]*?<\/sheetData>/,
          `<sheetData>${rows}</sheetData>`,
        ),
      );
    });
    const images = await request("get_images", file);
    expect(images["isError"]).toBe(false);
    expect(images["count"]).toBe(300);
    expect(images["images"]).toHaveLength(200);
    expect(images["truncated"]).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(images))).toBeLessThan(
      limits.maxPayloadBytes,
    );
    const read = await request("read_sheet", file, {
      headerRow: 0,
      maxCells: 10000,
    });
    expect(read["isError"]).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThan(
      limits.maxPayloadBytes,
    );
  });
});
