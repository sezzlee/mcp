import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchSource } from "../src/catalog/watch.js";

function trigger() {
  const pending: (() => void)[] = [];
  const reload = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
  );
  const settle = async (): Promise<void> => {
    pending.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { reload, settle };
}

let stops: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  stops = [];
});

afterEach(() => {
  for (const stop of stops) {
    stop();
  }
  vi.useRealTimers();
});

describe("openapi-mcp reload triggers", () => {
  it("re-reads no sooner than the interval and within its 10% jitter, and not again before the read settles", async () => {
    const { reload, settle } = trigger();
    stops.push(watchSource({ intervalSeconds: 10, onSignal: false }, reload));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(reload).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(reload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).toHaveBeenCalledTimes(1);

    await settle();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("adds no timer that keeps the event loop alive", () => {
    vi.useRealTimers();
    const timeouts = () =>
      process.getActiveResourcesInfo().filter((name) => name === "Timeout")
        .length;
    const before = timeouts();

    stops.push(
      watchSource({ intervalSeconds: 10, onSignal: false }, trigger().reload),
    );

    expect(timeouts()).toBe(before);
  });

  it("re-reads on SIGHUP when onSignal is set, and ignores it otherwise", () => {
    const listening = trigger();
    const deaf = trigger();
    stops.push(watchSource({ onSignal: true }, listening.reload));
    stops.push(watchSource({ onSignal: false }, deaf.reload));

    process.emit("SIGHUP", "SIGHUP");

    expect(listening.reload).toHaveBeenCalledTimes(1);
    expect(deaf.reload).toHaveBeenCalledTimes(0);
  });

  it("stops both triggers", async () => {
    const { reload } = trigger();
    const stop = watchSource({ intervalSeconds: 10, onSignal: true }, reload);

    stop();
    process.emit("SIGHUP", "SIGHUP");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(reload).toHaveBeenCalledTimes(0);
    expect(process.listenerCount("SIGHUP")).toBe(0);
  });
});
