// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
import { z } from "zod";

// Single source of truth for the note tools: the MCP server registers these schemas as
// tool inputs, and every .describe() text reaches the agent's LLM as tool documentation —
// write them for the model, not for developers.

export const NoteCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).describe("Short title of the note."),
  body: z.string().trim().max(5000).default("").describe("The note's text."),
});

export const NoteGetSchema = z.object({
  id: z.uuid().describe("The id returned by create_note or list_notes."),
});

export const NoteListSchema = z.object({
  search: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Only notes whose title contains this text (case-insensitive)."),
  limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of notes."),
});

export type NoteCreate = z.infer<typeof NoteCreateSchema>;
export type NoteList = z.infer<typeof NoteListSchema>;
