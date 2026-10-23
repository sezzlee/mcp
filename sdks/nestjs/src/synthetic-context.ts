import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  decodeResponseBody,
  SezzleeDispatchAborted,
  type DispatchAbortReason,
} from "@sezzlee/core";
import type { DispatchResult } from "./dispatcher.js";
import type { OuterConnection } from "./outer-connection.js";

export { SezzleeDispatchAborted };
export type { DispatchAbortReason };

/** The handler wrote more than the read cap; the body was dropped as it crossed it. */
export class SezzleeResponseTooLarge extends Error {
  constructor(
    readonly limit: number,
    readonly status: number,
  ) {
    super(`The response exceeded ${limit} bytes.`);
    this.name = "SezzleeResponseTooLarge";
  }
}

export interface SyntheticContext {
  req: IncomingMessage;
  res: ServerResponse;
  result: Promise<DispatchResult>;
  /**
   * Abandons the dispatch and delivers a client disconnect to the handler.
   *
   * @param reason why the dispatch was abandoned
   */
  abort(reason: DispatchAbortReason): void;
}

function captureHeaders(res: ServerResponse): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.getHeaders())) {
    if (value === undefined) {
      continue;
    }
    headers[name.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : String(value);
  }
  return headers;
}

function reflectConnection(
  socket: Socket,
  connection: OuterConnection | undefined,
): void {
  if (connection === undefined) {
    return;
  }
  for (const [name, value] of Object.entries(connection)) {
    if (value !== undefined) {
      Object.defineProperty(socket, name, { value, configurable: true });
    }
  }
}

function bodyOf(
  bytes: Buffer,
  contentType: string | undefined,
): Pick<DispatchResult, "body" | "bodyEncoding"> {
  const { body, bodyEncoding } = decodeResponseBody(bytes, contentType);
  return {
    body: body ?? "",
    ...(bodyEncoding === undefined ? {} : { bodyEncoding }),
  };
}

export function createSyntheticContext(
  method: string,
  url: string,
  headers: Record<string, string>,
  scheme: string,
  body?: Buffer,
  connection?: OuterConnection,
  maxBytes?: number,
): SyntheticContext {
  const socket = new Socket();
  if (scheme === "https") {
    Object.defineProperty(socket, "encrypted", { value: true });
  }
  reflectConnection(socket, connection);

  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  req.headers = { ...headers };
  if (body !== undefined) {
    req.headers["content-length"] = String(body.byteLength);
    req.push(body);
  }
  req.push(null);
  /**
   * Node's HTTP parser sets `complete`; nothing does for a hand-built message. Left false, the
   * stream's auto-destroy emits `aborted` as soon as the body is consumed, so every dispatch looked
   * like a client disconnect — multer answers it with a 500. Pinned by N2 in
   * test/form-body-probe.spec.ts.
   */
  req.complete = true;

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  let buffered = 0;
  let settled = false;
  let stop: ((error: Error) => void) | undefined;
  const result = new Promise<DispatchResult>((resolve, reject) => {
    const capture = (chunk: unknown, encoding: unknown): void => {
      if (settled) {
        return;
      }
      let bytes: Buffer;
      if (typeof chunk === "string") {
        bytes = Buffer.from(
          chunk,
          typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
        );
      } else if (chunk instanceof Buffer || chunk instanceof Uint8Array) {
        bytes = Buffer.from(chunk);
      } else {
        return;
      }
      buffered += bytes.byteLength;
      if (maxBytes !== undefined && buffered > maxBytes) {
        chunks.length = 0;
        stop?.(new SezzleeResponseTooLarge(maxBytes, res.statusCode));
        return;
      }
      chunks.push(bytes);
    };
    res.write = function write(
      chunk: unknown,
      encoding?: unknown,
      callback?: unknown,
    ): boolean {
      capture(chunk, encoding);
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") {
        (done as () => void)();
      }
      return true;
    } as typeof res.write;
    res.end = function end(
      chunk?: unknown,
      encoding?: unknown,
      callback?: unknown,
    ): ServerResponse {
      if (settled) {
        return res;
      }
      if (typeof chunk !== "function") {
        capture(chunk, encoding);
      }
      const done = [chunk, encoding, callback].find(
        (arg) => typeof arg === "function",
      );
      if (settled) {
        if (typeof done === "function") {
          (done as () => void)();
        }
        return res;
      }
      const responseHeaders = captureHeaders(res);
      settled = true;
      resolve({
        status: res.statusCode,
        ...bodyOf(Buffer.concat(chunks), responseHeaders["content-type"]),
        contentType: responseHeaders["content-type"],
        headers: responseHeaders,
      });
      res.emit("finish");
      res.emit("close");
      if (typeof done === "function") {
        (done as () => void)();
      }
      return res;
    } as typeof res.end;
    /**
     * `settled` is the single guard: without it an abandoned handler that later calls `res.end()`
     * resolves an already-rejected dispatch, emits a second `finish`/`close` into Nest's own
     * listeners, and mutates `chunks` after the body string was built from it. Nest does not
     * unsubscribe a route handler on disconnect, so an abandoned handler running to completion is
     * the normal case, not the exception. Pinned by the abandoned-handler tests in
     * test/dispatch-abort.spec.ts.
     */
    stop = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
      try {
        req.emit("aborted");
        req.emit("close");
        res.emit("close");
        socket.emit("close");
      } catch (error) {
        process.stderr.write(
          `sezzlee: a disconnect listener threw: ${String(error)}\n`,
        );
      }
    };
  });

  return {
    req,
    res,
    result,
    abort: (reason: DispatchAbortReason): void => {
      stop?.(new SezzleeDispatchAborted(reason));
    },
  };
}
