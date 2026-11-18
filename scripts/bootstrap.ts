import {z} from 'zod';
import {db,hashPassword,transaction} from '../server/db';
import {addressing,demo} from '../server/mail';
import {adminPasswordMinLength} from '../shared/admin-password.js';

try{
  if(demo) throw new Error('Za lokalne račune koristite npm run seed.');
  const input=z.object({
    BOOTSTRAP_ORG:z.string().trim().min(1).max(240),
    BOOTSTRAP_NAME:z.string().trim().min(1).max(240),
    BOOTSTRAP_EMAIL:z.string().trim().toLowerCase().email(),
    BOOTSTRAP_PASSWORD:z.string().min(adminPasswordMinLength).max(512),
    BOOTSTRAP_RECOVERY:z.string().trim().toLowerCase().email().optional(),
  }).safeParse(process.env);
  if(!input.success) throw new Error('Nedostaju valjane varijable BOOTSTRAP_*.');
  const x=input.data, password=await hashPassword(x.BOOTSTRAP_PASSWORD);
  await transaction(async c=>{
    await c.query("lock table users in share row exclusive mode");
    if((await c.query("select 1 from users where role='root' limit 1")).rowCount) throw new Error('Glavni administrator već postoji.');
    const {rows:[org]}=await c.query('insert into organizations(name) values($1) on conflict(name) do update set name=excluded.name returning id',[x.BOOTSTRAP_ORG]);
    await c.query('insert into domains(name,org) values($1,$2) on conflict do nothing',[addressing(x.BOOTSTRAP_EMAIL),org.id]);
    const match=await c.query('select 1 from domains where org=$1 and name=$2',[org.id,addressing(x.BOOTSTRAP_EMAIL)]);
    if(!match.rowCount) throw new Error('Domena pripada drugoj organizaciji.');
    await c.query("insert into users(org,email,name,password,recovery,role) values($1,$2,$3,$4,$5,'root')",[org.id,x.BOOTSTRAP_EMAIL,x.BOOTSTRAP_NAME,password,x.BOOTSTRAP_RECOVERY??null]);
  });
  console.log('Glavni administrator je kreiran.');
}finally{await db.end();}
