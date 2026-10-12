import type { GatewayConfig } from "../platform/config.js";

export type ReloadSettings = NonNullable<GatewayConfig["reload"]>;

const jitter = 0.1;

/**
 * Starts the reload triggers the settings ask for and returns the function that stops them.
 *
 * Guard: the interval timer is unref'd. On stdio the process must exit once the client closes
 * stdin, and a pending timer would keep it alive with no client left to serve. The next read is
 * scheduled only after the previous one settles, so a slow source never stacks reads.
 */
export function watchSource(
  settings: ReloadSettings,
  reload: () => Promise<unknown>,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const onSignal = (): void => {
    void reload();
  };
  if (settings.onSignal) {
    process.on("SIGHUP", onSignal);
  }
  const seconds = settings.intervalSeconds;
  const schedule = (): void => {
    if (seconds === undefined || stopped) {
      return;
    }
    const delay = seconds * 1000 * (1 + Math.random() * jitter);
    timer = setTimeout(() => {
      void reload().finally(schedule);
    }, delay);
    timer.unref();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    process.off("SIGHUP", onSignal);
  };
}
