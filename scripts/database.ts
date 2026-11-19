import { readFile } from 'node:fs/promises';
import { db, transaction } from '../server/db.js';
try {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL nije postavljen.");
  const schema=await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8');
  await transaction(async client=>{
    await client.query("select pg_advisory_xact_lock(hashtext('webmailhr.schema'))");
    await client.query(schema);
    await client.query(await readFile(new URL('../migrations/001-native-mail.sql', import.meta.url),'utf8'));
  });
} finally { await db.end(); }
