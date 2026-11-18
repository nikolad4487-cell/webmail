import { Pool, type PoolClient } from 'pg';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export const db = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
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
