/** Why a run does not count toward model accuracy, or that it does. */
export type Eligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason:
        | "hostError"
        | "preflightRefused"
        | "providerContextError"
        | "windowMismatch";
    };

/**
 * The one rule every report, comparison and summary applies: a run the host
 * failed, a request the preflight refused, and a run whose host held the
 * model with another window measure the setup, not the model, so they are
 * counted apart from accuracy. Runs saved before the outcome was split call a
 * refused preflight `contextExceeded`.
 */
export function eligibilityOf(run: {
  readonly outcome: string;
  readonly window: number;
  readonly loadedWindow: number | null;
}): Eligibility {
  if (run.outcome === "hostError")
    return { eligible: false, reason: "hostError" };
  if (run.outcome === "preflightRefused" || run.outcome === "contextExceeded")
    return { eligible: false, reason: "preflightRefused" };
  if (run.outcome === "providerContextError")
    return { eligible: false, reason: "providerContextError" };
  if (run.loadedWindow !== null && run.loadedWindow !== run.window)
    return { eligible: false, reason: "windowMismatch" };
  return { eligible: true };
}
