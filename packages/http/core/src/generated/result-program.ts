export type ResultProgram = ProgramInput | ProgramSuccess | ProgramFailure;

export interface ProgramInput {
  code: string;
  json: string;
}
export interface ProgramSuccess {
  kind: "success";
  json: string;
}
export interface ProgramFailure {
  kind: "failure";
  reason:
    | "invalid_input"
    | "code_limit"
    | "input_limit"
    | "output_limit"
    | "invalid_program"
    | "program_failed"
    | "invalid_result"
    | "memory_limit"
    | "timeout"
    | "cancelled"
    | "busy"
    | "unavailable";
}
