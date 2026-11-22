import type {PoolClient} from 'pg';
import {HttpError,addressing} from './mail.js';

export function requireNativeSetup(){
  if(!process.env.MAILJET_API_KEY?.trim()||!process.env.MAILJET_SECRET_KEY?.trim()||
    (process.env.CLOUDFLARE_INBOUND_SECRET?.trim().length??0)<32){
    throw new HttpError(503,'Prvo konfigurirajte Mailjet i zaštitni ključ za primitak pošte.');
  }
}
export async function usesNativeDomain(c:Pick<PoolClient,'query'>,address:string,org?:number){
  const domain=addressing(address);
  const result=await c.query(`select 1 from domains where name=$1 and ($2::int is null or org=$2)
    and mailbox_backend='native' and inbound and outbound`,[domain,org??null]);
  return !!result.rowCount;
}
export async function attachPersonalOwner(c:PoolClient,box:number,org:number,address:string){
  const {rows:[owner]}=await c.query('select id from users where org=$1 and email=$2 and active and role<>\'root\'',[org,address]);
  if(!owner)throw new HttpError(409,'Prvo izradite aktivnog korisnika iste e-mail adrese u ovoj organizaciji.');
  if((await c.query('select 1 from directory_identities where uid=$1',[owner.id])).rowCount){
    throw new HttpError(409,'Sandučić sinkroniziranog korisnika stvara se kroz postojeću sinkronizaciju.');
  }
  const conflict=await c.query('select 1 from grants where box=$1 and uid<>$2',[box,owner.id]);
  if(conflict.rowCount)throw new HttpError(409,'Osobni sandučić već je dodijeljen drugom korisniku.');
  await c.query(`insert into grants(uid,box,can_send,can_calendar) values($1,$2,true,true)
    on conflict(uid,box) do update set can_send=true`,[owner.id,box]);
}
export async function provisionCandidates(c:Pick<PoolClient,'query'>,org:number|null){
  const {rows}=await c.query(`select u.id,u.org,u.email,u.name from users u
    join domains d on d.org=u.org and d.name=split_part(u.email,'@',2)
    where ($1::int is null or u.org=$1) and u.active and u.role<>'root'
      and d.mailbox_backend='native' and d.inbound and d.outbound
      and not exists(select 1 from mailboxes m where m.address=u.email)
      and not exists(select 1 from aliases a where a.address=u.email)
      and not exists(select 1 from senders s where s.address=u.email)
      and not exists(select 1 from directory_identities i where i.uid=u.id)
    order by u.id limit 101`,[org]);
  return {users:rows.slice(0,100),hasMore:rows.length>100};
}
export async function provisionUserMailbox(c:PoolClient,uid:number,org:number|null,actor:number){
  const {rows:[u]}=await c.query('select id,org,email,name,active,role from users where id=$1 and ($2::int is null or org=$2)',[uid,org]);
  if(!u||!u.active||u.role==='root')return false;
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[u.email]);
  if(!await usesNativeDomain(c,u.email,u.org))return false;
  const conflict=await c.query(`select 1 from mailboxes where address=$1 union all select 1 from aliases where address=$1
    union all select 1 from senders where address=$1 union all select 1 from directory_identities where uid=$2`,[u.email,u.id]);
  if(conflict.rowCount)return false;
  const {rows:[box]}=await c.query(`insert into mailboxes(org,address,label,storage_kind)
    values($1,$2,$3,'native') returning id`,[u.org,u.email,u.name]);
  await attachPersonalOwner(c,box.id,u.org,u.email);
  await c.query('insert into audits(uid,action,target) values($1,$2,$3)',[actor,'mailbox.personal.create',String(box.id)]);
  return true;
}
