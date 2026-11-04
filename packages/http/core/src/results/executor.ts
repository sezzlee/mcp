import type { ExecutionFailure } from "../generated/result-execution.js";
import type {
  ProgramInput,
  ProgramSuccess,
  ProgramFailure,
} from "../generated/result-program.js";

export type ExecutionLimits = Readonly<ExecutionFailure["limits"]>;

/** A host-supplied execution port; the HTTP core loads no JavaScript engine itself. */
export interface DataExecutor {
  readonly limits: ExecutionLimits;
  execute(
    input: ProgramInput & { readonly signal?: AbortSignal },
  ): Promise<ProgramSuccess | ProgramFailure>;
}
