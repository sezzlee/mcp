import "reflect-metadata";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  Body,
  Controller,
  Patch,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSyntheticContext } from "../src/synthetic-context.js";

interface ProbeFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Controller("probe")
class ProbeController {
  @Post("form")
  form(@Body() body: unknown) {
    return { body: body ?? null };
  }

  @Post("upload")
  @UseInterceptors(FileInterceptor("attachment"))
  upload(@UploadedFile() file: ProbeFile | undefined, @Body() body: unknown) {
    return {
      body: body ?? null,
      file:
        file === undefined
          ? null
          : {
              name: file.originalname,
              type: file.mimetype,
              size: file.size,
              text: file.buffer.toString("utf8"),
            },
    };
  }

  @Post("many")
  @UseInterceptors(FilesInterceptor("files"))
  many(@UploadedFiles() files: ProbeFile[] | undefined) {
    return { names: (files ?? []).map((file) => file.originalname) };
  }

  @Patch("merge")
  merge(@Body() body: unknown) {
    return { body: body ?? null };
  }
}

type Pipeline = (req: IncomingMessage, res: ServerResponse) => void;

let nest: NestExpressApplication;
let pipeline: Pipeline;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
  }).compile();
  nest = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
  });
  await nest.init();
  pipeline = nest.getHttpAdapter().getInstance() as unknown as Pipeline;
});

afterAll(async () => {
  await nest.close();
});

async function send(
  method: string,
  url: string,
  contentType: string,
  body: Buffer,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const context = createSyntheticContext(
    method,
    url,
    { host: "localhost", "content-type": contentType },
    "http",
    body,
  );
  pipeline(context.req, context.res);
  const result = await context.result;
  return {
    status: result.status,
    json: JSON.parse(result.body) as Record<string, unknown>,
  };
}

async function multipart(
  form: FormData,
): Promise<{ contentType: string; body: Buffer }> {
  const response = new Response(form);
  return {
    contentType: response.headers.get("content-type") ?? "",
    body: Buffer.from(await response.arrayBuffer()),
  };
}

/**
 * Pins what the stock Nest Express pipeline does with non-JSON bodies pushed through the synthetic
 * `IncomingMessage`. None of it is a Nest contract: body-parser, qs, multer and busboy decide each
 * fact, so a dependency upgrade that changed one would otherwise surface as a field the handler
 * silently never receives.
 */
describe("form body probes", () => {
  it("N1 parses a urlencoded body with qs brackets, repeated keys and UTF-8 escapes", async () => {
    const { status, json } = await send(
      "POST",
      "/probe/form",
      "application/x-www-form-urlencoded",
      Buffer.from(
        "title=a%20b&tags=x&tags=y&address%5Bcity%5D=%C4%B0zmir&address.zip=35",
        "ascii",
      ),
    );
    expect(status).toBe(201);
    expect(json.body).toEqual({
      title: "a b",
      tags: ["x", "y"],
      address: { city: "İzmir" },
      "address.zip": "35",
    });
  });

  it("N2 runs multer on the synthetic request and keeps text fields as strings", async () => {
    const form = new FormData();
    form.append("title", "t");
    form.append("priority", "3");
    form.append(
      "attachment",
      new Blob(["hello"], { type: "text/csv" }),
      "report.csv",
    );
    const { contentType, body } = await multipart(form);
    const { status, json } = await send(
      "POST",
      "/probe/upload",
      contentType,
      body,
    );
    expect(status).toBe(201);
    expect(json).toEqual({
      body: { title: "t", priority: "3" },
      file: { name: "report.csv", type: "text/csv", size: 5, text: "hello" },
    });
  });

  it("N3 decodes a non-ASCII filename as latin1 unless the part says otherwise", async () => {
    const form = new FormData();
    form.append(
      "attachment",
      new Blob(["x"], { type: "text/plain" }),
      "çizim ğ.txt",
    );
    const { contentType, body } = await multipart(form);
    const { json } = await send("POST", "/probe/upload", contentType, body);
    const file = json.file as { name: string };
    expect(file.name).toBe(
      Buffer.from("çizim ğ.txt", "utf8").toString("latin1"),
    );
  });

  it("N3b decodes an RFC 5987 filename* parameter as UTF-8", async () => {
    const boundary = "probe-boundary";
    const encoded = encodeURIComponent("çizim ğ.txt");
    const body = Buffer.from(
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="attachment"; filename="cizim g.txt"; filename*=UTF-8''${encoded}`,
        "Content-Type: text/plain",
        "",
        "x",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
      "utf8",
    );
    const { json } = await send(
      "POST",
      "/probe/upload",
      `multipart/form-data; boundary=${boundary}`,
      body,
    );
    expect((json.file as { name: string }).name).toBe("çizim ğ.txt");
  });

  it("N4 answers a part under an undeclared field name with 400 Unexpected field", async () => {
    const form = new FormData();
    form.append("wrong", new Blob(["x"]), "a.bin");
    const { contentType, body } = await multipart(form);
    const { status, json } = await send(
      "POST",
      "/probe/upload",
      contentType,
      body,
    );
    expect(status).toBe(400);
    expect(json.message).toMatch(/^Unexpected (file )?field( - wrong)?$/);
  });

  it("N5 repeats a file field for a files interceptor", async () => {
    const form = new FormData();
    form.append("files", new Blob(["a"]), "a.txt");
    form.append("files", new Blob(["b"]), "b.txt");
    const { contentType, body } = await multipart(form);
    const { json } = await send("POST", "/probe/many", contentType, body);
    expect(json.names).toEqual(["a.txt", "b.txt"]);
  });

  /**
   * Guard: Express 5 leaves an unparsed body `undefined` and Express 4 an empty object; either way no
   * field reaches the handler, which is what `body_parser_missing` exists to prevent.
   */
  it("N6 leaves a JSON-suffix body and a text body unparsed under the default parsers", async () => {
    const merge = await send(
      "PATCH",
      "/probe/merge",
      "application/merge-patch+json",
      Buffer.from('{"name":"x"}', "utf8"),
    );
    expect(merge.status).toBe(200);
    expect([null, {}]).toContainEqual(merge.json.body);

    const text = await send(
      "POST",
      "/probe/form",
      "text/plain; charset=utf-8",
      Buffer.from("hello", "utf8"),
    );
    expect([null, {}]).toContainEqual(text.json.body);
  });

  it("N7 names the default parsers on the Express router stack", () => {
    const app = nest.getHttpAdapter().getInstance() as unknown as {
      _router?: { stack: { name: string }[] };
      router: { stack: { name: string }[] };
    };
    const names = (app._router ?? app.router).stack.map((layer) => layer.name);
    expect(names).toContain("jsonParser");
    expect(names).toContain("urlencodedParser");
    expect(names).not.toContain("textParser");
  });
});
