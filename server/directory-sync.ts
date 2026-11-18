import {randomBytes} from 'node:crypto';
import {ImapFlow} from 'imapflow';
import type {PoolClient} from 'pg';
import {transaction} from './db.js';
import {directoryConfig,type DirectoryPerson} from './directory-source.js';
import {mailboxKey,openMailboxPassword,sealMailboxPassword} from './mailbox-secrets.js';

type Config=ReturnType<typeof directoryConfig>;
export class DirectoryConflict extends Error {}

async function schoolMemberships(client:PoolClient,config:Config,org:number,person:DirectoryPerson){
  const memberships=new Map<string,number>();
  for(const item of [...person.schools].sort((a,b)=>a.subject.localeCompare(b.subject))){
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`school:${config.project}:${item.subject}`]);
    const {rows:[binding]}=await client.query(`select school,org from directory_schools ds join schools s on s.id=ds.school
      where ds.project=$1 and ds.subject=$2`,[config.project,item.subject]);
    if(binding){
      if(binding.org!==org) throw new DirectoryConflict('Organizacija škole se razlikuje od postojeće veze.');
      memberships.set(item.subject,binding.school);
      continue;
    }
    const {rows:[record]}=await client.query('insert into schools(org,name) values($1,$2) on conflict(org,name) do update set name=excluded.name returning id',[org,item.name]);
    const result=await client.query('insert into directory_schools values($1,$2,$3) on conflict do nothing',[config.project,item.subject,record.id]);
    if(!result.rowCount) throw new DirectoryConflict('Dvije škole imaju isti naziv. Potrebna je provjera naziva u izvoru.');
    memberships.set(item.subject,record.id);
  }
  return person.schools.map(item=>memberships.get(item.subject)!);
}

export async function prepareDirectoryPerson(config:Config,person:DirectoryPerson){
  return transaction(async client=>{
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`identity:${config.project}:${person.subject}`]);
    const {rows:[organization]}=await client.query('insert into organizations(name) values($1) on conflict(name) do update set name=excluded.name returning id',[config.organization]);
    const org=organization.id as number;
    await client.query('insert into domains(name,org) values($1,$2) on conflict do nothing',[config.domain,org]);
    const domain=await client.query('select 1 from domains where name=$1 and org=$2',[config.domain,org]);
    if(!domain.rowCount) throw new DirectoryConflict('Poštanska domena pripada drugoj organizaciji.');
    const {rows:bindings}=await client.query(`select u.* from users u left join directory_identities d on d.uid=u.id
      where (d.project=$1 and d.subject=$2) or (u.source_project=$1 and u.source_user_id=$2)`,[config.project,person.subject]);
    if(bindings.length>1) throw new DirectoryConflict('Izvorni korisnik ima više povezanih računa.');
    const bound=bindings[0];
    const address=bound?.email ?? person.address;
    if(!address.endsWith('@'+config.domain)) throw new DirectoryConflict('Povezani račun pripada drugoj poštanskoj domeni.');
    const addresses=[...new Set([address,...(person.kind==='formapoint'?[person.sourceEmail]:[])])].sort();
    for(const value of addresses) await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[value]);
    const {rows:matches}=await client.query('select * from users where email=any($1::text[]) or source_email=any($1::text[]) for update',[addresses]);
    const existing=matches.find(row=>row.id===bound?.id) ??
      matches.find(row=>!bound && row.email===address && row.auth_kind==='staff' && person.kind==='staff');
    if(matches.some(row=>row.id!==existing?.id) || (existing && (existing.org!==org || existing.auth_kind!==person.kind ||
      existing.role==='root' || !existing.active || (existing.auth_kind==='staff' && !bound && existing.role!=='user')))){
      throw new DirectoryConflict('Adresa je vezana uz drugi ili neaktivan račun.');
    }
    const reserved=await client.query('select 1 from aliases where address=$1 union all select 1 from senders where address=$1',[address]);
    if(reserved.rowCount) throw new DirectoryConflict('Adresa je rezervirana za alias ili automatsko slanje.');
    const memberships=await schoolMemberships(client,config,org,person);
    const mainSchool=memberships[0]??null;
    const sourceEmail=person.kind==='formapoint'?person.sourceEmail:null;
    const external=person.kind!=='staff';
    let uid=existing?.id as number|undefined;
    if(uid===undefined){
      const result=await client.query(`insert into users(org,school,email,name,password,auth_kind,source_project,source_user_id,source_email)
        values($1,$2,$3,$4,null,$5,$6,$7,$8) returning id`,[org,mainSchool,address,person.name,person.kind,
          external?config.project:null,external?person.subject:null,sourceEmail]);
      uid=result.rows[0].id as number;
    }else{
      await client.query('update users set school=$2,source_email=$3 where id=$1',[uid,mainSchool,sourceEmail]);
      if(existing.source_email!==sourceEmail)await client.query('delete from sessions where uid=$1',[uid]);
    }
    const binding=await client.query(`insert into directory_identities values($1,$2,$3)
      on conflict(project,subject) do update set uid=excluded.uid where directory_identities.uid=excluded.uid`,[config.project,person.subject,uid]);
    if(!binding.rowCount) throw new DirectoryConflict('Izvorni korisnik je već povezan.');
    await client.query('delete from directory_school_memberships where uid=$1 and not (school=any($2::int[]))',[uid,memberships]);
    if(memberships.length) await client.query('insert into directory_school_memberships select $1,unnest($2::int[]) on conflict do nothing',[uid,memberships]);

    const {rows:[box]}=await client.query(`select m.id,m.org,m.shared,m.active,d.uid,d.encrypted_password,d.ready
      from mailboxes m left join directory_mailboxes d on d.box=m.id where m.address=$1 for update of m`,[address]);
    if(box){
      if(box.org!==org || box.shared || (box.uid && box.uid!==uid))throw new DirectoryConflict('Sandučić već pripada drugom korisniku ili organizaciji.');
      const grants=await client.query('select uid from grants where box=$1',[box.id]);
      if(grants.rows.some(grant=>grant.uid!==uid)) throw new DirectoryConflict('Sandučić ima postojeću dodjelu drugom korisniku.');
      if(box.encrypted_password){
        if(box.ready && !box.active) throw new DirectoryConflict('Postojeći poštanski sandučić je deaktiviran.');
        return {address,box:box.id as number,uid,pending:!box.ready,secret:String(box.encrypted_password)};
      }
      if(box.active && grants.rowCount===1) return {address,box:box.id as number,uid,pending:false,secret:null};
      throw new DirectoryConflict('Postojeći sandučić nema potvrđenog vlasnika.');
    }
    const {rows:[record]}=await client.query('insert into mailboxes(org,address,label,active) values($1,$2,$3,false) returning id',[org,address,person.name]);
    const secret=sealMailboxPassword(address,randomBytes(32).toString('base64url'));
    await client.query('insert into directory_mailboxes(box,uid,encrypted_password) values($1,$2,$3)',[record.id,uid,secret]);
    return {address,box:record.id as number,uid,pending:true,secret};
  });
}

export function mailcowDirectoryConfig(){
  mailboxKey();
  const url=new URL(process.env.MAILCOW_URL||'');
  const key=process.env.MAILCOW_API_KEY;
  const host=process.env.MAILCOW_MAIL_HOST?.trim();
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || !key || !host || !/^[a-z0-9.-]+$/i.test(host)){
    throw new Error('Potrebni su MAILCOW_URL, MAILCOW_API_KEY i MAILCOW_MAIL_HOST.');
  }
  return {url,key,host};
}

export async function provisionPersonalMailbox(
  config:ReturnType<typeof mailcowDirectoryConfig>,address:string,name:string,password:string,
){
  const [local_part,domain]=address.split('@');
  try{
    const response=await fetch(new URL('/api/v1/add/mailbox',config.url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json','X-API-Key':config.key},body:JSON.stringify({
        local_part,domain,name,active:'1',quota:'15360',password,password2:password,
        force_pw_update:'0',
      })});
    const result:unknown=await response.json();
    if(response.ok && Array.isArray(result) && result.length && result.every(item=>item?.type==='success'))return;
  }catch{
    // A timed-out submission may have created the mailbox. Check with the stored credential before retrying.
  }
  const client=new ImapFlow({host:config.host,port:993,secure:true,auth:{user:address,pass:password},logger:false,
    connectionTimeout:7000,socketTimeout:7000,disableAutoIdle:true});
  try{await client.connect();}
  catch{throw new DirectoryConflict('Mailcow nije potvrdio stvaranje sandučića ili adresa već postoji na poslužitelju.');}
  finally{await client.logout().catch(()=>client.close());}
}

export async function syncDirectoryPerson(
  config:Config,person:DirectoryPerson,provision:(address:string,name:string,password:string)=>Promise<void>,
){
  const plan=await prepareDirectoryPerson(config,person);
  if(plan.pending){
    await provision(plan.address,person.name,openMailboxPassword(plan.address,plan.secret!));
  }
  if(plan.secret){
    await transaction(async client=>{
      const {rows:[box]}=await client.query(`select m.address,m.shared,m.active,d.ready from mailboxes m
        join directory_mailboxes d on d.box=m.id and d.uid=$2
        where m.id=$1 for update of m`,[plan.box,plan.uid]);
      if(!box || box.address!==plan.address || box.shared || (box.ready && !box.active)){
        throw new DirectoryConflict('Dodjela se promijenila tijekom stvaranja sandučića.');
      }
      if(plan.pending){
        await client.query('update directory_mailboxes set ready=true where box=$1',[plan.box]);
        await client.query('update mailboxes set active=true where id=$1',[plan.box]);
      }
      await client.query('insert into grants(uid,box,can_send,can_calendar) values($1,$2,true,false) on conflict(uid,box) do nothing',[plan.uid,plan.box]);
    });
  }
  return plan.pending;
}
