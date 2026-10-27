import type { LabScenario } from "../trial.ts";
import { bulkScenarios } from "./bulk.ts";
import { calcScenarios } from "./calc.ts";
import { editScenarios } from "./edit.ts";
import { expertScenarios } from "./expert.ts";

export const suites: Readonly<Record<string, readonly LabScenario[]>> = {
  edit: editScenarios,
  bulk: bulkScenarios,
  expert: expertScenarios,
  calc: calcScenarios,
};
