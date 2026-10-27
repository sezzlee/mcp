export interface MetadataLimitation {
  readonly code: "formula_cf_thresholds";
  readonly message: string;
  readonly followUp: string;
}
export const metadataLimitations = {
  thresholds: {
    code: "formula_cf_thresholds",
    message:
      "A conditional-format threshold whose value is not a finite number is reported without one.",
    followUp: "EXCEL-META-010",
  },
} as const satisfies Record<string, MetadataLimitation>;
