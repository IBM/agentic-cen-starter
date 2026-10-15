// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const notes = pgTable("note", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
