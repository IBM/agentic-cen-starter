// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
import type { NoteCreate, NoteList } from "@cen/shared";
import { desc, eq, ilike } from "drizzle-orm";
import { db } from "../db";
import { notes } from "../db/schema";

// Persistence for the note tools, free of MCP types: server.ts maps results and
// ToolErrors onto tool responses.

/** An expected failure the agent should react to (not found, invalid input). */
export class ToolError extends Error {}

type NoteRow = typeof notes.$inferSelect;

const toNote = (row: NoteRow) => ({
  id: row.id,
  title: row.title,
  body: row.body,
  created_at: row.createdAt.toISOString(),
});

export async function createNote(input: NoteCreate) {
  const [row] = await db.insert(notes).values(input).returning();
  if (!row) throw new Error("note insert returned no row");
  return toNote(row);
}

export async function getNote(id: string) {
  const [row] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  if (!row) throw new ToolError(`No note with id ${id}.`);
  return toNote(row);
}

export async function listNotes({ search, limit }: NoteList) {
  // Escape LIKE wildcards so the search text matches literally.
  const pattern = search && `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db
    .select()
    .from(notes)
    .where(pattern ? ilike(notes.title, pattern) : undefined)
    .orderBy(desc(notes.createdAt))
    .limit(limit);
  return rows.map(toNote);
}
