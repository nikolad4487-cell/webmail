import {z} from 'zod';
import {db,digest,hashPassword,transaction} from '../server/db';

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
  await transaction(async client=>{
    const {rows:[account]}=await client.query("select id from users where email=$1 and role='root' and auth_kind='local' and active for update",[address]);
    if(!account) throw new Error('Na toj adresi nema aktivnog glavnog administratora. Provjerite adresu postojećeg računa.');
    await client.query('update users set password=$2 where id=$1',[account.id,hash]);
    await client.query('delete from resets where uid=$1',[account.id]);
    await client.query('delete from sessions where uid=$1',[account.id]);
    await client.query('delete from login_limits where key=$1',[digest('login:admin:'+address)]);
    await client.query("insert into audits(uid,action,target) values($1,'admin.password.rotate',$2)",[account.id,address]);
  });
  console.log('Administratorska lozinka je postavljena. Prethodne sesije su opozvane.');
} finally {
  await db.end();
}
