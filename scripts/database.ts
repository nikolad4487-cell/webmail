import { readFile } from 'node:fs/promises';
import { db } from '../server/db';
try {
  await db.query(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'));
} finally { await db.end(); }
