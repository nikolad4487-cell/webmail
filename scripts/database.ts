import { readFile } from 'node:fs/promises';
import { db } from '../server/db';
try {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL nije postavljen.");
  await db.query(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'));
} finally { await db.end(); }
