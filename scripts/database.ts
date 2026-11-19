import { readFile } from 'node:fs/promises';
import { db, transaction } from '../server/db.js';
import {runMigrationQueries} from './migration-diagnostics.js';
try {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL nije postavljen.");
  const schema=await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8');
  const native=await readFile(new URL('../migrations/001-native-mail.sql', import.meta.url),'utf8');
  await transaction(client=>runMigrationQueries(client,schema,native));
} finally { await db.end(); }
