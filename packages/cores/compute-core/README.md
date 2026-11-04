# @sezzlee/compute-core

Bounded JavaScript computation over explicitly supplied JSON. This is a publishable library,
not a separate MCP server or an agent-loop integration. A source server supplies JSON and owns
authorization, source selection, versioning, retention and response emission. This package knows
nothing about HTTP, files, spreadsheets or XML.

## Use

```sh
pnpm add @sezzlee/compute-core zod
```

```ts
import { QuickJsExecutor } from "@sezzlee/compute-core";

const executor = new QuickJsExecutor();
const result = await executor.execute({
  json: '{"items":[{"paid":true,"total":12},{"paid":false,"total":7}]}',
  code: "return data.items.filter(x => x.paid).reduce((sum, x) => sum + x.total, 0);",
});
```

The result is `{ kind: "success", json: "12" }`. A failure has
`{ kind: "failure", reason }`; it never contains a guest exception, stack, partial value or
host diagnostic. Keep one executor per process or application scope so its concurrency bound
is shared. Pass `signal` to cancel an execution.

`code` is a synchronous function body receiving `data`, a private parsed copy of the supplied
JSON. Use `return`, not `console.log`. Return a finite JSON value. Undefined, functions,
symbols, bigint, promises, non-finite numbers and cyclic values are refused; undefined nested
members are refused too. Objects such as Map, Set and typed arrays must be projected to plain
objects or arrays rather than silently becoming empty objects. Standard JSON conversion such as a Date's `toJSON` remains JavaScript
behavior. JavaScript numbers are binary64: retain exact decimal text and identifiers unless
the source contract explicitly permits conversion. Do not interpret a successful computation
as proof that the source supplied every upstream record.

## Budgets and recovery

`executionLimits` exports these ceilings. Constructor options can only tighten them; invalid
configuration throws before starting a worker. `executor.limits` reports the effective values.

| Budget                       | Default ceiling | Purpose and recovery                                                             |
| ---------------------------- | --------------- | -------------------------------------------------------------------------------- |
| Program UTF-8 bytes          | 16 KiB          | Bounds compilation input; shorten the program.                                   |
| Input JSON UTF-8 bytes       | 8 MiB           | Bounds transfer into the worker; select a narrower source.                       |
| Output JSON UTF-8 bytes      | 1 MiB           | Bounds transfer back to the host; return a projection or aggregate.              |
| QuickJS allocation budget    | 32 MiB          | Bounds guest heap allocation; avoid collecting large intermediates.              |
| QuickJS stack                | 512 KiB         | Bounds recursive guest execution; prefer iteration.                              |
| Wall-clock time              | 2 s             | Includes worker startup, parsing, execution and serialization; simplify the job. |
| Concurrent jobs per executor | 2               | Bounds active workers; a third call gets `busy`, without a queue.                |

The memory and stack minima are 1 MiB and 16 KiB respectively. Other positive integer limits
can be reduced to one. Memory accounting is not an exact process RSS bound: the Node worker,
WASM linear memory and host copies have overhead. Node's 64 MiB worker old-generation limit
does not bound WASM memory; QuickJS's allocation limit is applied independently. Multiple
executor instances or processes multiply the concurrency budget.

Failure reasons are `invalid_input`, `code_limit`, `input_limit`, `output_limit`,
`invalid_program`, `program_failed`, `invalid_result`, `memory_limit`, `timeout`, `cancelled`,
`busy` and `unavailable`. `program_failed` includes guest exceptions and guest allocation or
stack exhaustion; the executor does not disclose exception text to distinguish them. A host
worker memory failure can be reported as `memory_limit`. Worker installation/startup failures
are `unavailable`. No failure publishes a partial result. A slot is released only after its
worker has stopped, including on cancellation and timeout.

## Isolation and packaging

Each execution creates a fresh Node worker containing a QuickJS WebAssembly runtime. The worker
receives neither the parent's environment variables nor its execution flags. User code runs
only in QuickJS. No host functions, module loader, Node globals, filesystem, network,
credentials, logging or tool invocation capability is bound into that runtime. The worker
keeps computation off the server event loop; an independent host deadline terminates it even
if guest execution cannot make progress. Input mutations cannot change the retained source or
a later execution. This is a capability boundary around the supplied data, not a general-purpose
shell sandbox. It does not remove malicious instructions or sensitive fields from source data;
the source server must authorize and select that data before supplying it.

Node 22 or later and worker threads are required. The package contains `dist/worker.js`; its
exactly pinned MIT QuickJS dependencies carry their own WASM asset. Keep the worker and WASM
dependencies when packaging or bundling. No runtime download or native compilation is required.
The HTTP integration is documented in
[result execution](../../http/spec/result-execution.md). Other source adapters can implement
the same `DataExecutor` port without depending on the HTTP packages.

The [Excel adapter](../../servers/excel-mcp/README.md#compute-over-a-retained-result) supplies exact
retained aggregate values and shares its existing store with derived JSON. `readJsonValue` and
`outlineJsonValue` provide source-neutral RFC 6901 windows and bounded container outlines.
String windows count UTF-16 code units. Invalid pointers, missing members and mistyped
projections are refused; response byte budgets and retention remain the host's responsibility.
