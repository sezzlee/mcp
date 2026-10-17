import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { conformanceCases, runCase } from "./fixtures/xml-conformance.js";

/**
 * The W3C XML Conformance Test Suite (xmlts20130923), read where it lives
 * beside the corpus: its James Clark part may be redistributed only as the
 * unmodified archive, so nothing from it is copied here.
 */
const corpus = process.env.SEZZLEE_CORPUS;
const suite =
  corpus === undefined
    ? undefined
    : join(corpus, "_conformance", "xmlts20130923", "xmlconf");
const present = suite !== undefined && existsSync(join(suite, "xmlconf.xml"));

describe.skipIf(!present)("the W3C XML conformance suite", () => {
  const cases = present && suite !== undefined ? conformanceCases(suite) : [];
  const inScope = cases.filter(
    (entry) => entry.scope === "in" && existsSync(entry.path),
  );

  it.each([1, 7, 4096])(
    "refuses every not-well-formed case and reads every well-formed one, in chunks of %i",
    (chunk) => {
      const failures: string[] = [];
      const tally = {
        refused: 0,
        needsDtd: 0,
        errorInDtd: 0,
        read: 0,
        canonical: 0,
        unsupportedEncoding: 0,
      };
      for (const entry of inScope) {
        const wellFormed = entry.type !== "not-wf";
        const outcome = runCase(
          entry.path,
          chunk,
          wellFormed ? "remove" : "remove-if-body-fails",
        );
        if (outcome.kind === "unsupported_encoding") {
          tally.unsupportedEncoding += 1;
          continue;
        }
        if (outcome.kind === "needs_dtd") {
          tally.needsDtd += 1;
          continue;
        }
        if (outcome.kind === "error_in_dtd") {
          tally.errorInDtd += 1;
          continue;
        }
        if (!wellFormed) {
          if (outcome.kind === "read") failures.push(`${entry.id}: read`);
          else tally.refused += 1;
          continue;
        }
        if (outcome.kind === "refused") {
          failures.push(`${entry.id}: refused (${outcome.reason})`);
          continue;
        }
        tally.read += 1;
        if (entry.output !== undefined && existsSync(entry.output)) {
          const expected = readFileSync(entry.output, "utf8");
          if (outcome.canonical === expected) tally.canonical += 1;
          else
            failures.push(
              `${entry.id}: canonical ${JSON.stringify(outcome.canonical.slice(0, 120))} != ${JSON.stringify(expected.slice(0, 120))}`,
            );
        }
      }
      expect(failures).toStrictEqual([]);
      expect(tally).toStrictEqual({
        refused: 299,
        errorInDtd: 90,
        needsDtd: 742,
        read: 468,
        canonical: 107,
        unsupportedEncoding: 22,
      });
    },
  );
});
