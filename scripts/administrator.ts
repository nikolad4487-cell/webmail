import type {PoolClient} from 'pg';
import {digest} from '../server/db.js';

export class AdministratorSetupError extends Error {}

export async function createAdministrator(client:PoolClient,input:{
  email:string;
  name:string;
  organization:string;
  passwordHash:string;
  recovery?:string;
}){
  if((await client.query("select 1 from users where role='root' limit 1")).rowCount){
    throw new AdministratorSetupError('Glavni administrator već postoji.');
  }
  const domain=input.email.split('@').at(-1);
  const {rows:[org]}=await client.query('insert into organizations(name) values($1) on conflict(name) do update set name=excluded.name returning id',[input.organization]);
  await client.query('insert into domains(name,org) values($1,$2) on conflict do nothing',[domain,org.id]);
  const match=await client.query('select 1 from domains where org=$1 and name=$2',[org.id,domain]);
  if(!match.rowCount) throw new AdministratorSetupError('Domena pripada drugoj organizaciji.');
  await client.query("insert into users(org,email,name,password,recovery,role) values($1,$2,$3,$4,$5,'root')",
    [org.id,input.email,input.name,input.passwordHash,input.recovery??null]);
}

export async function rotateAdministratorPassword(client:PoolClient,address:string,hash:string){
  const {rows:[account]}=await client.query("select id from users where email=$1 and role='root' and auth_kind='local' and active for update",[address]);
  if(!account) throw new AdministratorSetupError('Na toj adresi nema aktivnog glavnog administratora. Provjerite adresu postojećeg računa.');
  await client.query('update users set password=$2 where id=$1',[account.id,hash]);
  await client.query('delete from resets where uid=$1',[account.id]);
  await client.query('delete from sessions where uid=$1',[account.id]);
  await client.query('delete from login_limits where key=$1',[digest('login:admin:'+address)]);
  await client.query("insert into audits(uid,action,target) values($1,'admin.password.rotate',$2)",[account.id,address]);
}
