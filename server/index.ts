import {authKind,externalKind,invalidLogin,staffSecret,verifyExternal} from './identity';
import express, {type Request} from 'express';
import {createServer as createHttpServer} from 'node:http';
import {resolve} from 'node:path';
import {z, ZodError} from 'zod';
import {db,digest,hashPassword,token,transaction,verifyPassword} from './db';
import {addressing,append,archiveDraft,demo,folder,HttpError,imap,listing,message,mime,quotaFor,smtp,type Outgoing} from './mail';
import {email,id,user,deny} from './http';
import {setupData} from './workspace';
import {setupAutomation} from './automation';

const app=express(), api=express.Router(), production=process.env.NODE_ENV==='production';
const server=createHttpServer(app);
const origin=process.env.APP_ORIGIN || (production?'https://webmailhr.com':'');
const adminOrigin=process.env.ADMIN_ORIGIN || (production?'https://admin.webmailhr.com':'');
const adminHost=adminOrigin?new URL(adminOrigin).host:'';
if(adminHost && origin && adminHost===new URL(origin).host) throw new Error('Administracija zahtijeva zasebnu adresu.');
const adminPortal=(req:Request)=>Boolean(adminHost && req.get('host')?.toLowerCase()===adminHost);
const permitsRole=(req:Request,role:string)=>!adminHost || adminPortal(req)===(role!=='user');
app.disable('x-powered-by');
if (process.env.TRUST_PROXY==='1') app.set('trust proxy',1);
app.use((_req,res,next)=>{
  if(production) res.set('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});
  next();
});
app.use('/api',express.json({limit:'17mb'}),(_req,res,next)=>{res.set('Cache-Control','no-store');next();},api);
api.use((req,_res,next)=>{
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.get('origin')) {
    const expected = (adminPortal(req)?adminOrigin:origin) || `${req.protocol}://${req.get('host')}`;
    if (req.get('origin')!==expected) throw new HttpError(403,'Zahtjev nije dopušten.');
  }
  next();
});
const cookie='wm_session';
const cookieOptions={httpOnly:true,sameSite:'lax' as const,secure:production,path:'/'};
const session=(req:Request)=>req.headers.cookie?.match(/(?:^|;\s*)wm_session=([a-f0-9]{64})(?:;|$)/)?.[1];
const fallback=await hashPassword(token());
async function limit(key:string, max:number) {
  const {rows}=await db.query(`insert into login_limits values($1,1,now()+interval '15 minutes')
    on conflict(key) do update set count=case when login_limits.expires<now() then 1 else login_limits.count+1 end,
    expires=case when login_limits.expires<now() then excluded.expires else login_limits.expires end returning count`,[digest(key)]);
  if(rows[0].count>max) throw new HttpError(429,'Previše pokušaja. Pokušajte ponovno za 15 minuta.');
}
api.get('/health',async (req,res)=>{await db.query('select 1');res.json({ok:true,demo,admin:adminPortal(req)});});
const localAccount = "(role='root' or ($2::boolean and right(email,5)='.test'))";
const studentBox = "(u.auth_kind<>'ednevnik' or (m.address=u.email and not m.shared and (right(u.email,12)='@skolehr.xyz' or ($2::boolean and right(u.email,13)='@skolehr.test'))))";
const noMailbox=()=>new HttpError(403,'Prijava je uspjela. Administrator treba dodijeliti pristup sandučiću.');
api.post('/login',async (req,res)=>{
  const input=z.object({identifier:z.string().trim().min(1).max(254),password:z.string().min(1).max(512),remember:z.boolean().optional()}).parse(req.body);
  const {identifier,password}=input;
  await limit('ip:'+req.ip,80);
  const {rows:accounts}=await db.query(`select id,email,role,active,auth_kind,password,source_project,source_user_id,source_username,
    email=lower($1) as exact_address from users
    where email=lower($1) or (source_username is not null and lower(source_username)=lower($1))
    order by exact_address desc limit 2`,[identifier]);
  const [account]=accounts;
  const candidate=account && (account.exact_address || accounts.length===1)?account:undefined;
  if(!candidate?.active || !permitsRole(req,candidate.role)){
    await limit('login:unmatched:'+identifier.toLowerCase(),12);
    await verifyPassword(password,fallback);
    throw invalidLogin();
  }
  const kind=authKind.parse(candidate.auth_kind);
  const rateKey='login:'+candidate.email;
  await limit(rateKey,kind==='staff'?6:12);
  let source:{projectId:string;userId:string}|undefined;
  if(externalKind(kind)){
    source=await verifyExternal(kind,candidate.source_username ?? candidate.email,password);
    if(candidate.source_project!==source.projectId || candidate.source_user_id!==source.userId) throw invalidLogin();
  }else{
    if(kind==='local' && candidate.role!=='root' && !(demo && candidate.email.endsWith('.test'))) throw invalidLogin();
    if(kind==='staff' && !/^[0-9]{8}$/.test(password)) throw invalidLogin();
    const secret=kind==='staff'?staffSecret(password):password;
    const matches=await verifyPassword(secret,candidate.password ?? fallback);
    if(!matches || !candidate.password) throw invalidLogin();
  }
  const key=token(), lifetime=(input.remember?30:1)*86400000;
  await transaction(async client=>{
    const {rows:[account]}=await client.query('select email,role,password,source_project,source_user_id,source_username from users where id=$1 and auth_kind=$2 and active for update',[candidate.id,kind]);
    if(!account || account.email!==candidate.email || account.role!==candidate.role || account.password!==candidate.password ||
      (source && (account.source_username!==candidate.source_username || account.source_project!==source.projectId || account.source_user_id!==source.userId))) throw invalidLogin();
    if(source && !(await client.query(`select 1 from grants g join mailboxes m on m.id=g.box join users u on u.id=g.uid
      where u.id=$1 and m.active and ${studentBox} limit 1`,[candidate.id,demo])).rowCount) throw noMailbox();
    await client.query('delete from login_limits where key=$1',[digest(rateKey)]);
    await client.query('insert into sessions values($1,$2,$3)',[digest(key),candidate.id,new Date(Date.now()+lifetime)]);
  });
  res.cookie(cookie,key,{...cookieOptions,...(input.remember?{maxAge:lifetime}:{})}).json({ok:true});
});
api.post('/recover',async (req,res)=>{
  const address=email.parse(req.body.email);
  await limit('recovery:'+req.ip,8);
  const {rows:[account]}=await db.query("select id,recovery,role from users where email=$1 and active and recovery is not null and auth_kind='local' and "+localAccount,[address,demo]);
  const from=process.env.RECOVERY_SENDER;
  const recoveryOrigin=adminPortal(req)?adminOrigin:origin;
  if(account && permitsRole(req,account.role) && from && recoveryOrigin) {
    const key=token();
    await db.query("insert into resets values($1,$2,now()+interval '30 minutes')",[digest(key),account.id]);
    const mail={from,to:[account.recovery],subject:'Ponovno postavljanje lozinke',text:recoveryOrigin+'/?reset='+key};
    try { await smtp(from,mail,await mime(mail)); } catch { console.error('Predaja poruke za oporavak nije uspjela.'); }
  }
  res.json({ok:true});
});
api.post('/reset',async (req,res)=>{
  await limit('reset:'+req.ip,12);
  const input=z.object({key:z.string().regex(/^[a-f0-9]{64}$/),password:z.string().min(12).max(512)}).parse(req.body);
  const secret=await hashPassword(input.password);
  await transaction(async client=>{
    const {rows:[reset]}=await client.query('delete from resets where token=$1 and expires>now() returning uid',[digest(input.key)]);
    if(!reset) throw new HttpError(400,'Poveznica je istekla ili nije valjana.');
    const {rows:[updated]}=await client.query("update users set password=$3 where id=$1 and active and auth_kind='local' and "+localAccount+" returning role",[reset.uid,demo,secret]);
    if(!updated || !permitsRole(req,updated.role)) throw new HttpError(400,'Poveznica je istekla ili nije valjana.');
    await client.query('delete from sessions where uid=$1',[reset.uid]);
    await client.query('delete from resets where uid=$1',[reset.uid]);
  });
  res.json({ok:true});
});
setupAutomation(api);
api.use(async (req,_res,next)=>{
  const key=session(req);
  if(!key) throw new HttpError(401,'Prijavite se za nastavak.');
  const {rows:[account]}=await db.query(`select u.id,u.org,u.email,u.name,u.role from users u join sessions s on s.uid=u.id where s.token=$1 and s.expires>now() and u.active and (u.auth_kind<>'local' or ${localAccount})`,[digest(key),demo]);
  if(!account || !permitsRole(req,account.role)) throw new HttpError(401,'Sesija je istekla.');
  Object.assign(req,{account}); next();
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
  await imap(m.address,async client=>{
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
  await imap(m.address,async client=>{
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
  try{await append(m.address,'sent',raw);}
  catch{warnings.push('Poruka je predana, ali kopija nije spremljena u Poslano.');}
  if(await retireDraft())warnings.push('Staru skicu uklonite ručno.');
  if(result.rejected) warnings.push('Neki primatelji nisu prihvaćeni.');
  res.json({ok:true,warning:warnings.join(' ') || undefined});
});
setupData(api);
app.use('/api',(_req,res)=>res.status(404).json({error:'Radnja nije pronađena.'}));
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(err instanceof HttpError) {res.status(err.status).json({error:err.message});return;}
  if(err instanceof ZodError){res.status(400).json({error:'Provjerite unesene podatke.',fields:err.issues.map(x=>x.path.join('.'))});return;}
  const code=(err as {code?:string}).code;
  if(['23505','23503','23514'].includes(code || '')){res.status(409).json({error:'Podatak već postoji ili nije dopuštena ta veza.'});return;}
  if((err as {status?:number}).status===413){res.status(413).json({error:'Zahtjev je prevelik.'});return;}
  console.error('Greška zahtjeva', code || (err as Error).name);
  res.status(502).json({error:'Radnja trenutno nije dostupna. Provjerite vezu sa servisom.'});
});
app.get('/admin', (req,res,next)=>{
  if(adminOrigin && !adminPortal(req)) return res.redirect(new URL('/admin',adminOrigin).href);
  next();
});
if(production){
  app.use(express.static(resolve('dist')));
  app.get(/.*/,(_req,res)=>res.sendFile(resolve('dist/index.html')));
}else{
  const {createServer}=await import('vite');
  const vite=await createServer({server:{middlewareMode:true,allowedHosts:true,ws:{server}},appType:'spa'});
  app.use(vite.middlewares);
}
server.listen(Number(process.env.PORT || 3000),'0.0.0.0');
