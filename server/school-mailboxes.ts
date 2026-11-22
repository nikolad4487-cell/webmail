import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Express,Router,Request,Response} from 'express';
import express from 'express';
import {z} from 'zod';
import {db,transaction,hashPassword,verifyPassword} from './db.js';
import {HttpError} from './mail.js';
import {user,deny} from './http.js';
import {allocateFormaPointAddress} from './formapoint-addresses.js';
import {requireNativeSetup} from './mailbox-provisioning.js';
import {generateSchoolPassword} from './school-password.js';
import {sealMailboxPassword,openMailboxPassword} from './mailbox-secrets.js';
import {schoolCredentialPdf} from '../shared/school-credential.mjs';
import {schoolIdentityName,malformedSchoolAddress} from './school-identity-name.js';
const school=z.object({id:z.string().min(1).max(200),name:z.string().min(1).max(240),code:z.string().nullish(),address:z.string().nullish(),city:z.string().nullish(),postal_code:z.string().nullish(),year_end:z.string().nullish()});
class SchoolRoleConflict extends HttpError{constructor(readonly uid:number){super(409,'Promjena vrste školskog računa zahtijeva provjeru. Pristup starog računa je zaustavljen.');}}
export const schoolPerson=z.object({subject:z.uuid(),sourceLogin:z.email(),name:z.string().min(1).max(240),kind:z.enum(['student','parent','teacher']),oib:z.string().nullish(),dob:z.string().nullish(),gender:z.string().nullish(),schools:z.array(school).min(1).max(30)});
function config(){
 const project=process.env.EDNEVNIK_SUPABASE_PROJECT_ID,url=process.env.EDNEVNIK_SUPABASE_URL,secret=process.env.SCHOOL_SYNC_TOKEN;
 if(!project||!url||!secret||secret.length<32||project===process.env.FORMAPOINT_SUPABASE_PROJECT_ID)throw new HttpError(503,'Školska sinkronizacija nije konfigurirana.');
 const endpoint=new URL('/functions/v1/webmail-school-bridge',url);
 if(endpoint.protocol!=='https:'&&!(process.env.NODE_ENV==='test'&&endpoint.hostname==='127.0.0.1'))throw new HttpError(503,'Neispravan školski izvor.');
 return {project,endpoint,secret};
}
export async function schoolSource(body:object,token?:string){
 const c=config();let response:globalThis.Response;
 try{response=await fetch(c.endpoint,{method:'POST',headers:{Authorization:'Bearer '+(token||c.secret),'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new HttpError(503,'Školski izvor trenutačno nije dostupan.');}
 if(!response.ok)throw new HttpError([400,401,403,404].includes(response.status)?response.status:503,'Školski postupak nije odobren ili potvrđen.');
 return response.json();
}
export async function syncSchoolPerson(input:unknown,run:string){
 const p=schoolPerson.parse(input),rawName=p.name,cfg=config();p.name=schoolIdentityName(p.name);requireNativeSetup();
 return transaction(async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['identity:'+cfg.project+':'+p.subject]);
  const {rows:[domain]}=await c.query("select org from domains where name='skolehr.xyz' and mailbox_backend='native' and inbound and outbound");
  if(!domain)throw new HttpError(409,'Uključite Cloudflare / Mailjet za skolehr.xyz.');
  const {rows:bindings}=await c.query(`select u.*,s.source_login,s.person_kind,s.disabled_by_sync from users u
    left join school_mail_identities s on s.uid=u.id
    where (s.project=$1 and s.subject=$2) or (u.auth_kind='ednevnik' and u.source_project=$1 and u.source_user_id=$2)`,[cfg.project,p.subject]);
  if(bindings.length>1)throw new HttpError(409,'Izvorni identitet ima više povezanih računa.');
  let bound=bindings[0];
  const kind=p.kind==='teacher'?'staff':'ednevnik';
  if(!bound&&kind==='staff'&&p.sourceLogin.endsWith('@skolehr.xyz')){const {rows:[legacy]}=await c.query("select u.* from users u where u.email=$1 and u.auth_kind='staff' and u.role='user' and not exists(select 1 from directory_identities d where d.uid=u.id)",[p.sourceLogin]);if(legacy)bound=legacy;}
  if(bound&&bound.role!=='root'&&bound.auth_kind!==kind)throw new SchoolRoleConflict(bound.id);
  if(bound&&(bound.org!==domain.org||bound.auth_kind!==kind||bound.role==='root'||!bound.active&&!bound.disabled_by_sync))throw new HttpError(409,'Postojeći račun zahtijeva administratorsku provjeru.');
  let address=bound?.email??await allocateFormaPointAddress(c,'skolehr.xyz',p.sourceLogin,p.subject,p.name,{preserveSourceAddress:false});
  if(bound&&malformedSchoolAddress(bound.email,rawName)){
   const {rows:[owned]}=await c.query('select * from mailboxes where address=$1 for update',[bound.email]);
   if(!owned||owned.org!==bound.org||owned.shared||owned.storage_kind!=='native'||
    !(await c.query('select 1 from grants where box=$1 and uid=$2',[owned.id,bound.id])).rowCount||
    (await c.query('select 1 from grants where box=$1 and uid<>$2',[owned.id,bound.id])).rowCount||
    (await c.query('select 1 from senders where address=$1 or reply_to=$1',[bound.email])).rowCount)throw new HttpError(409,'Oznaku postojećeg sandučića mora provjeriti administrator.');
   address=await allocateFormaPointAddress(c,'skolehr.xyz',p.sourceLogin,p.subject,p.name,{preserveSourceAddress:false});
   const {rows:[initial]}=await c.query('select initial_password from school_mail_identities where uid=$1',[bound.id]);
   if(initial?.initial_password)await c.query('update school_mail_identities set initial_password=$2 where uid=$1',[bound.id,sealMailboxPassword(address,openMailboxPassword(bound.email,initial.initial_password))]);
   const {rows:[legacy]}=await c.query('select encrypted_password from directory_mailboxes where uid=$1',[bound.id]);
   if(legacy)await c.query('update directory_mailboxes set encrypted_password=$2 where uid=$1',[bound.id,sealMailboxPassword(address,openMailboxPassword(bound.email,legacy.encrypted_password))]);
   await c.query('update users set email=$2 where id=$1',[bound.id,address]);
   await c.query('update mailboxes set address=$2,label=$3 where id=$1',[owned.id,address,p.name]);
   await c.query('delete from sessions where uid=$1',[bound.id]);
   await c.query("insert into audits(uid,action,target) values($1,'school.identity.label.repair',$2)",[bound.id,address]);
   bound.email=address;
  }
  const memberships=[];
  for(const s of p.schools){
   const old=(await c.query('select school from directory_schools where project=$1 and subject=$2',[cfg.project,s.id])).rows[0];
   let id=old?.school;
   if(!id){
    id=(await c.query('insert into schools(org,name) values($1,$2) on conflict(org,name) do update set name=excluded.name returning id',[domain.org,s.name])).rows[0].id;
    if((await c.query('select 1 from directory_schools where school=$1',[id])).rowCount)throw new HttpError(409,'Naziv škole već je vezan uz drugi izvor.');
    await c.query('insert into directory_schools values($1,$2,$3)',[cfg.project,s.id,id]);
   }
   memberships.push(id);
  }
  let uid=bound?.id,password:string|undefined;
  if(!uid){
   password=kind==='staff'?generateSchoolPassword():undefined;
   uid=(await c.query(`insert into users(org,school,email,name,password,auth_kind,source_project,source_user_id)
    values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,[domain.org,memberships[0],address,p.name,password?await hashPassword(password):null,kind,kind==='ednevnik'?cfg.project:null,kind==='ednevnik'?p.subject:null])).rows[0].id;
  }else{
   await c.query('update users set name=$2,school=$3,active=case when $4 then true else active end where id=$1',[uid,p.name,memberships[0],!!bound.disabled_by_sync]);
   if(bound.source_login&&bound.source_login!==p.sourceLogin)await c.query('delete from sessions where uid=$1',[uid]);
  }
  await c.query('insert into directory_identities values($1,$2,$3) on conflict(project,subject) do nothing',[cfg.project,p.subject,uid]);
  await c.query('delete from directory_school_memberships where uid=$1',[uid]);
  await c.query('insert into directory_school_memberships select $1,unnest($2::int[]) on conflict do nothing',[uid,memberships]);
  let box=(await c.query('select * from mailboxes where address=$1 for update',[address])).rows[0];
  if(box){
   if(box.org!==domain.org||box.shared||!box.active&&!bound?.disabled_by_sync||box.storage_kind!=='native'||(await c.query('select 1 from grants where box=$1 and uid<>$2',[box.id,uid])).rowCount)throw new HttpError(409,'Postojeći sandučić nije potvrđen osobni native sandučić.');
   if(bound?.disabled_by_sync)await c.query('update mailboxes set active=true where id=$1',[box.id]);
   if(schoolIdentityName(rawName)!==rawName||schoolIdentityName(box.label)!==box.label||malformedSchoolAddress(box.label,rawName))await c.query('update mailboxes set label=$2 where id=$1',[box.id,p.name]);
  }else box=(await c.query("insert into mailboxes(org,address,label,storage_kind) values($1,$2,$3,'native') returning *",[domain.org,address,p.name])).rows[0];
  await c.query('insert into grants values($1,$2,true,true) on conflict(uid,box) do nothing',[uid,box.id]);
  const end=p.schools.map(s=>s.year_end).filter((v):v is string=>!!v&&/^\d{4}-\d{2}-\d{2}$/.test(v)).sort().at(-1);
  const until=end?end.slice(0,4)+'-10-31':null;
  await c.query(`insert into school_mail_identities(uid,project,subject,source_login,person_kind,oib,dob,gender,valid_until,school_data,seen_run)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(uid) do update set source_login=excluded.source_login,
   person_kind=excluded.person_kind,oib=excluded.oib,dob=excluded.dob,gender=excluded.gender,valid_until=excluded.valid_until,
   school_data=excluded.school_data,seen_run=excluded.seen_run,last_synced_at=now(),disabled_by_sync=false`,[uid,cfg.project,p.subject,p.sourceLogin,p.kind,p.oib||null,p.dob||null,p.gender||null,until,p.schools[0],run]);
  if(password)await c.query('update school_mail_identities set initial_password=$2,issued_at=now() where uid=$1',[uid,sealMailboxPassword(address,password)]);
  await c.query("insert into audits(action,target) values('school.mailbox.sync',$1)",[String(uid)]);
  return {uid,address,created:!bound};
 }).catch(async error=>{
  if(error instanceof SchoolRoleConflict)await transaction(async c=>{
   await c.query('update users set active=false where id=$1 and role<>$2',[error.uid,'root']);
   await c.query('delete from sessions where uid=$1',[error.uid]);
   await c.query('update school_mail_identities set initial_password=null,disabled_by_sync=false where uid=$1',[error.uid]);
   await c.query("insert into audits(action,target) values('school.role.review',$1)",[String(error.uid)]);
  });
  throw error;
 });
}
export async function syncSchools(){
 const guard=await db.connect();
 const locked=(await guard.query("select pg_try_advisory_lock(hashtext('webmailhr.school.sync.job')) locked")).rows[0].locked;
 if(!locked){guard.release();throw new HttpError(409,'Sinkronizacija je već u tijeku.');}
 try{return await runSchoolSync();}finally{await guard.query("select pg_advisory_unlock(hashtext('webmailhr.school.sync.job'))");guard.release();}
}
async function runSchoolSync(){
 const cfg=config();
 await db.query("update school_mail_identities set initial_password=null where issued_at<now()-interval '7 days'");
 const state=await transaction(async c=>{
  await c.query("select pg_advisory_xact_lock(hashtext('webmailhr.school.sync'))");
  return (await c.query(`insert into school_mail_sync_state(project,page,run) values($1,0,$2) on conflict(project) do update set updated_at=now() returning *`,[cfg.project,randomUUID()])).rows[0];
 });
 const data=await schoolSource({action:'roster',page:state.page});
 if(data.project!==cfg.project||!Array.isArray(data.people)||data.people.length>30||data.nextPage!==null&&data.nextPage!==state.page+1)throw new HttpError(503,'Školski izvor nije vratio očekivanu stranicu.');
 let created=0,existing=0,conflicts=0;
 const conflictDetails:Array<{subject:string;reason:string}>=[];
 for(const person of data.people){try{const r=await syncSchoolPerson(person,state.run);if(r.created)created++;else existing++;}catch(error){if(error instanceof HttpError&&error.status===409){conflicts++;conflictDetails.push({subject:person.subject,reason:error.message});}else throw error;}}
 await transaction(async c=>{
  if(data.nextPage===null){
   // Do not prune on partial/conflicting snapshots. Only imported identities are managed.
   if(!conflicts&&!state.conflicts){
    await c.query(`delete from sessions where uid in(select uid from school_mail_identities where project=$1 and last_synced_at<$2::timestamptz)`,[cfg.project,state.started_at]);
    await c.query(`update school_mail_identities s set disabled_by_sync=true from users u where s.uid=u.id and s.project=$1 and s.last_synced_at<$2::timestamptz and u.active and u.role<>'root'`,[cfg.project,state.started_at]);
    await c.query('update users set active=false where id in(select uid from school_mail_identities where project=$1 and disabled_by_sync)',[cfg.project]);
    await c.query(`update mailboxes m set active=false from users u join school_mail_identities s on s.uid=u.id where m.address=u.email and s.project=$1 and s.disabled_by_sync`,[cfg.project]);
   }
   await c.query('delete from school_mail_sync_state where project=$1',[cfg.project]);
  }else await c.query('update school_mail_sync_state set page=$2,conflicts=conflicts+$4 where project=$1 and page=$3',[cfg.project,data.nextPage,state.page,conflicts]);
 });
 return {created,existing,conflicts,conflictDetails,hasMore:data.nextPage!==null};
}
const fonts=()=>Promise.all([readFile(new URL('../assets/fonts/NotoSans-Regular.ttf',import.meta.url)),readFile(new URL('../assets/fonts/NotoSans-Bold.ttf',import.meta.url))]);
export async function credentialPdf(data:Record<string,unknown>){const [regular,bold]=await fonts();return Buffer.from(await schoolCredentialPdf({...data,...(typeof data.name==='string'?{name:schoolIdentityName(data.name)}:{})},{regular,bold}));}
function pdfResponse(res:Response,bytes:Buffer){res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="skolehr-podaci-za-prijavu.pdf"','Cache-Control':'no-store'}).send(bytes);}
export function setupSchoolAdmin(api:Router){
 api.post('/admin/users/:id/student-password',async(req,res)=>{
  const actor=user(req),uid=z.coerce.number().int().positive().parse(req.params.id);
  const {rows:[u]}=await db.query(`select u.*,si.project,si.subject,ds.subject as source_school,si.source_login
   from users u join school_mail_identities si on si.uid=u.id
   join directory_schools ds on ds.school=u.school and ds.project=si.project
   join directory_school_memberships sm on sm.uid=u.id and sm.school=u.school
   where u.id=$1 and u.active and u.auth_kind='ednevnik' and si.person_kind='student' and not si.disabled_by_sync`,[uid]);
  if(!u||u.role!=='user'||actor.role!=='root'&&(actor.role!=='admin'||actor.org!==u.org||actor.school&&actor.school!==u.school))return deny();
  if(u.project!==process.env.EDNEVNIK_SUPABASE_PROJECT_ID||u.subject!==u.source_user_id)return deny();
  await transaction(async c=>{
   const {rows:[current]}=await c.query('select * from users where id=$1 and active for update',[uid]);
   if(!current||current.org!==u.org||current.school!==u.school||current.source_user_id!==u.subject||current.source_project!==u.project||current.auth_kind!=='ednevnik'||current.role!=='user')return deny();
   const source=await schoolSource({action:'webmail-issue-student-password',subject:u.subject,schoolId:u.source_school});
   const password=source.credential?.password;
   if(source.credential?.subject!==u.subject||typeof password!=='string')throw new HttpError(503,'Nova lozinka nije potvrđena.');
   await c.query('delete from sessions where uid=$1',[uid]);await c.query('delete from resets where uid=$1',[uid]);
   await c.query('update school_mail_identities set initial_password=null where uid=$1',[uid]);
   await c.query("insert into audits(uid,action,target) values($1,'school.student.password.issue',$2)",[actor.id,String(uid)]);
   res.locals.issued=password;
  });
  res.set('Cache-Control','no-store').json({password:res.locals.issued});
 });
 api.post('/admin/schools/sync',async(req,res)=>{if(user(req).role!=='root')return deny();res.json(await syncSchools());});
 const download=async(req:import('express').Request,res:Response)=>{
  const actor=user(req),uid=z.coerce.number().int().positive().parse(req.params.id);
  const {rows:[u]}=await db.query(`select u.*,s.person_kind,s.source_login,s.oib,s.dob::text,s.gender,s.valid_until::text,s.school_data,s.initial_password,s.issued_at
   from users u left join school_mail_identities s on s.uid=u.id where u.id=$1 and u.active`,[uid]);
  if(!u||actor.role!=='root'&&(actor.role!=='admin'||u.org!==actor.org||u.role!=='user'||actor.school&&u.school!==actor.school))return deny();
  if(!u.email.endsWith('@skolehr.xyz')||!['staff','ednevnik'].includes(u.auth_kind))throw new HttpError(409,'Ovo nije školski mail račun.');
  let password;
  if(req.method==='POST'){const input=z.object({password:z.string().min(8).max(512)}).strict().parse(req.body);if(u.auth_kind==='staff'){if(!await verifyPassword(input.password,u.password))return deny();}else{const confirmed=await schoolSource({action:'family-login',username:u.source_login||u.email,password:input.password});if(confirmed.user_id!==u.source_user_id)return deny();}password=input.password;}
  if(!password)throw new HttpError(409,'PDF s lozinkom preuzmite tijekom izdavanja nove lozinke.');
  const bytes=await credentialPdf({name:u.name,address:u.email,kind:u.auth_kind==='staff'?'teacher':u.person_kind||'student',oib:u.oib,dob:u.dob,gender:u.gender,validUntil:u.valid_until,school:u.school_data,password});
  await db.query("insert into audits(uid,action,target) values($1,'school.credentials.pdf',$2)",[actor.id,String(uid)]);pdfResponse(res,bytes);
 };
 api.get('/admin/users/:id/credentials.pdf',download);api.post('/admin/users/:id/credentials.pdf',download);
}
export function setupSchoolEndpoints(app:Express,allowedHost:(host:string)=>boolean){
 const origins=['https://ematica.skolehr.xyz','https://e-matica.skolehr.xyz','https://matica.skolehr.xyz'];
 const path='/api/integrations/schools/student-password.pdf';
 app.options(path,(req,res)=>{const origin=req.get('origin');if(!origin||!origins.includes(origin))return res.sendStatus(403);res.set({'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'}).sendStatus(204);});
 app.post(path,(req,res,next)=>{
  if(!allowedHost(req.get('host')?.toLowerCase()||''))return deny();
  const origin=req.get('origin');if(origin&&!origins.includes(origin))return deny();
  if(origin)res.set({'Access-Control-Allow-Origin':origin,'Vary':'Origin'});res.set('Cache-Control','no-store');next();
 },express.json({limit:4096}),async(req,res)=>{
  const token=req.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];if(!token||token.length>8192)throw new HttpError(401,'Prijavite se.');
  const body=z.object({profileId:z.uuid(),schoolId:z.string().min(1).max(200)}).strict().parse(req.body);
  const details=await schoolSource({action:'student-details',...body},token);
  const record=await syncSchoolPerson(details.person,'manual-'+randomUUID());
  const gate=await db.connect();const lock=(await gate.query('select pg_try_advisory_lock(hashtextextended($1,0)) locked',['student-password:'+details.person.subject])).rows[0].locked;
  if(!lock){gate.release();throw new HttpError(409,'Lozinka se ovom učeniku upravo izdaje.');}
  try{
  const source=await schoolSource({action:'issue-student-password',...body},token);
  if(source.credential?.subject!==details.person.subject||typeof source.credential.password!=='string')throw new HttpError(503,'Nova lozinka nije potvrđena.');
  const {rows:[u]}=await db.query('select *,dob::text,valid_until::text from school_mail_identities where uid=$1',[record.uid]);
  await db.query('delete from sessions where uid=$1',[record.uid]);
  const bytes=await credentialPdf({name:details.person.name,address:record.address,kind:'student',password:source.credential.password,oib:u.oib,dob:u.dob,gender:u.gender,validUntil:u.valid_until,school:u.school_data});
  await db.query("insert into audits(action,target) values('school.student.password.issue',$1)",[String(record.uid)]);pdfResponse(res,bytes);
  }finally{await gate.query('select pg_advisory_unlock(hashtextextended($1,0))',['student-password:'+details.person.subject]);gate.release();}
 });
 app.get('/api/integrations/schools/sync',async(req,res)=>{
  if(!allowedHost(req.get('host')?.toLowerCase()||'')||req.get('origin'))return deny();
  const secret=process.env.CRON_SECRET;if(!secret||req.get('authorization')!=='Bearer '+secret)throw new HttpError(401,'Neispravan servisni zahtjev.');
  if(req.query.inspectNames==='1'){
   const {rows}=await db.query(`select u.id,u.name,u.email,u.auth_kind,u.active,s.subject,
    m.id as box,m.address as mailbox_address,m.label as mailbox_label,m.storage_kind
    from users u left join school_mail_identities s on s.uid=u.id
    left join mailboxes m on m.address=u.email and m.org=u.org order by u.id`);
   res.set('Cache-Control','no-store');return res.json({users:rows});
  }
  if(req.query.subject!==undefined){
   const subject=z.uuid().parse(req.query.subject);
   const data=await schoolSource({action:'roster-person',subject});
   if(data.project!==config().project||!Array.isArray(data.people)||data.people.length!==1||data.people[0]?.subject!==subject)throw new HttpError(404,'Školski identitet nije potvrđen.');
   return res.json(await syncSchoolPerson(data.people[0],randomUUID()));
  }
  res.json(await syncSchools());
 });
}
