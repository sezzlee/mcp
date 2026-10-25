import { Injectable } from "@nestjs/common";
import { defineProviderTool } from "@sezzlee/sdk-nestjs";
import { z } from "zod";

@Injectable()
export class NoteSummaryService {
  summarize(text: string) {
    return { characters: text.length, words: text.trim().split(/\s+/u).length };
  }
}

export const noteSummaryTool = defineProviderTool({
  name: "summarize_note",
  description: "Count the characters and words in a note.",
  provider: NoteSummaryService,
  input: z.strictObject({ text: z.string().trim().min(1).max(10000) }),
  output: z.strictObject({
    characters: z.number().int(),
    words: z.number().int(),
  }),
  annotations: { readOnlyHint: true },
  tags: ["notes"],
  access: "public",
  execute: (service, input) => service.summarize(input.text),
});
