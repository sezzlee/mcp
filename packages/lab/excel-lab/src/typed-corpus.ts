import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createExcelMcpServer,
  createWorkbookRoot,
  toolDefinitions,
} from "@sezzlee/excel-mcp";
import { z } from "zod";
import { sha256Of } from "./record.ts";
import { prepareOutRoot } from "./run.ts";

const source = "typed-global-v2";
const localeCases = [
  ["en-US", "latn"],
  ["de-DE", "latn"],
  ["fr-FR", "latn"],
  ["de-CH", "latn"],
  ["hi-IN", "latn"],
  ["hi-IN", "deva"],
  ["bn-BD", "beng"],
  ["ar-EG", "arab"],
  ["fa-IR", "arabext"],
  ["th-TH", "thai"],
  ["my-MM", "mymr"],
  ["ja-JP", "fullwide"],
  ["zh-CN", "hanidec"],
  ["ru-RU", "latn"],
  ["pl-PL", "latn"],
  ["es-ES", "latn"],
  ["pt-BR", "latn"],
  ["tr-TR", "latn"],
  ["ko-KR", "latn"],
] as const;
const wordSets = [
  ["activo", "inactivo", "ausente"],
  ["有効", "無効", "欠損"],
  ["启用", "停用", "缺失"],
  ["مقبول", "مرفوض", "مفقود"],
  ["верно", "неверно", "отсутствует"],
  ["활성", "비활성", "누락"],
] as const;

export const typedCorpusOptionsSchema = z.object({
  seed: z.number().int().min(0).max(0xffff_ffff).default(0x6b8b4567),
  rows: z.number().int().min(64).max(5000).default(250),
});
export type TypedCorpusOptions = z.infer<typeof typedCorpusOptionsSchema>;

const dateShapeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named") }),
  z.object({
    kind: z.literal("long"),
    format: z.string(),
    automatic: z.enum(["supported", "unsupported"]),
  }),
  z.object({
    kind: z.literal("numeric"),
    order: z.enum(["dmy", "mdy", "ymd"]),
    separator: z.enum(["/", "-", "."]),
  }),
]);
type DateShape = z.infer<typeof dateShapeSchema>;
const configSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]+$/),
  locale: z.string(),
  numberingSystem: z.string(),
  trueText: z.string(),
  falseText: z.string(),
  missingText: z.string(),
  date: dateShapeSchema.default({ kind: "named" }),
});
type Config = z.infer<typeof configSchema>;
const expandedDates = [
  {
    locale: "tr-TR",
    numberingSystem: "latn",
    date: { kind: "long", format: "d MMMM yyyy", automatic: "supported" },
  },
  {
    locale: "hi-IN",
    numberingSystem: "latn",
    date: { kind: "long", format: "d MMMM yyyy", automatic: "supported" },
  },
  {
    locale: "hi-IN",
    numberingSystem: "deva",
    date: { kind: "long", format: "d MMMM yyyy", automatic: "supported" },
  },
  {
    locale: "zh-CN",
    numberingSystem: "latn",
    date: { kind: "long", format: "yyyy年M月d日", automatic: "unsupported" },
  },
  {
    locale: "ja-JP",
    numberingSystem: "latn",
    date: { kind: "long", format: "yyyy年M月d日", automatic: "unsupported" },
  },
  {
    locale: "ko-KR",
    numberingSystem: "latn",
    date: { kind: "long", format: "yyyy년 M월 d일", automatic: "unsupported" },
  },
  {
    locale: "en-GB",
    numberingSystem: "latn",
    date: { kind: "long", format: "d MMMM yyyy", automatic: "supported" },
  },
  {
    locale: "en-US",
    numberingSystem: "latn",
    date: { kind: "long", format: "MMMM d, yyyy", automatic: "supported" },
  },
  {
    locale: "ru-RU",
    numberingSystem: "latn",
    date: { kind: "long", format: "d MMMM yyyy г.", automatic: "unsupported" },
  },
  {
    locale: "ar-EG",
    numberingSystem: "arab",
    date: { kind: "numeric", order: "dmy", separator: "/" },
  },
  {
    locale: "hi-IN",
    numberingSystem: "deva",
    date: { kind: "numeric", order: "mdy", separator: "/" },
  },
  {
    locale: "fa-IR",
    numberingSystem: "arabext",
    date: { kind: "numeric", order: "dmy", separator: "-" },
  },
  {
    locale: "ja-JP",
    numberingSystem: "fullwide",
    date: { kind: "numeric", order: "mdy", separator: "-" },
  },
  {
    locale: "bn-BD",
    numberingSystem: "beng",
    date: { kind: "numeric", order: "dmy", separator: "." },
  },
  {
    locale: "my-MM",
    numberingSystem: "mymr",
    date: { kind: "numeric", order: "dmy", separator: "." },
  },
  {
    locale: "th-TH",
    numberingSystem: "thai",
    date: { kind: "numeric", order: "ymd", separator: "/" },
  },
  {
    locale: "en-US",
    numberingSystem: "latn",
    date: { kind: "numeric", order: "ymd", separator: "." },
  },
  {
    locale: "hi-IN",
    numberingSystem: "deva",
    date: { kind: "numeric", order: "ymd", separator: "-" },
  },
] satisfies readonly Pick<Config, "locale" | "numberingSystem" | "date">[];
const rawRowSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);
const typedRowSchema = z.tuple([
  z.string(),
  z.number().nullable(),
  z.string(),
  z.string(),
  z.boolean().nullable(),
  z.object({ durationSeconds: z.number() }),
]);
const groupRowSchema = z.tuple([
  z.string(),
  z.number(),
  z.number(),
  z.number(),
]);
const fixtureSchema = z.object({
  config: configSchema,
  raw: z.array(rawRowSchema),
  typed: z.array(typedRowSchema),
  groups: z.array(groupRowSchema),
  months: z.array(z.tuple([z.string(), z.number()])),
  trueCount: z.number(),
  trueSum: z.number(),
});
type Fixture = z.infer<typeof fixtureSchema>;
const entrySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const runFields = z.object({
  seed: z.number().int(),
  rows: z.number().int(),
  node: z.string(),
  icu: z.string(),
  cldr: z.string(),
  unicode: z.string(),
  fixtures: z.array(entrySchema),
});
const runSchema = z.discriminatedUnion("generator", [
  runFields.extend({ generator: z.literal("typed-global-v1") }),
  runFields.extend({
    generator: z.literal(source),
    generatorSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
const readSchema = z.object({
  values: z.array(rawRowSchema),
  typedValues: z.array(typedRowSchema),
  nextCursor: z.string().optional(),
});
const aggregateSchema = z.object({
  rows: z.array(z.array(z.union([z.string(), z.number()]))),
  matchedRows: z.number(),
  scannedRows: z.number(),
  truncated: z.boolean(),
  ungroupedRows: z.number().default(0),
});
const profileSchema = z.object({
  columnMode: z.literal("letter"),
  columns: z.array(z.json()),
});
const dateReadSchema = z.object({
  values: z.array(z.tuple([z.string()])),
  typedValues: z.array(z.tuple([z.string().nullable()])),
  nextCursor: z.string().optional(),
});

function dateFormatOf(shape: DateShape): string {
  switch (shape.kind) {
    case "named":
      return "d MMMM yyyy";
    case "long":
      return shape.format;
    case "numeric": {
      const fields = {
        dmy: ["d", "M", "yyyy"],
        mdy: ["M", "d", "yyyy"],
        ymd: ["yyyy", "MM", "dd"],
      };
      return fields[shape.order].join(shape.separator);
    }
    default: {
      const exhaustive: never = shape;
      return exhaustive;
    }
  }
}

function supportsAutomaticDates(shape: DateShape): boolean {
  return shape.kind !== "long" || shape.automatic === "supported";
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function formatters(config: Config) {
  const number = new Intl.NumberFormat(config.locale, {
    numberingSystem: config.numberingSystem,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const digits = new Intl.NumberFormat(config.locale, {
    numberingSystem: config.numberingSystem,
    useGrouping: false,
  });
  const month = new Intl.DateTimeFormat(config.locale, {
    calendar: "gregory",
    month: "long",
    timeZone: "UTC",
  });
  const longDate = new Intl.DateTimeFormat(config.locale, {
    calendar: "gregory",
    dateStyle: "long",
    numberingSystem: config.numberingSystem,
    timeZone: "UTC",
  });
  const dateDigits = new Intl.NumberFormat(config.locale, {
    numberingSystem: config.numberingSystem,
    useGrouping: false,
    minimumIntegerDigits:
      config.date.kind === "numeric" && config.date.order === "ymd" ? 2 : 1,
  });
  assert.equal(
    number.resolvedOptions().numberingSystem,
    config.numberingSystem,
  );
  assert.equal(month.resolvedOptions().calendar, "gregory");
  assert.equal(longDate.resolvedOptions().calendar, "gregory");
  assert.equal(
    longDate.resolvedOptions().numberingSystem,
    config.numberingSystem,
  );
  assert.equal(Intl.NumberFormat.supportedLocalesOf([config.locale]).length, 1);
  assert.equal(
    Intl.DateTimeFormat.supportedLocalesOf([config.locale]).length,
    1,
  );
  const date = (value: Date): string => {
    const shape = config.date;
    switch (shape.kind) {
      case "named":
        return `13 ${month.format(value)} 2026`;
      case "long":
        return longDate.format(value);
      case "numeric": {
        const year = dateDigits.format(value.getUTCFullYear());
        const month = dateDigits.format(value.getUTCMonth() + 1);
        const day = dateDigits.format(value.getUTCDate());
        const fields = {
          dmy: [day, month, year],
          mdy: [month, day, year],
          ymd: [year, month, day],
        };
        return fields[shape.order].join(shape.separator);
      }
      default: {
        const exhaustive: never = shape;
        return exhaustive;
      }
    }
  };
  return { number, digits, date };
}

/**
 * Chooses exact quarter-unit quantities, civil dates and booleans before Intl
 * serializes text. The production parser never creates the expected answers.
 */
function fixtureOf(config: Config, options: TypedCorpusOptions): Fixture {
  const next = random(options.seed);
  const nextDate = random(options.seed ^ 0x7f4a7c15);
  const { number, digits, date: dateText } = formatters(config);
  const raw: Fixture["raw"] = [];
  const typed: Fixture["typed"] = [];
  const groups = Array.from(
    { length: 4 },
    (_, at): z.infer<typeof groupRowSchema> => [`G${at}`, 0, 0, 0],
  );
  const months = Array.from({ length: 12 }, (_, at): [string, number] => [
    `2026-${String(at + 1).padStart(2, "0")}`,
    0,
  ]);
  let trueCount = 0;
  let trueSum = 0;
  const identifier = (value: number): string =>
    `${digits.format(0)}${digits.format(0)}${digits.format(value)}`;
  for (let at = 0; at < options.rows; at += 1) {
    const chosen = ((next() % 8_000_001) - 4_000_000) / 4;
    const amount = at % 29 === 0 || at === options.rows - 1 ? null : chosen;
    const group = groups[at % 4];
    const monthIndex = at % 12;
    const monthCount = months[monthIndex];
    assert.ok(group);
    assert.ok(monthCount);
    const day =
      config.date.kind === "named"
        ? 13
        : at % 4 === 0
          ? 13 + (nextDate() % 16)
          : 1 + (nextDate() % 12);
    const date = new Date(Date.UTC(2026, monthIndex, day));
    const flag = at % 7 === 0 ? null : at % 2 === 0;
    const seconds = ((next() % 691_201) / 4) * (at % 13 === 0 ? -1 : 1);
    const amountText =
      at === options.rows - 1
        ? identifier(123)
        : amount === null
          ? config.missingText
          : number.format(amount);
    raw.push([
      group[0],
      amountText,
      identifier(at + 1000),
      dateText(date),
      flag === null
        ? config.missingText
        : flag
          ? config.trueText
          : config.falseText,
      `${seconds < 0 ? "-" : ""}PT${Math.abs(seconds)}S`,
    ]);
    typed.push([
      group[0],
      amount,
      identifier(at + 1000),
      date.toISOString().slice(0, 10),
      flag,
      { durationSeconds: seconds },
    ]);
    group[1] += amount ?? 0;
    group[2] += seconds;
    group[3] += 1;
    monthCount[1] += 1;
    if (flag === true) {
      trueCount += 1;
      trueSum += amount ?? 0;
    }
  }
  return { config, raw, typed, groups, months, trueCount, trueSum };
}

function columnsOf(config: Config) {
  return [
    { column: "A", type: "text" },
    {
      column: "B",
      type: "number",
      locale: config.locale,
      numberingSystem: config.numberingSystem,
      identifiers: "refuse",
    },
    { column: "C", type: "text" },
    {
      column: "D",
      type: "date",
      locale: config.locale,
      format: dateFormatOf(config.date),
    },
    { column: "E", type: "boolean" },
    { column: "F", type: "duration" },
  ];
}

function hintsOf(config: Config) {
  return {
    locale: config.locale,
    numberingSystem: config.numberingSystem,
    trueValues: [config.trueText],
    falseValues: [config.falseText],
    missingValues: [config.missingText],
  };
}

export async function generateTypedCorpus(
  out: string,
  input: TypedCorpusOptions,
): Promise<string> {
  const options = typedCorpusOptionsSchema.parse(input);
  const root = await mkdtemp(join(await prepareOutRoot(out), "typed-"));
  const directory = join(root, source);
  await mkdir(join(directory, "files"), { recursive: true });
  await mkdir(join(directory, "expected"));
  const entries: z.infer<typeof entrySchema>[] = [];
  const manifest: string[] = [];
  const configs: Pick<Config, "id" | "locale" | "numberingSystem" | "date">[] =
    [
      ...localeCases.map(([locale, numberingSystem]) => ({
        id: `${locale}-${numberingSystem}`,
        locale,
        numberingSystem,
        date: { kind: "named" } satisfies DateShape,
      })),
      ...expandedDates.map(({ locale, numberingSystem, date }, at) => ({
        id: `${locale}-${numberingSystem}-${date.kind}-${at + 1}`,
        locale,
        numberingSystem,
        date,
      })),
    ];
  for (const [at, details] of configs.entries()) {
    const words = wordSets[at % wordSets.length];
    assert.ok(words);
    const config: Config = {
      ...details,
      trueText: words[0],
      falseText: words[1],
      missingText: words[2],
    };
    const fixture = fixtureOf(config, options);
    const csv =
      [
        ["Group", "Amount", "Identifier", "Date", "Flag", "Elapsed"],
        ...fixture.raw,
      ]
        .map((row) =>
          row.map((field) => `"${field.replaceAll('"', '""')}"`).join(","),
        )
        .join("\r\n") + "\r\n";
    const expected = `${JSON.stringify(fixture)}\n`;
    const entry = {
      id: config.id,
      sha256: sha256Of(csv),
      bytes: Buffer.byteLength(csv),
      expectedSha256: sha256Of(expected),
    };
    await writeFile(join(directory, "files", `${config.id}.csv`), csv);
    await writeFile(join(directory, "expected", `${config.id}.json`), expected);
    entries.push(entry);
    manifest.push(
      JSON.stringify({
        ...entry,
        file: `files/${config.id}.csv`,
        format: "csv",
        license: "MIT",
        expected: `expected/${config.id}.json`,
        oracle:
          "Chosen scalar values and Gregorian civil dates before serialization; exact quarter-unit sums and counts.",
        date: {
          shape: config.date,
          explicitFormat: dateFormatOf(config.date),
          automatic: supportsAutomaticDates(config.date)
            ? "supported"
            : "unsupported marker grammar; explicit format required",
        },
      }),
    );
  }
  await writeFile(
    join(directory, "manifest.jsonl"),
    `${manifest.join("\n")}\n`,
  );
  await writeFile(
    join(root, "run.json"),
    `${JSON.stringify(
      {
        generator: source,
        generatorSha256: sha256Of(
          await readFile(new URL("./typed-corpus.ts", import.meta.url)),
        ),
        ...options,
        node: process.version,
        icu: process.versions["icu"] ?? "unavailable",
        cldr: process.versions["cldr"] ?? "unavailable",
        unicode: process.versions["unicode"] ?? "unavailable",
        fixtures: entries,
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

/** Runs the saved bytes and saved independent answers against the built MCP. */
export async function verifyTypedCorpus(inputRoot: string, revision?: string) {
  const root = await prepareOutRoot(inputRoot);
  const run = runSchema.parse(
    JSON.parse(await readFile(join(root, "run.json"), "utf8")),
  );
  const implementation = createHash("sha256");
  for (const module of [
    "grid/column-reading",
    "grid/number-text",
    "grid/date-text",
    "grid/locale-text",
    "grid/temporal-text",
    "grid/profile-sheet",
    "grid/aggregate",
    "grid/aggregate-metrics",
    "grid/read-sheet",
    "grid/predicate",
    "grid/grouping",
    "format/csv",
  ]) {
    implementation
      .update(module)
      .update(
        await readFile(
          new URL(
            `../../../servers/excel-mcp/dist/${module}.js`,
            import.meta.url,
          ),
        ),
      );
  }
  const server = createExcelMcpServer(await createWorkbookRoot(root));
  const client = new Client({ name: "typed-corpus", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  const started = performance.now();
  let calls = 0;
  let rows = 0;
  let fixtures = 0;
  let inferredDateFixtures = 0;
  let reusedDateProfiles = 0;
  let profiledDateCellsChecked = 0;
  const automaticDateBoundaries: { id: string; explicitFormat: string }[] = [];
  let current = "";
  const request = async (
    input: Parameters<Client["callTool"]>[0],
  ): Promise<unknown> => {
    const answer = await client.callTool(input);
    calls += 1;
    const block = answer.content[0];
    assert.equal(block?.type, "text");
    if (block?.type !== "text") throw new Error("Missing MCP text response");
    assert.notEqual(answer.isError, true, block.text);
    return JSON.parse(block.text);
  };
  let failure: string | undefined;
  try {
    for (const entry of run.fixtures) {
      current = entry.id;
      const filePath = `${run.generator}/files/${entry.id}.csv`;
      const bytes = await readFile(join(root, filePath));
      assert.equal(
        bytes.length,
        entry.bytes,
        `${current}: byte length changed`,
      );
      assert.equal(
        sha256Of(bytes),
        entry.sha256,
        `${current}: SHA-256 mismatch`,
      );
      const expected = await readFile(
        join(root, run.generator, "expected", `${entry.id}.json`),
        "utf8",
      );
      assert.equal(
        sha256Of(expected),
        entry.expectedSha256,
        `${current}: oracle SHA-256 mismatch`,
      );
      const fixture = fixtureSchema.parse(JSON.parse(expected));
      const common = {
        filePath,
        delimiter: "comma",
        headerRow: 1,
        columnMode: "letter",
        ...hintsOf(fixture.config),
      };
      const columns = columnsOf(fixture.config);
      let cursor: string | undefined;
      let read = 0;
      do {
        const page = readSchema.parse(
          await request({
            name: "read_sheet",
            arguments:
              cursor === undefined
                ? { ...common, columns, includeTyped: true, maxCells: 120 }
                : { filePath, cursor, maxCells: 120 },
          }),
        );
        assert.ok(page.values.length > 0);
        assert.deepEqual(
          page.values,
          fixture.raw.slice(read, read + page.values.length),
        );
        assert.deepEqual(
          page.typedValues,
          fixture.typed.slice(read, read + page.values.length),
        );
        read += page.values.length;
        assert.ok(read <= fixture.raw.length);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      assert.equal(read, run.rows);
      rows += read;
      const metrics = [
        { fn: "sum", column: "B" },
        { fn: "sum", column: "F" },
        { fn: "count" },
      ];
      const aggregate = aggregateSchema.parse(
        await request({
          name: "aggregate_sheet",
          arguments: { ...common, columns, groupBy: ["A"], metrics },
        }),
      );
      assert.deepEqual(aggregate.rows, fixture.groups);
      assert.equal(aggregate.matchedRows, run.rows);
      assert.equal(aggregate.scannedRows, run.rows);
      assert.equal(aggregate.truncated, false);
      const months = aggregateSchema.parse(
        await request({
          name: "aggregate_sheet",
          arguments: {
            ...common,
            columns,
            groupBy: [{ column: "D", by: "month" }],
            metrics: [{ fn: "count" }],
          },
        }),
      );
      assert.deepEqual(months.rows, fixture.months);
      assert.equal(months.ungroupedRows, 0);
      const automaticDates = supportsAutomaticDates(fixture.config.date);
      const inferredMonths = aggregateSchema.parse(
        await request({
          name: "aggregate_sheet",
          arguments: {
            ...common,
            groupBy: [{ column: "D", by: "month" }],
            metrics: [{ fn: "count" }],
          },
        }),
      );
      assert.deepEqual(
        inferredMonths.rows,
        automaticDates ? fixture.months : [],
        `${current}: inferred month groups`,
      );
      assert.equal(inferredMonths.ungroupedRows, automaticDates ? 0 : run.rows);
      if (automaticDates) inferredDateFixtures += 1;
      else
        automaticDateBoundaries.push({
          id: current,
          explicitFormat: dateFormatOf(fixture.config.date),
        });
      const filtered = aggregateSchema.parse(
        await request({
          name: "aggregate_sheet",
          arguments: {
            ...common,
            columns,
            where: [{ column: "E", op: "eq", value: true }],
            metrics: [{ fn: "count" }, { fn: "sum", column: "B" }],
          },
        }),
      );
      assert.deepEqual(filtered.rows, [[fixture.trueCount, fixture.trueSum]]);
      const profile = profileSchema.parse(
        await request({
          name: "profile_sheet",
          arguments: { ...common, maxRows: 32 },
        }),
      );
      const reused = toolDefinitions.aggregate_sheet.inputSchema.parse({
        ...common,
        columnMode: profile.columnMode,
        columns: profile.columns,
        groupBy: ["A"],
        metrics,
      });
      const profileAggregate = aggregateSchema.parse(
        await request({
          name: "aggregate_sheet",
          arguments: reused,
        }),
      );
      assert.deepEqual(profileAggregate.rows, fixture.groups);
      const dateColumn = reused.columns?.find(
        (column) => column.column === "D",
      );
      assert.ok(dateColumn, `${current}: the profile omitted the Date column`);
      assert.equal(
        dateColumn.type,
        automaticDates ? "date" : "text",
        `${current}: profile date-plan capability`,
      );
      const profileMonths = aggregateSchema.parse(
        await request({
          name: "aggregate_sheet",
          arguments: {
            ...reused,
            groupBy: [{ column: "D", by: "month" }],
            metrics: [{ fn: "count" }],
          },
        }),
      );
      assert.deepEqual(
        profileMonths.rows,
        automaticDates ? fixture.months : [],
        `${current}: profile-reused month groups`,
      );
      assert.equal(profileMonths.ungroupedRows, automaticDates ? 0 : run.rows);
      let dateCursor: string | undefined;
      let datesRead = 0;
      do {
        const page = dateReadSchema.parse(
          await request({
            name: "read_sheet",
            arguments:
              dateCursor === undefined
                ? {
                    ...common,
                    range: `D1:D${run.rows + 1}`,
                    columns: [dateColumn],
                    includeTyped: true,
                    maxCells: 120,
                  }
                : { filePath, cursor: dateCursor, maxCells: 120 },
          }),
        );
        assert.ok(page.values.length > 0);
        const end = datesRead + page.values.length;
        assert.deepEqual(
          page.values,
          fixture.raw.slice(datesRead, end).map((row) => [row[3]]),
        );
        assert.deepEqual(
          page.typedValues,
          (automaticDates ? fixture.typed : fixture.raw)
            .slice(datesRead, end)
            .map((row) => [row[3]]),
          `${current}: profile-reused civil dates`,
        );
        datesRead = end;
        assert.ok(datesRead <= fixture.raw.length);
        dateCursor = page.nextCursor;
      } while (dateCursor !== undefined);
      assert.equal(datesRead, run.rows);
      profiledDateCellsChecked += datesRead;
      if (automaticDates) reusedDateProfiles += 1;
      fixtures += 1;
    }
  } catch (error) {
    failure = `${current}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await client.close();
    await server.close();
  }
  const report = {
    status: failure === undefined ? "passed" : "failed",
    generator: run.generator,
    generatorSha256:
      run.generator === "typed-global-v2" ? run.generatorSha256 : null,
    seed: run.seed,
    rowsPerFixture: run.rows,
    fixtures,
    rows,
    rawCellsChecked: rows * 6,
    typedCellsChecked: rows * 6,
    reusedProfiles: fixtures,
    inferredDateFixtures,
    reusedDateProfiles,
    profiledDateCellsChecked,
    automaticDateBoundaries,
    mcpCalls: calls,
    ms: performance.now() - started,
    maxRssKiB: process.resourceUsage().maxRSS,
    node: process.version,
    icu: process.versions["icu"],
    cldr: process.versions["cldr"],
    unicode: process.versions["unicode"],
    generatedWith: {
      node: run.node,
      icu: run.icu,
      cldr: run.cldr,
      unicode: run.unicode,
    },
    revision: revision ?? null,
    implementationSha256: implementation.digest("hex"),
    ...(failure === undefined ? {} : { failure }),
  };
  await writeFile(
    join(root, "typed-results.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (failure !== undefined)
    throw new Error(
      `Typed corpus failed; seed ${run.seed}; saved replay ${root}: ${failure}`,
    );
  return report;
}
