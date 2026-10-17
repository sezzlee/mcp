import { performance } from "node:perf_hooks";
import { createOoxmlReader } from "@sezzlee/ooxml-core";
import { parseArgs } from "node:util";
import { z } from "zod";
import { cellWorkload, fingerprintVisitor, parserNames } from "./events.ts";
import { parsers } from "./parsers.ts";
import { decodedParts } from "./parts.ts";

const argsSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("verify"), file: z.string().min(1) }),
  z.object({
    mode: z.literal("time"),
    file: z.string().min(1),
    parser: z.enum([...parserNames, "core", "none"]),
  }),
]);

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    file: { type: "string" },
    parser: { type: "string" },
  },
});
const args = argsSchema.parse(values);
const parts = await decodedParts(args.file);

if (args.mode === "verify") {
  const report = parts.map((part) => {
    const outcomes = parserNames.map((name) => {
      const print = fingerprintVisitor();
      const outcome = parsers[name](part.xml, print.visitor);
      return outcome.kind === "read"
        ? { parser: name, kind: "read" as const, ...print.digest() }
        : { parser: name, kind: "refused" as const, reason: outcome.reason };
    });
    return { part: part.name, bytes: part.xml.length, outcomes };
  });
  process.stdout.write(`${JSON.stringify({ parts: report })}\n`);
} else {
  const baseRssKiB = process.resourceUsage().maxRSS;
  const core = createOoxmlReader({ fail: (_, message) => new Error(message) });
  const parser =
    args.parser === "none"
      ? undefined
      : args.parser === "core"
        ? (
            xml: string,
            visitor: ReturnType<typeof cellWorkload>["visitor"],
          ) => {
            try {
              core.readXmlPart(xml, "part.xml", visitor);
              return { kind: "read" as const };
            } catch {
              return { kind: "refused" as const };
            }
          }
        : parsers[args.parser];
  const start = performance.now();
  let cells = 0;
  let refused = 0;
  if (parser !== undefined) {
    for (const part of parts) {
      const work = cellWorkload();
      if (parser(part.xml, work.visitor).kind === "refused") refused += 1;
      cells += work.result().cells;
    }
  }
  const ms = performance.now() - start;
  process.stdout.write(
    `${JSON.stringify({
      ms,
      cells,
      refused,
      partChars: parts.reduce((sum, part) => sum + part.xml.length, 0),
      baseRssKiB,
      maxRssKiB: process.resourceUsage().maxRSS,
    })}\n`,
  );
}
