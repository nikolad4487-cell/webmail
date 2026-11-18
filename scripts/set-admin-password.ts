import {z} from 'zod';
import {db,digest,hashPassword,transaction} from '../server/db';
import {adminPasswordMinLength} from '../shared/admin-password.js';

try {
  const input=z.object({
    ADMIN_RESET_EMAIL:z.string().trim().toLowerCase().email(),
    ADMIN_RESET_PASSWORD:z.string().min(adminPasswordMinLength).max(512),
  }).safeParse(process.env);
  if(!input.success) throw new Error(`Postavite ADMIN_RESET_EMAIL i novu lozinku od najmanje ${adminPasswordMinLength} znakova.`);
  const {ADMIN_RESET_EMAIL:address,ADMIN_RESET_PASSWORD:password}=input.data;
  const hash=await hashPassword(password);
  await transaction(async client=>{
    const {rows:[account]}=await client.query(
      "update users set password=$2 where email=$1 and active and auth_kind='local' and role in ('root','admin') returning id",
      [address,hash]);
    if(!account) throw new Error('Aktivan lokalni administratorski račun nije pronađen.');
    await client.query('delete from sessions where uid=$1',[account.id]);
    await client.query('delete from resets where uid=$1',[account.id]);
    await client.query('delete from login_limits where key=$1',[digest('login:admin:'+address)]);
    await client.query("insert into audits(uid,action,target) values(null,'admin.password.reset',$1)",[String(account.id)]);
  });
  console.log('Lozinka je promijenjena i postojeće sesije su odjavljene.');
}finally{await db.end();}
