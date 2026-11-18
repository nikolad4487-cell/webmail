import {z} from 'zod';
import {db,hashPassword,transaction} from '../server/db';
import {rotateAdministratorPassword} from './administrator.js';

try {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL nije postavljen.');
  const input=z.object({
    ADMIN_EMAIL:z.string().trim().toLowerCase().email().default('admin@webmailhr.com'),
    ADMIN_PASSWORD:z.string().min(8).max(512),
  }).safeParse(process.env);
  if(!input.success) throw new Error('Postavite valjanu adresu ADMIN_EMAIL i lozinku ADMIN_PASSWORD od najmanje osam znakova.');
  const {ADMIN_EMAIL:address,ADMIN_PASSWORD:password}=input.data;
  delete process.env.ADMIN_PASSWORD;
  const hash=await hashPassword(password);
  await transaction(client=>rotateAdministratorPassword(client,address,hash));
  console.log('Administratorska lozinka je postavljena. Prethodne sesije su opozvane.');
} finally {
  await db.end();
}
