import { Pool, type PoolClient } from 'pg';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import service from './service.mjs';

// On Prisma Compute and under `prisma dev` the database arrives through the
// service's declared dependency: service.load() reads the raw Postgres
// binding's URL (stashed as COMPOSER_DB_URL). Where the Composer runtime
// keeps no rows (the Vercel function, `npm run dev`, and tests that set
// DATABASE_URL), keep this module's original DATABASE_URL source.
export const databaseUrl = (() => {
  try { return service.load().db.url; }
  catch { return process.env.DATABASE_URL; }
})();
export const db = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
export type LoginDatabaseIssue='DB_CONFIG'|'DB_SCHEMA'|'DB_PERMISSION'|'DB_CONNECTION';

export function loginDatabaseIssue(error:unknown):LoginDatabaseIssue|undefined {
  if(!(error instanceof Error)) return;
  const {code,message}=error as Error & {code?:string};
  if(code && ['42P01','42703','3F000'].includes(code)) return 'DB_SCHEMA';
  if(code && ['42501','25006'].includes(code)) return 'DB_PERMISSION';
  if(code && ['ERR_INVALID_URL','28P01','28000','3D000'].includes(code)) return 'DB_CONFIG';
  if(code?.startsWith('08') || (code && [
    'ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ECONNREFUSED','ECONNRESET','ETIMEDOUT',
    'DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID',
    '53300','57P01','57P02','57P03',
  ].includes(code)) || /^(Connection terminated|timeout expired|SASL:)/i.test(message)) return 'DB_CONNECTION';
}

export async function checkLoginDatabase() {
  // PostgreSQL resolves these tables, columns and read permissions without reading account data.
  await db.query(`select u.id,u.auth_kind,u.password,u.active,u.email,u.role,u.source_project,u.source_user_id,u.source_email,
    s.token,s.uid,s.expires,l.key,l.count,l.expires
    from users u cross join sessions s cross join login_limits l limit 0`);
  const {rows:[rights]}=await db.query(`select
    has_table_privilege('sessions','INSERT') and
    has_table_privilege('login_limits','INSERT') and
    has_table_privilege('login_limits','UPDATE') and
    has_table_privilege('login_limits','DELETE') as can_login`);
  return rights.can_login===true;
}
export const token = () => randomBytes(32).toString('hex');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const derive = promisify(scrypt);
export async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + (await derive(password, salt, 64) as Buffer).toString('hex');
}
export async function verifyPassword(password: string, hash: string) {
  const expected = Buffer.from(hash);
  const candidate = Buffer.from(await hashPassword(password, hash.split(':')[0]));
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}
export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
