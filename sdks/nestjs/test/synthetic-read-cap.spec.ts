import { describe, expect, it } from "vitest";
import {
  createSyntheticContext,
  SezzleeResponseTooLarge,
} from "../src/synthetic-context.js";

const contextWithCap = (maxBytes: number) =>
  createSyntheticContext(
    "GET",
    "/",
    { host: "localhost" },
    "http",
    undefined,
    undefined,
    maxBytes,
  );

describe("the synthetic response's read cap", () => {
  it("refuses writes that cross the cap together, with the status, and ignores what follows", async () => {
    const { res, result } = contextWithCap(10);
    let finished = 0;
    res.on("finish", () => {
      finished += 1;
    });
    res.statusCode = 403;
    res.write("12345");
    res.write("67890");
    res.write("1");
    res.end("after");

    const refused = await result.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(SezzleeResponseTooLarge);
    expect(refused).toMatchObject({ limit: 10, status: 403 });
    expect(finished).toBe(0);
  });

  it.each([
    { chunk: "ççççç", encoding: "utf8", cap: 10, body: "ççççç" },
    { chunk: "aGVsbG8=", encoding: "base64", cap: 5, body: "hello" },
  ] as const)(
    "admits $encoding text of exactly the cap, counted in bytes",
    async ({ chunk, encoding, cap, body }) => {
      const { res, result } = contextWithCap(cap);
      res.end(chunk, encoding);
      expect((await result).body).toBe(body);
    },
  );

  it.each([
    { chunk: "ççççç", encoding: "utf8", cap: 9 },
    { chunk: "aGVsbG8=", encoding: "base64", cap: 4 },
  ] as const)(
    "refuses $encoding text one byte over the cap",
    async ({ chunk, encoding, cap }) => {
      const { res, result } = contextWithCap(cap);
      res.end(chunk, encoding);
      await expect(result).rejects.toBeInstanceOf(SezzleeResponseTooLarge);
    },
  );
});
