import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {personAddress} from './directory-source.js';
import {HttpError} from './mail.js';

export async function allocateFormaPointAddress(c:Pick<PoolClient,'query'>,domain:string,sourceEmail:string,subject:string,name:string,options:{preserveSourceAddress?:boolean}={}){
  const preferred=personAddress('formapoint',domain,sourceEmail,subject,name,options.preserveSourceAddress)!;
  // Serializes competing names across different source identities. Address collisions
  // are checked against users, source login names, aliases, services and mailboxes.
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['formapoint-address:'+domain]);
  const [local]=preferred.split('@');
  for(let number=1;number<=10000;number++){
    const suffix=number===1?'':String(number),address=local.slice(0,64-suffix.length)+suffix+'@'+domain;
    const exists=await c.query(`select 1 from users where email=$1 or (source_email=$1 and source_user_id is distinct from $2)
      union all select 1 from mailboxes where address=$1 union all select 1 from aliases where address=$1
      union all select 1 from senders where address=$1`,[address,subject]);
    if(!exists.rowCount)return address;
    if(options.preserveSourceAddress!==false&&sourceEmail.endsWith('@'+domain))throw new HttpError(409,'Potvrđena adresa već je dodijeljena.');
  }
  throw new HttpError(409,'Nije moguće dodijeliti slobodnu osobnu adresu.');
}
export async function shortenExistingFormaPointAddresses(c:PoolClient){
  const project=process.env.FORMAPOINT_SUPABASE_PROJECT_ID?.trim(),domain=process.env.FORMAPOINT_MAIL_DOMAIN||'formapoint.online';
  if(!project)return 0;
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['formapoint-address:'+domain]);
  const {rows}=await c.query(`select u.*,m.id box from users u join mailboxes m on m.address=u.email and m.org=u.org
    join domains d on d.org=u.org and d.name=split_part(u.email,'@',2)
    where u.auth_kind='formapoint' and u.source_project=$1 and u.source_email is not null
      and u.active and u.role='user' and m.active and not m.shared and m.storage_kind='native'
      and d.name=$2 and d.mailbox_backend='native' order by u.id for update of u,m`,[project,domain]);
  let changed=0;
  for(const u of rows){
    if(u.source_email.endsWith('@'+domain))continue;
    const prefix=u.source_email.split('@')[0].replace(/[^a-z0-9]+/g,'.').replace(/^\.|\.$/g,'').slice(0,40)||'korisnik';
    const legacy=prefix+'.'+createHash('sha256').update(u.source_user_id).digest('hex').slice(0,16)+'@'+domain;
    if(u.email!==legacy)continue; // Never rename custom or already-short addresses.
    if((await c.query('select 1 from grants where box=$1 and uid<>$2',[u.box,u.id])).rowCount||
      !(await c.query('select 1 from grants where box=$1 and uid=$2',[u.box,u.id])).rowCount)throw new HttpError(409,'Sandučić nema isključivog vlasnika.');
    const displayName=project==='heseilggogbtmqeuwlku'&&u.source_email==='nikoladuric280@gmail.com'?'Nikola Duric':u.name;
    const address=await allocateFormaPointAddress(c,domain,u.source_email,u.source_user_id,displayName);
    if((await c.query('select 1 from aliases where address=$1 union all select 1 from senders where address=$1',[u.email])).rowCount)throw new HttpError(409,'Stara adresa ima povezani alias ili servis.');
    await c.query('update users set email=$2 where id=$1',[u.id,address]);
    await c.query('update mailboxes set address=$2 where id=$1',[u.box,address]);
    await c.query('delete from sessions where uid=$1',[u.id]);
    await c.query("insert into audits(uid,action,target) values($1,'formapoint.address.shorten',$2)",[u.id,address]);
    changed++;
  }
  return changed;
}
