import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { HostRequestError } from "../src/agent/host.ts";
import { OllamaHost } from "../src/agent/ollama.ts";

describe("Ollama thinking wire control", () => {
  /** Guard: https://docs.ollama.com/capabilities/thinking defines false as explicit off; omission uses the model default. */
  it.each([undefined, false, "low"])(
    "preserves the API distinction for think=%s",
    async (think) => {
      const requests: unknown[] = [];
      const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          requests.push(JSON.parse(body));
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.end(
            JSON.stringify({
              message: { content: "Done" },
              done: true,
              prompt_eval_count: 5,
              eval_count: 1,
              load_duration: 0,
              prompt_eval_duration: 1,
              eval_duration: 1,
            }) + "\n",
          );
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing test HTTP port");
      try {
        const host = new OllamaHost({
          baseUrl: `http://127.0.0.1:${address.port}`,
          model: "test-model",
          think,
        });
        const result = await host.chat({
          messages: [{ role: "user", content: "Hi" }],
          tools: [],
          window: 4096,
          temperature: 0,
          timeoutMs: 5000,
          numPredict: 64,
        });
        expect(result).toMatchObject({ kind: "reply", content: "Done" });
        expect(requests).toHaveLength(1);
        if (think === undefined)
          expect(requests[0]).not.toHaveProperty("think");
        else if (think === false)
          expect(requests[0]).toHaveProperty("think", false);
        else expect(requests[0]).toHaveProperty("think", "low");
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});

it("tells a tool call the model wrote unparsably apart from a host failure", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(
      JSON.stringify({
        error:
          'error parsing tool call: raw=\'{"note":"exceeds the context","values":[[0.08"]]}\', err=invalid character \'"\' after array element',
      }) + "\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing test HTTP port");
  try {
    const host = new OllamaHost({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
    });
    const failure = await host
      .chat({
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
        window: 4096,
        temperature: 0,
        timeoutMs: 5000,
        numPredict: 64,
      })
      .then(
        () => null,
        (error: unknown) =>
          error instanceof HostRequestError ? error.failure : error,
      );
    expect(failure).toBe("malformed");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
