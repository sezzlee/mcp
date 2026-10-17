import { namespaces, type PartScan, type XmlVisitor } from "./xml.js";

export interface OoxmlThreshold {
  readonly type: string;
  readonly value?: number;
  readonly formula?: string;
}

export interface OoxmlConditionalRule {
  readonly type: string;
  readonly operator?: string;
  readonly priority?: number;
  readonly formulae?: readonly string[];
  readonly timePeriod?: string;
  readonly iconSet?: string;
  readonly rank?: number;
  readonly percent?: boolean;
  readonly bottom?: boolean;
  readonly aboveAverage?: boolean;
  readonly cfvo?: readonly OoxmlThreshold[];
}

export interface OoxmlConditionalBlock {
  readonly ref?: string;
  readonly rules: readonly OoxmlConditionalRule[];
}

/**
 * ECMA-376 spells these as five distinct rule types, but they are one predicate
 * family with the operator folded into the name. Splitting them back keeps the
 * reported `type` stable across the family and puts the distinction where the
 * other rule types already carry it.
 */
const foldedTypes = new Set([
  "containsText",
  "containsBlanks",
  "notContainsBlanks",
  "containsErrors",
  "notContainsErrors",
]);

function integer(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  return raw === "1" || raw === "true";
}

interface RuleDraft {
  type: string;
  operator?: string;
  priority?: number;
  formulae: string[];
  timePeriod?: string;
  iconSet?: string;
  rank?: number;
  percent?: boolean;
  bottom?: boolean;
  aboveAverage?: boolean;
  cfvo: OoxmlThreshold[];
}

export function conditionalFormatScan(): PartScan<
  readonly OoxmlConditionalBlock[]
> {
  const blocks: OoxmlConditionalBlock[] = [];
  let currentRef: string | undefined;
  let currentRules: RuleDraft[] | undefined;
  let rule: RuleDraft | undefined;
  let formulaText: string | undefined;

  const visitor: XmlVisitor = {
    onOpen(node) {
      if (node.uri !== namespaces.spreadsheetml) return;
      switch (node.local) {
        case "conditionalFormatting":
          currentRef = node.attr("sqref");
          currentRules = [];
          break;
        case "cfRule": {
          if (currentRules === undefined) break;
          const declared = node.attr("type") ?? "unknown";
          const folded = foldedTypes.has(declared);
          rule = {
            type: folded ? "containsText" : declared,
            operator: folded ? declared : node.attr("operator"),
            priority: integer(node.attr("priority")),
            formulae: [],
            timePeriod: node.attr("timePeriod"),
            rank: integer(node.attr("rank")),
            percent: boolean(node.attr("percent")),
            bottom: boolean(node.attr("bottom")),
            aboveAverage: boolean(node.attr("aboveAverage")),
            cfvo: [],
          };
          break;
        }
        case "iconSet":
          if (rule !== undefined) {
            rule.iconSet = node.attr("iconSet") ?? "3TrafficLights";
          }
          break;
        case "cfvo": {
          if (rule === undefined) break;
          const type = node.attr("type") ?? "num";
          const raw = node.attr("val");
          const parsed =
            raw === undefined ? Number.NaN : Number.parseFloat(raw);
          /**
           * A `formula` threshold carries expression text in `val`, which no
           * numeric parse can represent. Keeping the text is what lets the
           * predicate be reported instead of marked unreadable.
           */
          rule.cfvo.push({
            type,
            ...(type === "formula"
              ? raw === undefined
                ? {}
                : { formula: raw }
              : Number.isFinite(parsed)
                ? { value: parsed }
                : {}),
          });
          break;
        }
        case "formula":
          if (rule !== undefined) formulaText = "";
          break;
        default:
          break;
      }
    },
    onText(text) {
      if (formulaText !== undefined) formulaText += text;
    },
    onClose(local, uri) {
      if (uri !== namespaces.spreadsheetml) return;
      if (local === "formula") {
        if (rule !== undefined && formulaText !== undefined) {
          rule.formulae.push(formulaText);
        }
        formulaText = undefined;
        return;
      }
      if (local === "cfRule") {
        if (rule !== undefined && currentRules !== undefined) {
          currentRules.push(rule);
        }
        rule = undefined;
        return;
      }
      if (local === "conditionalFormatting" && currentRules !== undefined) {
        blocks.push({
          ...(currentRef === undefined ? {} : { ref: currentRef }),
          rules: currentRules.map((draft): OoxmlConditionalRule => ({
            type: draft.type,
            ...(draft.operator === undefined
              ? {}
              : { operator: draft.operator }),
            ...(draft.priority === undefined
              ? {}
              : { priority: draft.priority }),
            ...(draft.formulae.length === 0
              ? {}
              : { formulae: draft.formulae }),
            ...(draft.timePeriod === undefined
              ? {}
              : { timePeriod: draft.timePeriod }),
            ...(draft.iconSet === undefined ? {} : { iconSet: draft.iconSet }),
            ...(draft.rank === undefined ? {} : { rank: draft.rank }),
            ...(draft.percent === undefined ? {} : { percent: draft.percent }),
            ...(draft.bottom === undefined ? {} : { bottom: draft.bottom }),
            ...(draft.aboveAverage === undefined
              ? {}
              : { aboveAverage: draft.aboveAverage }),
            ...(draft.cfvo.length === 0 ? {} : { cfvo: draft.cfvo }),
          })),
        });
        currentRules = undefined;
        currentRef = undefined;
      }
    },
  };
  return { visitor, finish: () => blocks };
}
