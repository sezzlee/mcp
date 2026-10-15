import { describe, expect, it, vi } from "vitest";
import {
  buildCatalog,
  searchCatalog,
  type Auth,
  type CatalogBuild,
  type CatalogCandidate,
  type CatalogEntry,
  type EndpointDescriptor,
  type ProbeOptions,
  type VisibilityDecision,
} from "../src/index.js";

const auth: Auth = { anonymous: "unknown", policies: [], imperative: true };

const names = Array.from(
  { length: 10 },
  (_, index) => `doc_${String(index + 1).padStart(2, "0")}`,
);

const candidate = (name: string): CatalogCandidate => {
  const descriptor: EndpointDescriptor = {
    operationId: name,
    method: "GET",
    route: `/${name}`,
    auth,
  };
  return {
    source: {},
    owner: `GET /${name}`,
    descriptor,
    declare: () => descriptor,
  };
};

const catalog: CatalogBuild = buildCatalog(names.map(candidate), {
  selection: { default: "include" },
  providers: { has: () => false },
  severity: () => "warning",
  failOn: "fatal",
});

const hideUnknown = (decision: VisibilityDecision): boolean =>
  decision !== "unknown" && decision !== "deny";

interface Walk {
  readonly names: string[];
  readonly probed: string[];
}

async function walk(
  limit: number,
  verdict: (name: string) => VisibilityDecision,
  options: Partial<ProbeOptions<object>> = {},
): Promise<Walk> {
  const probed: string[] = [];
  const response = await searchCatalog({
    catalog,
    query: "",
    limit,
    detail: undefined,
    tags: undefined,
    decide: () => "unknown",
    visible: hideUnknown,
    probe: {
      maxProbes: 50,
      concurrency: 2,
      canProbe: () => true,
      run: async (entry: CatalogEntry) => {
        probed.push(entry.tool.name);
        await Promise.resolve();
        return verdict(entry.tool.name);
      },
      ...options,
    },
  });
  const payload = response.payload as { results: { name: string }[] };
  return { names: payload.results.map((card) => card.name), probed };
}

const denyBefore = (last: number) => (name: string) =>
  Number(name.slice(4)) <= last ? ("deny" as const) : ("allow" as const);

describe("searchCatalog probing until the page fills", () => {
  it("fills the page from allowed entries ranked below the denied ones", async () => {
    const answer = await walk(3, denyBefore(6));
    expect(answer.names).toEqual(["doc_07", "doc_08", "doc_09"]);
  });

  it("stops sending probes once the page is full", async () => {
    const answer = await walk(2, () => "allow");
    expect(answer.names).toEqual(["doc_01", "doc_02"]);
    expect(answer.probed.length).toBeLessThanOrEqual(3);
  });

  it("returns the page as it stands at the cap and reports it once", async () => {
    const capReached = vi.fn();
    const answer = await walk(3, denyBefore(8), { maxProbes: 4, capReached });
    expect(answer.names).toEqual([]);
    expect(answer.probed).toHaveLength(4);
    expect(capReached).toHaveBeenCalledTimes(1);
  });

  it("does not count a cached verdict against the cap or send its probe", async () => {
    const answer = await walk(3, () => "deny", {
      maxProbes: 1,
      cached: async (entry) =>
        Number(entry.tool.name.slice(4)) <= 6 ? "deny" : "allow",
    });
    expect(answer.names).toEqual(["doc_07", "doc_08", "doc_09"]);
    expect(answer.probed).toEqual([]);
  });

  it("reads a probe that rejects as unknown, not as a failed search", async () => {
    const answer = await walk(2, () => "allow", {
      run: async (entry) => {
        if (entry.tool.name === "doc_01") {
          throw new Error("pipeline down");
        }
        return "allow";
      },
    });
    expect(answer.names).toEqual(["doc_02", "doc_03"]);
  });

  it("leaves a tool that cannot be probed to the visibility of unknown", async () => {
    const answer = await walk(2, () => "allow", {
      canProbe: (entry) => entry.tool.name !== "doc_01",
    });
    expect(answer.names).toEqual(["doc_02", "doc_03"]);
    expect(answer.probed).not.toContain("doc_01");
  });
});
