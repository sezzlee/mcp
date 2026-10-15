import { describe, expect, it } from "vitest";
import { isSelected, type SelectionMarker } from "../src/selection.js";

describe("the provided selection level", () => {
  it.each<{
    name: string;
    operation?: SelectionMarker;
    container?: SelectionMarker;
    provided?: "include" | "exclude";
    rule?: SelectionMarker;
    fallback: "include" | "exclude";
    selected: boolean;
  }>([
    {
      name: "outranks a rule",
      provided: "include",
      rule: "exclude",
      fallback: "exclude",
      selected: true,
    },
    {
      name: "outranks the global default",
      provided: "exclude",
      fallback: "include",
      selected: false,
    },
    {
      name: "loses to a container marker",
      container: "exclude",
      provided: "include",
      fallback: "include",
      selected: false,
    },
    {
      name: "loses to an operation marker",
      operation: "include",
      container: "exclude",
      provided: "exclude",
      fallback: "exclude",
      selected: true,
    },
    {
      name: "is absent, so a rule decides",
      rule: "include",
      fallback: "exclude",
      selected: true,
    },
  ])("$name", (row) => {
    expect(
      isSelected(
        row.fallback,
        row.container,
        row.operation,
        undefined,
        row.rule,
        row.provided,
      ),
    ).toBe(row.selected);
  });
});
