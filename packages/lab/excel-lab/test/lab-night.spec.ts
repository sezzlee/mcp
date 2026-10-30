import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";

const chatSchema = z.object({
  tools: z.array(z.unknown()),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
      thinking: z.string().optional(),
    }),
  ),
});
const versionSchema = z.object({ filePath: z.string(), versionId: z.string() });

it.each(["unchanged", "reserve_last"] as const)(
  "runs matrix history and %s finalization through the CLI to the host wire",
  async (finalization) => {
    const directory = await mkdtemp(join(tmpdir(), "lab-night-history-"));
    const marker = "private diagnostic reasoning";
    const histories: z.infer<typeof chatSchema>["messages"][number][] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        try {
          response.setHeader("content-type", "application/x-ndjson");
          if (request.url === "/api/tags") {
            response.end(
              JSON.stringify({
                models: [{ name: "fixture", digest: "fixed" }],
              }),
            );
            return;
          }
          if (request.url === "/api/version") {
            response.end(JSON.stringify({ version: "fixture" }));
            return;
          }
          if (request.url === "/api/ps") {
            response.end(JSON.stringify({ models: [] }));
            return;
          }
          assert.equal(request.url, "/api/chat");
          const { messages, tools } = chatSchema.parse(JSON.parse(body));
          const assistant = messages.find(
            (entry) => entry.role === "assistant",
          );
          let message;
          if (assistant === undefined) {
            const brief = messages.find(
              (entry) => entry.role === "user",
            )?.content;
            const encoded = brief?.match(/\{[^}]+\}/)?.[0];
            assert(encoded !== undefined);
            const source = versionSchema.parse(JSON.parse(encoded));
            message = {
              content: "",
              thinking: marker,
              tool_calls: [
                {
                  function: {
                    name: "calculate_workbook",
                    arguments: { source },
                  },
                },
              ],
            };
          } else {
            histories.push(assistant);
            const tool = messages
              .slice()
              .reverse()
              .find((entry) => entry.role === "tool");
            assert(tool !== undefined);
            const receipt = z
              .object({ version: versionSchema })
              .parse(JSON.parse(tool.content));
            message =
              finalization === "reserve_last" && tools.length > 0
                ? {
                    content: "",
                    tool_calls: [
                      {
                        function: {
                          name: "read_sheet",
                          arguments: {
                            filePath: receipt.version.filePath,
                            sheetName: "Budget",
                            range: "C3",
                            headerRow: 0,
                          },
                        },
                      },
                    ],
                  }
                : {
                    content: JSON.stringify({
                      filePath: receipt.version.filePath,
                      total: 40,
                    }),
                  };
          }
          response.end(
            JSON.stringify({ message, done: true, done_reason: "stop" }) + "\n",
          );
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: String(error) }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    try {
      const matrix = join(directory, "matrix.json");
      const out = join(directory, "run");
      await writeFile(
        matrix,
        JSON.stringify({
          only: ["calc/calculate"],
          languages: ["en"],
          conditions: [
            { name: "product", thinking: "product", finalization },
            { name: "field", thinking: "field", finalization },
          ],
          models: [{ name: "fixture" }],
          hours: 1,
        }),
      );
      await promisify(execFile)(
        process.execPath,
        ["src/lab/night-cli.ts", "--out", out, "--matrix", matrix],
        {
          cwd: new URL("../", import.meta.url),
          env: {
            ...process.env,
            SEZZLEE_AGENT_LAB_OLLAMA_URL: `http://127.0.0.1:${address.port}`,
          },
          timeout: 15_000,
        },
      );
      expect(histories).toEqual([
        ...Array.from(
          { length: finalization === "reserve_last" ? 9 : 1 },
          () => ({ role: "assistant", content: marker }),
        ),
        ...Array.from(
          { length: finalization === "reserve_last" ? 9 : 1 },
          () => ({ role: "assistant", content: "", thinking: marker }),
        ),
      ]);
      const recordSchema = z.object({ passed: z.boolean() });
      for (const condition of ["product", "field"]) {
        const results = await readFile(
          join(out, "fixture", condition, "results.jsonl"),
          "utf8",
        );
        expect(
          results
            .trim()
            .split("\n")
            .map((line) => recordSchema.parse(JSON.parse(line)).passed),
        ).toEqual([true]);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
