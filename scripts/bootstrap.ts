import {z} from 'zod';
import {db,hashPassword,transaction} from '../server/db';
import {demo} from '../server/mail';
import {createAdministrator} from './administrator.js';

try{
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL nije postavljen.');
  if(demo) throw new Error('Za lokalne račune koristite npm run seed.');
  const input=z.object({
    BOOTSTRAP_ORG:z.string().trim().min(1).max(240),
    BOOTSTRAP_NAME:z.string().trim().min(1).max(240),
    BOOTSTRAP_EMAIL:z.string().trim().toLowerCase().email(),
    BOOTSTRAP_PASSWORD:z.string().min(8).max(512),
    BOOTSTRAP_RECOVERY:z.string().trim().toLowerCase().email().optional(),
  }).safeParse(process.env);
  if(!input.success) throw new Error('Nedostaju valjane varijable BOOTSTRAP_*.');
  const x=input.data;
  delete process.env.BOOTSTRAP_PASSWORD;
  const password=await hashPassword(x.BOOTSTRAP_PASSWORD);
  await transaction(async c=>{
    await c.query("lock table users in share row exclusive mode");
    await createAdministrator(c,{email:x.BOOTSTRAP_EMAIL,name:x.BOOTSTRAP_NAME,
      organization:x.BOOTSTRAP_ORG,passwordHash:password,recovery:x.BOOTSTRAP_RECOVERY});
  });
  console.log('Glavni administrator je kreiran.');
}finally{await db.end();}
