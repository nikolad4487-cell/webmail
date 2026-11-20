import {matchesPassword,newPassword,sharedPassword,verifyCurrentPassword} from './passwords.js';
import {setupInbound} from './inbound.js';
import {isNative,changeNative,MAX_NATIVE_BYTES} from './native-mail.js';
import {invalidLogin,verifyFormaPoint,verifyStudent,isLinkedFormaPoint,changeFormaPointPassword} from './identity.js';
import express, {type Request,type Response} from 'express';
import {z, ZodError} from 'zod';
import {checkLoginDatabase,db,digest,hashPassword,loginDatabaseIssue,token,transaction,verifyPassword,type LoginDatabaseIssue} from './db.js';
import {addressing,append,archiveDraft,demo,folder,HttpError,imap,listing,message,mime,quotaFor,smtp,type Outgoing} from './mail.js';
import {email,id,user,deny} from './http.js';
import {setupData} from './workspace.js';
import {setupAutomation} from './automation.js';
import {setupFormaPointMailboxes} from './formapoint-mailboxes.js';

const app=express(), api=express.Router(), production=process.env.NODE_ENV==='production';
const configuredPublicOrigin=process.env.APP_ORIGIN?.trim() || (production?'https://webmailhr.com':'');
const publicUrl=configuredPublicOrigin ? new URL(configuredPublicOrigin) : undefined;
const origin=publicUrl?.origin || '';
const configuredAdminOrigin=process.env.ADMIN_ORIGIN?.trim() || (production?'https://admin.webmailhr.com':'');
const adminUrl=configuredAdminOrigin ? new URL(configuredAdminOrigin) : undefined;
const adminOrigin=adminUrl?.origin || '';
const adminHost=adminUrl?.host || '';
const publicHosts=new Map<string,string>();
if(publicUrl) publicHosts.set(publicUrl.host,publicUrl.origin);
if(production || publicUrl?.hostname==='webmailhr.com' || publicUrl?.hostname==='www.webmailhr.com'){
  publicHosts.set('webmailhr.com','https://webmailhr.com');
  publicHosts.set('www.webmailhr.com','https://www.webmailhr.com');
}
const requestHost=(req:Request)=>req.get('host')?.toLowerCase() || '';
const isAdminSite=(req:Request)=>!!adminHost && requestHost(req)===adminHost;
function currentOrigin(req:Request){
  if(isAdminSite(req)) return adminOrigin;
  const host=requestHost(req);
  return publicHosts.get(host) || (!production && !origin && host ? `${req.protocol}://${host}` : undefined);
}
if(adminOrigin) app.get('/admin/prijava',(_req,res)=>res.redirect(302,adminOrigin+'/'));
app.disable('x-powered-by');
if (process.env.TRUST_PROXY==='1') app.set('trust proxy',1);
app.use((_req,res,next)=>{
  if(production) res.set('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});
  next();
});
setupInbound(app,host=>publicHosts.has(host)||(!production&&!origin&&host.startsWith('127.0.0.1:')));
setupFormaPointMailboxes(app,host=>publicHosts.has(host)||(!production&&!origin&&host.startsWith('127.0.0.1:')));
app.use('/api',express.json({limit:'17mb'}),(_req,res,next)=>{res.set('Cache-Control','no-store');next();},api);
api.use((req,_res,next)=>{
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.get('origin')) {
    const expected=currentOrigin(req);
    if (req.get('origin')!==expected) throw new HttpError(403,'Zahtjev nije dopušten.');
  }
  next();
});
const cookie='wm_session';
const cookieOptions={httpOnly:true,sameSite:'lax' as const,secure:production,path:'/'};
const session=(req:Request)=>req.headers.cookie?.match(/(?:^|;\s*)wm_session=([a-f0-9]{64})(?:;|$)/)?.[1];
const fallback=hashPassword(token());
async function limit(key:string, max:number) {
  const {rows}=await db.query(`insert into login_limits values($1,1,now()+interval '15 minutes')
    on conflict(key) do update set count=case when login_limits.expires<now() then 1 else login_limits.count+1 end,
    expires=case when login_limits.expires<now() then excluded.expires else login_limits.expires end returning count`,[digest(key)]);
  if(rows[0].count>max) throw new HttpError(429,'Previše pokušaja. Pokušajte ponovno za 15 minuta.');
}
api.get('/login-settings',(req,res)=>res.json({demo,adminSite:isAdminSite(req),adminUrl:adminOrigin,publicUrl:origin}));
class DatabaseUnavailable extends HttpError {
  constructor(public code:LoginDatabaseIssue){
    super(503,{
      DB_CONFIG:'Provjerite serversku postavku DATABASE_URL za WebmailHR.',
      DB_SCHEMA:'Baza WebmailHR-a čeka migracije. Pokrenite npm run migrate na produkcijskoj bazi.',
      DB_PERMISSION:'WebmailHR nema potrebne ovlasti za prijavu u PostgreSQL bazi.',
      DB_CONNECTION:'WebmailHR trenutačno ne može uspostaviti vezu s PostgreSQL bazom.',
    }[code]);
  }
}
api.use((_req,_res,next)=>{
  if(!process.env.DATABASE_URL?.trim()) throw new DatabaseUnavailable('DB_CONFIG');
  next();
});
api.get('/health',async (_req,res)=>{
  let hasPermissions:boolean;
  try{hasPermissions=await checkLoginDatabase();}
  catch(error){throw new DatabaseUnavailable(loginDatabaseIssue(error) ?? 'DB_CONNECTION');}
  if(!hasPermissions) throw new DatabaseUnavailable('DB_PERMISSION');
  res.json({ok:true,demo});
});
const localAccount = "(role='root' or ($2::boolean and right(email,5)='.test'))";
const studentBox = "(u.auth_kind<>'ednevnik' or (m.address=u.email and not m.shared and (right(u.email,12)='@skolehr.xyz' or ($2::boolean and right(u.email,13)='@skolehr.test'))))";
const studentDomains=new Set((process.env.EDNEVNIK_LOGIN_DOMAINS || 'skolehr.xyz,eskole.me')
  .split(',').map(domain=>domain.trim().toLowerCase()).filter(Boolean));
if(demo)studentDomains.add('skolehr.test');
const noMailbox=()=>new HttpError(403,'Prijava je uspjela. Administrator treba dodijeliti pristup sandučiću.');
async function signIn(req:Request,res:Response,adminLogin=false){
  const input=z.object({identifier:z.string().trim().min(1).max(254),password:z.string().min(1).max(512),
    remember:z.boolean().optional()}).strict().parse(req.body);
  const {identifier,password}=input;
  const address=email.safeParse(identifier);
  const loginName=address.success?address.data:identifier;
  if(!address.success && (adminLogin || identifier.includes('@'))) throw invalidLogin();
  const rateKey='login:'+(adminLogin?'admin:':'')+loginName.toLowerCase();
  await limit('ip:'+req.ip,80);
  const {rows:matches}=address.success ? await db.query(
    'select id,email,auth_kind,password,password_scheme,role,active,source_project,source_user_id,source_email from users where email=$1 or source_email=$1',
    [address.data]) : {rows:[]};
  const linked=matches.length===1 && matches[0].active ? matches[0] : undefined;
  const studentIdentifier=!address.success || studentDomains.has(address.data.split('@').at(-1)!);
  const kind=adminLogin?'local':linked?.auth_kind ?? (matches.length===0 && studentIdentifier?'ednevnik':undefined);
  await limit(rateKey,kind==='staff'?6:12);
  if(!kind || (adminLogin && password.length<8)) throw invalidLogin();

  let verifiedId:number, checkedHash:string|null=null;
  let source:{projectId:string;userId:string}|undefined;
  let checkedSourceEmail:string|null=null;
  if(kind==='ednevnik'){
    source=await verifyStudent(loginName,password);
    const {rows:[account]}=await db.query('select id from users where auth_kind=$1 and source_project=$2 and source_user_id=$3 and active',
      [kind,source.projectId,source.userId]);
    if(linked && account?.id!==linked.id) throw invalidLogin();
    if(!account) throw noMailbox();
    verifiedId=account.id;
  }else if(linked&&isLinkedFormaPoint(linked)){
    if(!linked?.source_email) throw invalidLogin();
    checkedSourceEmail=linked.source_email;
    source=await verifyFormaPoint(linked.source_email,password,{projectId:linked.source_project,userId:linked.source_user_id});
    checkedHash=linked.password;
    verifiedId=linked.id;
  }else{
    const allowed=linked && linked.auth_kind===kind && (
      kind==='staff' || (!adminLogin&&kind==='formapoint') || (adminLogin && linked.role==='root' && linked.email===loginName) ||
      (demo && linked.email.endsWith('.test') && ((adminLogin && !adminOrigin) || (!adminLogin && linked.role!=='root'))));
    const matches=allowed&&linked.password ? await matchesPassword(linked,password) : await verifyPassword(password,await fallback);
    if(!matches || !allowed || !linked.password) throw invalidLogin();
    verifiedId=linked.id;checkedHash=linked.password;
  }
  const key=token(), lifetime=(input.remember?30:1)*86400000;
  await transaction(async client=>{
    const {rows:[account]}=await client.query('select role,password,password_scheme,source_project,source_user_id,source_email from users where id=$1 and auth_kind=$2 and active for update',[verifiedId,kind]);
    if(!account || (adminOrigin && adminLogin && account.role!=='root') || account.password!==checkedHash || (checkedHash&&account.password_scheme!==linked?.password_scheme) || (source && (account.source_project!==source.projectId || account.source_user_id!==source.userId || account.source_email!==checkedSourceEmail))) throw invalidLogin();
    if(source && !(await client.query(`select 1 from grants g join mailboxes m on m.id=g.box join users u on u.id=g.uid
      where u.id=$1 and m.active and ${studentBox} limit 1`,[verifiedId,demo])).rowCount) throw noMailbox();
    await client.query('delete from login_limits where key=$1',[digest(rateKey)]);
    await client.query('insert into sessions values($1,$2,$3)',[digest(key),verifiedId,new Date(Date.now()+lifetime)]);
  });
  res.cookie(cookie,key,{...cookieOptions,...(input.remember?{maxAge:lifetime}:{})}).json({ok:true});
}
async function startSession(req:Request,res:Response,adminLogin=false){
  try{return await signIn(req,res,adminLogin);}
  catch(error){
    const issue=loginDatabaseIssue(error);
    if(issue) throw new DatabaseUnavailable(issue);
    throw error;
  }
}
api.post('/login',(req,res)=>{
  if(isAdminSite(req)) return deny();
  return startSession(req,res);
});
api.post('/auth/admin-login',(req,res)=>{
  if(adminOrigin && !isAdminSite(req)) return deny();
  return startSession(req,res,true);
});
api.post('/recover',async (req,res)=>{
  if(adminOrigin && !isAdminSite(req)) return deny();
  const address=email.parse(req.body.email);
  await limit('recovery:'+req.ip,8);
  const {rows:[account]}=await db.query("select id,recovery from users where email=$1 and active and recovery is not null and auth_kind='local' and "+localAccount,[address,demo]);
  const from=process.env.RECOVERY_SENDER;
  const resetOrigin=isAdminSite(req)?adminOrigin:origin;
  if(account && from && resetOrigin) {
    const key=token();
    await db.query("insert into resets values($1,$2,now()+interval '30 minutes')",[digest(key),account.id]);
    const mail={from,to:[account.recovery],subject:'Ponovno postavljanje lozinke',text:resetOrigin+'/?reset='+key};
    try { await smtp(from,mail,await mime(mail)); } catch { console.error('Predaja poruke za oporavak nije uspjela.'); }
  }
  res.json({ok:true});
});
api.post('/reset',async (req,res)=>{
  if(adminOrigin && !isAdminSite(req)) return deny();
  await limit('reset:'+req.ip,12);
  const input=z.object({key:z.string().regex(/^[a-f0-9]{64}$/),password:z.string().min(8).max(512)}).parse(req.body);
  const secret=await hashPassword(input.password);
  await transaction(async client=>{
    const {rows:[reset]}=await client.query('delete from resets where token=$1 and expires>now() returning uid',[digest(input.key)]);
    if(!reset) throw new HttpError(400,'Poveznica je istekla ili nije valjana.');
    const updated=await client.query("update users set password=$3 where id=$1 and active and auth_kind='local' and "+localAccount+" and (role='root' or $4::boolean)",[reset.uid,demo,secret,input.password.length>=8]);
    if(!updated.rowCount) throw new HttpError(400,'Poveznica je istekla ili nije valjana.');
    await client.query('delete from sessions where uid=$1',[reset.uid]);
    await client.query('delete from resets where uid=$1',[reset.uid]);
  });
  res.json({ok:true});
});
setupAutomation(api);
api.use(async (req,_res,next)=>{
  const key=session(req);
  if(!key) throw new HttpError(401,'Prijavite se za nastavak.');
  const {rows:[account]}=await db.query(`select u.id,u.org,u.email,u.name,u.role,u.auth_kind,(u.auth_kind='formapoint' and u.source_project is not null and u.source_user_id is not null and u.source_email is not null) as shared_password from users u join sessions s on s.uid=u.id where s.token=$1 and s.expires>now() and u.active and (u.auth_kind<>'local' or ${localAccount})`,[digest(key),demo]);
  if(!account || (adminOrigin && (account.role==='root')!==isAdminSite(req))) throw new HttpError(401,'Sesija je istekla.');
  Object.assign(req,{account}); next();
});
api.post('/account/password',async(req,res)=>{
  const a=user(req);
  await limit('password:'+a.id,8);
  const input=z.object({currentPassword:z.string().min(1).max(512),newPassword}).strict().parse(req.body);
  const {rows:[account]}=await db.query('select * from users where id=$1 and active',[a.id]);
  if(!account || !['staff','formapoint','local'].includes(account.auth_kind))return deny();
  const shared=isLinkedFormaPoint(account);
  if(shared)sharedPassword.parse(input.newPassword);
  if(!shared&&!await verifyCurrentPassword(account,input.currentPassword))throw invalidLogin();
  if(input.currentPassword===input.newPassword)throw new HttpError(400,'Odaberite drukčiju novu lozinku.');
  const hash=shared?null:await hashPassword(input.newPassword);
  await transaction(async c=>{
    const {rows:[current]}=await c.query('select * from users where id=$1 and active for update',[a.id]);
    if(!current || current.password!==account.password || current.password_scheme!==account.password_scheme ||
      current.auth_kind!==account.auth_kind || current.source_project!==account.source_project ||
      current.source_user_id!==account.source_user_id || current.source_email!==account.source_email ||
      !(await c.query('select 1 from sessions where token=$1 and uid=$2 and expires>now()',[digest(session(req)!),a.id])).rowCount)throw new HttpError(401,'Sesija je istekla. Prijavite se ponovno.');
    if(shared)await changeFormaPointPassword(current.source_email,input.currentPassword,input.newPassword,{projectId:current.source_project,userId:current.source_user_id});
    await c.query("update users set password=$2,password_scheme='scrypt' where id=$1",[a.id,hash]);
    await c.query('delete from sessions where uid=$1',[a.id]);
    await c.query('delete from resets where uid=$1',[a.id]);
    await c.query('insert into audits(uid,action,target) values($1,$2,$3)',[a.id,'password.change',String(a.id)]);
  });
  res.clearCookie(cookie,cookieOptions).json({ok:true});
});
api.post('/logout',async (req,res)=>{await db.query('delete from sessions where token=$1',[digest(session(req)!)]);res.clearCookie(cookie,cookieOptions).json({ok:true});});
api.get('/me',async (req,res)=>{
  const account=user(req);
  const {rows:boxes}=await db.query(`select m.id,m.address,m.label,g.can_send,g.can_calendar,
    coalesce((select array_agg(address order by address) from aliases where box=m.id and send_as),'{}') aliases
    from mailboxes m join grants g on g.box=m.id join users u on u.id=g.uid where g.uid=$1 and m.active and ${studentBox} order by m.shared,m.id`,[account.id,demo]);
  res.json({account,boxes,demo});
});
async function box(req:Request, send=false){
  const {rows:[record]}=await db.query(`select m.*,g.can_send from mailboxes m join grants g on g.box=m.id join users u on u.id=g.uid where g.uid=$1 and m.id=$3 and m.active and ${studentBox}`,[user(req).id,demo,id.parse(req.params.box)]);
  if(!record || (send && !record.can_send)) return deny();
  return record;
}
const location=z.object({path:z.string().min(1).max(250),id});
api.get('/mail/:box',async(req,res)=>{
  const m=await box(req);
  res.json(await listing(m.address,String(req.query.folder || 'inbox'),z.string().max(200).parse(req.query.q || '')));
});
api.get('/mail/:box/quota',async(req,res)=>{
  const m=await box(req);
  res.json({...await quotaFor(m.address),target:m.target_quota_gb});
});
api.get('/mail/:box/message',async(req,res)=>{
  const m=await box(req), {path,id:uid}=location.parse(req.query);
  const item=await message(m.address,path,uid);
  const addresses=(value:typeof item.to)=>[value].flat().flatMap(x=>x?.value || []).map(x=>x.address).filter(Boolean);
  res.json({subject:item.subject,text:item.text || '',from:item.from?.value[0],replyTo:item.replyTo?.value[0]?.address,to:addresses(item.to),date:item.date,messageId:item.messageId,attachments:item.attachments.map(x=>({name:x.filename || 'Privitak',size:x.size}))});
});
api.get('/mail/:box/attachment',async(req,res)=>{
  const m=await box(req), {path,id:uid}=location.parse(req.query);
  const item=await message(m.address,path,uid);
  const file=item.attachments[z.coerce.number().int().min(0).parse(req.query.index)];
  if(!file) throw new HttpError(404,'Privitak nije pronađen.');
  res.attachment(file.filename || 'privitak').type('application/octet-stream').send(file.content);
});
api.patch('/mail/:box/message',async(req,res)=>{
  const m=await box(req),{path,id:uid}=location.parse(req.body);
  const change=z.object({flag:z.enum(['read','star']),value:z.boolean()}).parse(req.body);
  if(await isNative(m.address))await changeNative(m.address,path,uid,change);
  else await imap(m.address,async client=>{
    const lock=await client.getMailboxLock(path);
    try{
      const flag=change.flag==='star'?'\\Flagged':'\\Seen';
      if(change.value) await client.messageFlagsAdd(String(uid),[flag],{uid:true});
      else await client.messageFlagsRemove(String(uid),[flag],{uid:true});
    }finally{lock.release();}
  });
  res.json({ok:true});
});
api.post('/mail/:box/move',async(req,res)=>{
  const m=await box(req,true),{path,id:uid}=location.parse(req.body);
  const destination=z.enum(['inbox','junk','trash']).parse(req.body.destination);
  if(await isNative(m.address))await changeNative(m.address,path,uid,{destination});
  else await imap(m.address,async client=>{
    const target=(await folder(client,destination,true))!;
    if(path===target) return;
    const lock=await client.getMailboxLock(path);
    try {
      if(!await client.messageMove(String(uid),target,{uid:true})) throw new HttpError(409,'Premještanje nije potvrđeno.');
    } finally {lock.release();}
  });
  res.json({ok:true});
});
api.post('/mail/:box/send',async(req,res)=>{
  const m=await box(req,true);
  const input=z.object({from:email,to:z.array(email).max(50),subject:z.string().max(240),text:z.string().max(1000000),draft:z.boolean().optional(),draftId:id.optional(),inReplyTo:z.string().regex(/^<[^<>\s]+>$/).max(500).optional(),attachments:z.array(z.object({filename:z.string().min(1).max(255),data:z.string().max(7000000).regex(/^[A-Za-z0-9+/]*={0,2}$/)})).max(5).optional()}).parse(req.body);
  if(input.from!==m.address){
    const alias=await db.query('select 1 from aliases a join domains d on d.name=$3 and d.outbound where a.box=$1 and a.address=$2 and a.send_as',[m.id,input.from,addressing(input.from)]);
    if(!alias.rowCount) deny();
  }
  const mail:Outgoing={...input,attachments:input.attachments?.map(x=>({filename:x.filename,content:Buffer.from(x.data,'base64')}))};
  const raw=await mime(mail);
  if(await isNative(m.address) && raw.length>MAX_NATIVE_BYTES)throw new HttpError(413,'Poruka prelazi ograničenje od 3 MB.');
  async function retireDraft(){
    if(input.draftId===undefined) return false;
    try{await archiveDraft(m.address,input.draftId);return false;}
    catch{return true;}
  }
  if(input.draft){
    await append(m.address,'drafts',raw);
    res.json({ok:true,warning:await retireDraft()?'Nova skica je spremljena. Staru skicu uklonite ručno.':undefined});return;
  }
  if(!input.to.length) throw new HttpError(400,'Dodajte primatelja.');
  let result;
  try{result=await smtp(m.address,mail,raw);}catch(error){
    if(error instanceof HttpError) throw error;
    throw new HttpError(502,'SMTP predaja nije potvrđena. Provjerite zapis servisa prije ponovnog slanja.');
  }
  const warnings=[];
  if('sandbox' in result && result.sandbox)warnings.push('Mailjet probni način: poruka je provjerena, ali nije stvarno poslana.');
  try{await append(m.address,'sent',raw);}
  catch{warnings.push('Poruka je predana, ali kopija nije spremljena u Poslano.');}
  if(await retireDraft())warnings.push('Staru skicu uklonite ručno.');
  if(result.rejected) warnings.push('Neki primatelji nisu prihvaćeni.');
  res.json({ok:true,warning:warnings.join(' ') || undefined});
});
setupData(api);
app.use('/api',(_req,res)=>res.status(404).json({error:'Radnja nije pronađena.'}));
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(err instanceof DatabaseUnavailable) {res.status(err.status).json({error:err.message,code:err.code});return;}
  if(err instanceof HttpError) {res.status(err.status).json({error:err.message});return;}
  if(err instanceof ZodError){res.status(400).json({error:'Provjerite unesene podatke.',fields:err.issues.map(x=>x.path.join('.'))});return;}
  const code=(err as {code?:string}).code;
  if(['23505','23503','23514'].includes(code || '')){res.status(409).json({error:'Podatak već postoji ili nije dopuštena ta veza.'});return;}
  if((err as {status?:number}).status===413){res.status(413).json({error:'Zahtjev je prevelik.'});return;}
  console.error('Greška zahtjeva', code || (err as Error).name);
  res.status(502).json({error:'Radnja trenutno nije dostupna. Provjerite vezu sa servisom.'});
});

export default app;
