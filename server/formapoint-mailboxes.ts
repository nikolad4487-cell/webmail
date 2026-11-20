import express,{type Express} from 'express';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {transaction} from './db.js';
import {HttpError} from './mail.js';
import {email} from './http.js';
import {personAddress} from './directory-source.js';
import {requireNativeSetup} from './mailbox-provisioning.js';

const person=z.object({id:z.uuid(),email,name:z.string().trim().min(1).max(240),confirmed:z.literal(true),anonymous:z.literal(false)}).strict();
const input=z.object({project:z.string().min(1).max(200),setup:z.boolean().default(false),users:z.array(person).max(10)}).strict();
function config(){
  const project=process.env.FORMAPOINT_SUPABASE_PROJECT_ID?.trim();
  const domain=(process.env.FORMAPOINT_MAIL_DOMAIN||'formapoint.online').trim().toLowerCase();
  if(!project||project===process.env.EDNEVNIK_SUPABASE_PROJECT_ID?.trim()||!email.safeParse('user@'+domain).success)throw new HttpError(503,'FormaPoint veza nije konfigurirana.');
  return {project,domain,organization:process.env.FORMAPOINT_DIRECTORY_ORG?.trim()||'FormaPoint'};
}
async function setupDomain(){
  const c=config();requireNativeSetup();
  await transaction(async client=>{
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['formapoint-domain:'+c.domain]);
    const {rows:[existing]}=await client.query('select org,mailbox_backend from domains where name=$1 for update',[c.domain]);
    if(existing){
      if(existing.mailbox_backend==='native')return;
      await client.query("update domains set mailbox_backend='native' where name=$1",[c.domain]);
    }else{
      const {rows:[org]}=await client.query('insert into organizations(name) values($1) on conflict(name) do update set name=excluded.name returning id',[c.organization]);
      await client.query("insert into domains(name,org,mailbox_backend) values($1,$2,'native')",[c.domain,org.id]);
    }
    await client.query("insert into audits(action,target) values('formapoint.domain.enable',$1)",[c.domain]);
  });
}
async function syncPerson(p:z.infer<typeof person>){
  const cfg=config();requireNativeSetup();
  return transaction(async c=>{
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`identity:${cfg.project}:${p.id}`]);
    const {rows:[domain]}=await c.query("select org from domains where name=$1 and mailbox_backend='native' and inbound and outbound",[cfg.domain]);
    if(!domain)throw new HttpError(409,'Omogućite Cloudflare / Mailjet za FormaPoint domenu.');
    const {rows:bound}=await c.query(`select u.* from users u left join directory_identities d on d.uid=u.id
      where (u.auth_kind='formapoint' and u.source_project=$1 and u.source_user_id=$2) or (d.project=$1 and d.subject=$2)`,[cfg.project,p.id]);
    if(bound.length>1)throw new HttpError(409,'Izvorni račun ima više povezanih identiteta.');
    let u=bound[0];
    const address=u?.email??personAddress('formapoint',cfg.domain,p.email,p.id)!;
    if(!address.endsWith('@'+cfg.domain))throw new HttpError(409,'Postojeća adresa pripada drugoj domeni.');
    for(const value of [...new Set([address,p.email])].sort())await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[value]);
    const {rows:matches}=await c.query('select * from users where email=any($1::text[]) or source_email=any($1::text[]) for update',[[address,p.email]]);
    if(!u)u=matches.find(x=>x.email===address&&x.auth_kind==='formapoint'&&!x.source_user_id);
    if(matches.some(x=>x.id!==u?.id)||u&&(u.org!==domain.org||u.auth_kind!=='formapoint'||u.role==='root'||!u.active||
      u.source_user_id&&(u.source_user_id!==p.id||u.source_project!==cfg.project))){
      throw new HttpError(409,'Adresa je vezana uz drugi ili neaktivan račun.');
    }
    if((await c.query('select 1 from aliases where address=$1 union all select 1 from senders where address=$1',[address])).rowCount)throw new HttpError(409,'Adresa je rezervirana.');
    if(!u){
      u=(await c.query(`insert into users(org,email,name,password,auth_kind,source_project,source_user_id,source_email)
        values($1,$2,$3,null,'formapoint',$4,$5,$6) returning *`,[domain.org,address,p.name,cfg.project,p.id,p.email])).rows[0];
    }else{
      await c.query('update users set name=$2,source_project=$3,source_user_id=$4,source_email=$5 where id=$1',[u.id,p.name,cfg.project,p.id,p.email]);
      if(u.source_email!==p.email)await c.query('delete from sessions where uid=$1',[u.id]);
    }
    await c.query('insert into directory_identities values($1,$2,$3) on conflict(project,subject) do nothing',[cfg.project,p.id,u.id]);
    const {rows:[box]}=await c.query('select * from mailboxes where address=$1 for update',[address]);
    if(box){
      if(box.org!==domain.org||box.shared||!box.active)throw new HttpError(409,'Postojeći sandučić nije aktivan osobni sandučić vlasnika.');
      const grants=await c.query('select uid from grants where box=$1',[box.id]);
      if(grants.rows.some(x=>x.uid!==u.id))throw new HttpError(409,'Sandučić je dodijeljen drugom korisniku.');
      if(box.storage_kind!=='native')return {sourceId:p.id,address,status:'needs_activation'};
      await c.query('insert into grants(uid,box,can_send,can_calendar) values($1,$2,true,true) on conflict(uid,box) do nothing',[u.id,box.id]);
      return {sourceId:p.id,address,status:'existing'};
    }
    const {rows:[created]}=await c.query("insert into mailboxes(org,address,label,storage_kind) values($1,$2,$3,'native') returning id",[domain.org,address,p.name]);
    await c.query('insert into grants(uid,box,can_send,can_calendar) values($1,$2,true,true)',[u.id,created.id]);
    await c.query("insert into audits(action,target) values('formapoint.mailbox.create',$1)",[String(created.id)]);
    return {sourceId:p.id,address,status:'created'};
  });
}
export function setupFormaPointMailboxes(app:Express,allowedHost:(host:string)=>boolean){
  app.post('/api/integrations/formapoint/provision',(req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!allowedHost(req.get('host')?.toLowerCase()||'')||req.get('origin'))throw new HttpError(403,'Zahtjev nije dopušten.');
    const secret=process.env.FORMAPOINT_PROVISION_SECRET?.trim();
    if(process.env.FORMAPOINT_AUTO_MAILBOXES!=='1'||!secret||secret.length<32)throw new HttpError(503,'FormaPoint sandučići nisu uključeni.');
    const timestamp=req.get('x-webmail-sync-timestamp')||'',hash=req.get('x-webmail-sync-hash')||'',signature=req.get('x-webmail-sync-signature')||'';
    if(!/^\d{13}$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp))>300000||! /^[a-f0-9]{64}$/.test(hash)||! /^[a-f0-9]{64}$/.test(signature))throw new HttpError(401,'Neispravan potpis.');
    const expected=createHmac('sha256',secret).update(timestamp+'\n'+hash).digest();
    if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw new HttpError(401,'Neispravan potpis.');
    next();
  },express.raw({type:()=>true,limit:64000}),async(req,res)=>{
    if(!Buffer.isBuffer(req.body)||createHash('sha256').update(req.body).digest('hex')!==req.get('x-webmail-sync-hash'))throw new HttpError(401,'Neispravan sadržaj.');
    let body:unknown;try{body=JSON.parse(req.body.toString());}catch{throw new HttpError(400,'Neispravan JSON.');}
    const data=input.parse(body),cfg=config();
    if(data.project!==cfg.project)throw new HttpError(403,'Pogrešan izvorni projekt.');
    if(data.setup)await setupDomain();
    const results=[];
    for(const p of data.users){
      try{results.push(await syncPerson(p));}
      catch(error){if(error instanceof HttpError&&error.status===409)results.push({sourceId:p.id,status:'conflict',reason:error.message});else throw error;}
    }
    res.json({ok:true,results});
  });
}
