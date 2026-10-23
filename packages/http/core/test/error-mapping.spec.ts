import { describe, expect, it } from "vitest";
import {
  codeFor,
  forwardable,
  inspect,
  isMappedError,
  mapInvokeResult,
  parseBody,
  retryableStatuses,
  type BackendErrorCode,
  type BackendResponse,
  type Recognizer,
} from "../src/index.js";
import { standardMessages } from "../src/error-mapping.js";

function response(
  overrides: Partial<BackendResponse> & { status: number },
): BackendResponse {
  return { headers: {}, ...overrides };
}

describe("parseBody", () => {
  it("treats a missing body as empty", () => {
    expect(parseBody(undefined, "application/json")).toEqual({ kind: "empty" });
  });

  it("treats an empty or whitespace-only body as empty", () => {
    expect(parseBody("", "application/json")).toEqual({ kind: "empty" });
    expect(parseBody("   \n\t", "application/json")).toEqual({ kind: "empty" });
  });

  it("parses application/json", () => {
    expect(parseBody('{"a":1}', "application/json")).toEqual({
      kind: "json",
      value: { a: 1 },
    });
  });

  it("parses text/json even though it is a text/* media type", () => {
    expect(parseBody('{"a":1}', "text/json")).toEqual({
      kind: "json",
      value: { a: 1 },
    });
  });

  it("parses any +json suffix", () => {
    expect(parseBody('{"a":1}', "application/problem+json")).toEqual({
      kind: "json",
      value: { a: 1 },
    });
    expect(parseBody('{"a":1}', "application/vnd.api+json")).toEqual({
      kind: "json",
      value: { a: 1 },
    });
  });

  it("attempts JSON when content-type is absent", () => {
    expect(parseBody('{"a":1}', undefined)).toEqual({
      kind: "json",
      value: { a: 1 },
    });
  });

  it("never parses text/plain as JSON, even if it looks like JSON", () => {
    expect(parseBody('{"a":1}', "text/plain")).toEqual({
      kind: "text",
      text: '{"a":1}',
    });
  });

  it("falls back to text when JSON parsing fails", () => {
    expect(parseBody("not json", "application/json")).toEqual({
      kind: "text",
      text: "not json",
    });
  });

  it("detects HTML by content-type", () => {
    expect(parseBody("<div>oops</div>", "text/html")).toEqual({
      kind: "html",
      text: "<div>oops</div>",
    });
  });

  it("detects HTML by a doctype or html tag prefix, case-insensitively", () => {
    expect(parseBody("<!DOCTYPE html><html></html>", undefined)).toEqual({
      kind: "html",
      text: "<!DOCTYPE html><html></html>",
    });
    expect(parseBody("<HTML><body>502</body></HTML>", undefined)).toEqual({
      kind: "html",
      text: "<HTML><body>502</body></HTML>",
    });
  });
});

describe("leak filter rules", () => {
  it.each([
    [
      "stack_frame",
      "at DemoApi.Services.OrderService.Validate(Order order) in /src/app.cs:line 88",
    ],
    ["stack_frame", "at Object.<anonymous> (/app/index.js:10:15)"],
    ["stack_frame", "Traceback (most recent call last): oops"],
    [
      "exception_type",
      "System.NullReferenceException: Object reference not set.",
    ],
    ["exception_type", "Uncaught TypeError: x is not a function"],
    ["file_path", "C:\\inetpub\\wwwroot\\DemoApi\\app.dll failed to load"],
    ["file_path", "read failed at /Users/alice/project/app.js"],
    ["file_path", "thrown from Program.cs:line 42"],
    ["connection_string", "Server=tcp:db,1433;Password=hunter2;"],
    [
      "connection_string",
      "could not reach mongodb://cluster0.example.net/orders",
    ],
    ["connection_string", "fetch failed for https://user:pass@example.com/api"],
    ["credential", "Authorization: Bearer abcdefgh12345678"],
    [
      "credential",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U rejected",
    ],
    ["too_long", "x".repeat(1001)],
  ] satisfies Array<[string, string]>)("flags %s", (rule, value) => {
    expect(inspect(value).rule).toBe(rule);
    expect(forwardable(value)).toBeUndefined();
  });

  it("does not flag a bare 'Error' word (only specific exception type names)", () => {
    const message = "Error: quantity must be positive";
    expect(inspect(message).rule).toBeNull();
    expect(forwardable(message)).toBe(message);
  });

  it("normalizes whitespace on the forwarded value", () => {
    expect(forwardable("line one\n  line   two ")).toBe("line one line two");
  });
});

describe("mapInvokeResult pipeline order", () => {
  it("lets a host recognizer win before the status short-circuits, even on a 401", () => {
    const recognizer: Recognizer = (_parsed, res) =>
      res.status === 401 ? { message: "known maintenance window" } : null;

    const result = mapInvokeResult(
      response({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ message: "irrelevant standard body" }),
      }),
      { recognizers: [recognizer] },
    );

    expect(isMappedError(result)).toBe(true);
    expect(isMappedError(result) && result.message).toBe(
      "known maintenance window",
    );
    expect(isMappedError(result) && result.error).toBe("unauthenticated");
  });

  it("still leak-filters a host recognizer's output", () => {
    const recognizer: Recognizer = () => ({
      message:
        "at DemoApi.Services.OrderService.Validate(Order order) in /src/app.cs:line 88",
    });

    const result = mapInvokeResult(response({ status: 400 }), {
      recognizers: [recognizer],
    });

    expect(isMappedError(result) && result.message).toBe(
      "The backend rejected the request (400) without usable details. Check the arguments against the input schema.",
    );
  });

  it("tries host recognizers in registration order and uses the first non-null result", () => {
    const first: Recognizer = () => null;
    const second: Recognizer = () => ({ message: "from second" });
    const third: Recognizer = () => ({ message: "from third" });

    const result = mapInvokeResult(response({ status: 400 }), {
      recognizers: [first, second, third],
    });

    expect(isMappedError(result) && result.message).toBe("from second");
  });

  it("falls through to the built-in pipeline when every host recognizer returns null", () => {
    const recognizer: Recognizer = () => null;

    const result = mapInvokeResult(
      response({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ message: "backend detail" }),
      }),
      { recognizers: [recognizer] },
    );

    expect(isMappedError(result) && result.message).toBe("backend detail");
  });
});

describe("401 and 5xx ignore the body except for a correlation reference", () => {
  it("never forwards a 401 body, no matter its shape", () => {
    const result = mapInvokeResult(
      response({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Unauthorized",
          message: "Portal resolution failed: leaking internals",
        }),
      }),
    );

    expect(isMappedError(result) && result.message).toBe(
      "The backend did not accept the credentials the call carried (401); retrying with the same session will not help.",
    );
    expect(isMappedError(result) && result.fields).toBeUndefined();
  });

  it("never forwards a 5xx body, even with a stack trace in it", () => {
    const result = mapInvokeResult(
      response({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({
          title: "boom",
          detail: "at Some.Internal.Method(/src/app.cs:line 1)",
        }),
      }),
    );

    expect(isMappedError(result) && result.message).toBe(
      "The backend failed while handling the call (500). Details were withheld.",
    );
  });

  it("takes the reference from a correlation header over a ProblemDetails traceId", () => {
    const result = mapInvokeResult(
      response({
        status: 500,
        contentType: "application/problem+json",
        headers: { "x-correlation-id": "from-header" },
        body: JSON.stringify({ title: "boom", traceId: "from-body" }),
      }),
    );

    expect(isMappedError(result) && result.reference).toBe("from-header");
  });

  it("falls back to the ProblemDetails traceId when no correlation header is present", () => {
    const result = mapInvokeResult(
      response({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({ title: "boom", traceId: "trace-123" }),
      }),
    );

    expect(isMappedError(result) && result.reference).toBe("trace-123");
  });

  it("prefers x-correlation-id over the other correlation headers", () => {
    const result = mapInvokeResult(
      response({
        status: 502,
        headers: {
          "x-correlation-id": "wins",
          "x-request-id": "loses",
          "request-id": "loses-too",
          "x-trace-id": "also-loses",
        },
      }),
    );

    expect(isMappedError(result) && result.reference).toBe("wins");
  });

  it("has no reference when neither a header nor a ProblemDetails traceId is present", () => {
    const result = mapInvokeResult(response({ status: 500 }));
    expect(isMappedError(result) && result.reference).toBeUndefined();
    expect(isMappedError(result) && result.message).toBe(
      "The backend failed while handling the call (500). Details were withheld.",
    );
  });
});

describe("field-name normalization", () => {
  it("strips the $. JSON-path prefix", () => {
    const result = mapInvokeResult(
      response({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          errors: { "$.quantity": ["must be positive"] },
        }),
      }),
    );
    expect(isMappedError(result) && result.fields).toEqual([
      { name: "quantity", message: "must be positive" },
    ]);
  });

  it("matches knownFields case-insensitively", () => {
    const result = mapInvokeResult(
      response({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ errors: { Quantity: ["must be positive"] } }),
      }),
      { knownFields: ["quantity"] },
    );
    expect(isMappedError(result) && result.fields).toEqual([
      { name: "quantity", message: "must be positive" },
    ]);
  });

  it("keeps the backend's name verbatim when it matches no knownField", () => {
    const result = mapInvokeResult(
      response({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ errors: { Unmapped: ["oops"] } }),
      }),
      { knownFields: ["quantity"] },
    );
    expect(isMappedError(result) && result.fields).toEqual([
      { name: "Unmapped", message: "oops" },
    ]);
  });

  it("keeps the backend's name verbatim when knownFields is omitted", () => {
    const result = mapInvokeResult(
      response({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ errors: { Quantity: ["oops"] } }),
      }),
    );
    expect(isMappedError(result) && result.fields).toEqual([
      { name: "Quantity", message: "oops" },
    ]);
  });

  it("replaces a leaking field message with the generic field-leak message, per field", () => {
    const result = mapInvokeResult(
      response({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          errors: {
            item: ["is required"],
            quantity: ["at Foo.Bar(/src/app.cs:line 1)"],
          },
        }),
      }),
    );
    expect(isMappedError(result) && result.fields).toEqual([
      { name: "item", message: "is required" },
      {
        name: "quantity",
        message: "The value was rejected; details were withheld.",
      },
    ]);
  });
});

describe("status table and retryable set", () => {
  const table: Array<[number, BackendErrorCode]> = [
    [400, "bad_request"],
    [405, "bad_request"],
    [406, "bad_request"],
    [415, "bad_request"],
    [422, "bad_request"],
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not_found"],
    [410, "not_found"],
    [409, "conflict"],
    [412, "conflict"],
    [428, "conflict"],
    [429, "rate_limited"],
    [500, "backend_error"],
    [501, "backend_error"],
    [599, "backend_error"],
    [502, "backend_unavailable"],
    [503, "backend_unavailable"],
    [504, "backend_unavailable"],
    [408, "backend_unavailable"],
  ];

  it.each(table)(
    "maps status %i to %s without field errors",
    (status, code) => {
      expect(codeFor(status, false)).toBe(code);
    },
  );

  it("maps 400/422 to validation_failed only when field errors are present", () => {
    expect(codeFor(400, true)).toBe("validation_failed");
    expect(codeFor(422, true)).toBe("validation_failed");
  });

  it("exposes exactly the retryable statuses", () => {
    expect(retryableStatuses).toEqual(new Set([408, 429, 502, 503, 504]));
  });

  it.each([...retryableStatuses])(
    "marks %i as retryable on the mapped result",
    (status) => {
      const result = mapInvokeResult(response({ status }));
      expect(isMappedError(result) && result.retryable).toBe(true);
    },
  );

  it.each([400, 401, 403, 404, 409, 500, 501])(
    "marks %i as not retryable on the mapped result",
    (status) => {
      const result = mapInvokeResult(response({ status }));
      expect(isMappedError(result) && result.retryable).toBe(false);
    },
  );
});

describe("standardMessages covers every BackendErrorCode", () => {
  const codes: BackendErrorCode[] = [
    "validation_failed",
    "bad_request",
    "unauthenticated",
    "forbidden",
    "not_found",
    "conflict",
    "rate_limited",
    "backend_error",
    "backend_unavailable",
  ];

  it.each(codes)("produces a non-empty message for %s", (code) => {
    const message = standardMessages[code]({ status: 400 });
    expect(message.length).toBeGreaterThan(0);
  });

  it("interpolates {status} into bad_request and conflict", () => {
    expect(standardMessages.bad_request({ status: 405 })).toContain("405");
    expect(standardMessages.conflict({ status: 409 })).toContain("409");
  });

  it("drops the Reference sentence from backend_error when no reference is available", () => {
    expect(standardMessages.backend_error({ status: 500 })).toBe(
      "The backend failed while handling the call (500). Details were withheld.",
    );
    expect(
      standardMessages.backend_error({ status: 500, reference: "abc" }),
    ).toBe(
      "The backend failed while handling the call (500). Details were withheld. Reference: abc.",
    );
  });

  it("drops the retry sentence from rate_limited when no Retry-After is available", () => {
    expect(
      standardMessages.rate_limited({
        retryAfterSeconds: undefined,
        status: 429,
      }),
    ).toBe("The backend is rate-limiting this caller (429).");
    expect(
      standardMessages.rate_limited({ retryAfterSeconds: 12, status: 429 }),
    ).toBe(
      "The backend is rate-limiting this caller (429). Retry after 12 seconds.",
    );
  });
});

describe("success responses", () => {
  it("parses a JSON success body and never sets contentType for it", () => {
    const result = mapInvokeResult(
      response({
        status: 200,
        contentType: "application/json",
        body: '{"id":1}',
      }),
    );
    expect(result).toEqual({ status: 200, body: { id: 1 } });
  });

  it("keeps a text success body as a string alongside contentType", () => {
    const result = mapInvokeResult(
      response({ status: 200, contentType: "text/plain", body: "ok" }),
    );
    expect(result).toEqual({
      status: 200,
      body: "ok",
      contentType: "text/plain",
    });
  });

  it("omits body for an empty success response", () => {
    const result = mapInvokeResult(response({ status: 204 }));
    expect(result).toEqual({ status: 204 });
  });

  it("carries location only for a 3xx status, from the Location header", () => {
    const redirect = mapInvokeResult(
      response({ status: 302, headers: { location: "/orders/42" } }),
    );
    expect(redirect).toEqual({ status: 302, location: "/orders/42" });

    const ok = mapInvokeResult(
      response({ status: 200, headers: { location: "/orders/42" } }),
    );
    expect(ok).toEqual({ status: 200 });
  });
});
