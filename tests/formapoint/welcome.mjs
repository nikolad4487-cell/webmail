import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
const url=process.env.TEST_WELCOME_DATABASE_URL;
if(!url||!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw new Error('Use an empty local TEST_WELCOME_DATABASE_URL.');
Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',DEMO_MODE:'1',ADMIN_ORIGIN:'',FORMAPOINT_SUPABASE_PROJECT_ID:'forma-test',FORMAPOINT_WELCOME_EMAIL:'1',CLOUDFLARE_INBOUND_SECRET:'local-inbound-secret-01234567890123456789',MAILJET_API_KEY:'local',MAILJET_SECRET_KEY:'local',MAILJET_SANDBOX:'0'});
let db,transaction,queue,deliver,org,server;const sent=[];let fail=false;
async function account(email,source='personal@gmail.com'){
 const u=(await db.query(`insert into users(org,email,name,password,auth_kind,source_project,source_user_id,source_email)
 values($1,$2,'Marko Marić',null,'formapoint','forma-test',$3,$4) returning *`,[org,email,randomUUID(),source])).rows[0];
 const b=(await db.query("insert into mailboxes(org,address,label,storage_kind) values($1,$2,'Personal','native') returning id",[org,email])).rows[0];
 await db.query('insert into grants values($1,$2,true,true)',[u.id,b.id]);return {u,b};
}
before(async()=>{
 ({db,transaction}=await import('../../server/db.ts'));
 assert.equal((await db.query("select to_regclass('users') name")).rows[0].name,null);
 for(const file of ['server/schema.sql','migrations/001-native-mail.sql','migrations/002-mail-passwords.sql','migrations/003-mailbox-provisioning.sql','migrations/005-formapoint-welcome.sql'])await db.query(await readFile(new URL('../../'+file,import.meta.url),'utf8'));
 org=(await db.query("insert into organizations(name) values('FormaPoint') returning id")).rows[0].id;
 await db.query("insert into domains(name,org,mailbox_backend) values('formapoint.online',$1,'native')",[org]);
 ({queueFormaPointWelcome:queue,deliverFormaPointWelcomes:deliver}=await import('../../server/formapoint-welcome.ts'));
 server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;sent.push(JSON.parse(raw));res.setHeader('Content-Type','application/json');res.statusCode=fail?500:200;res.end(JSON.stringify({Messages:[{Status:fail?'error':'success'}]}));}).listen(0,'127.0.0.1');await once(server,'listening');
 process.env.MAILJET_TEST_URL='http://127.0.0.1:'+server.address().port;
});
after(async()=>{server?.close();await db?.end();});
let owner;
test('Queues one welcome with existing FormaPoint credentials and never creates or stores a password',async()=>{
 owner=await account('marko.maric@formapoint.online');
 await Promise.all(Array.from({length:4},()=>transaction(c=>queue(c,owner.u.id,owner.b.id))));
 const jobs=(await db.query('select * from formapoint_welcomes where uid=$1',[owner.u.id])).rows;assert.equal(jobs.length,1);
 assert.equal(jobs[0].status,'pending');assert.equal(jobs[0].password_hash,undefined);assert.equal(jobs[0].encrypted_password,undefined);
 const counts=await Promise.all([deliver(),deliver(),deliver()]);assert.equal(counts.reduce((n,r)=>n+r.sent,0),1);assert.equal(sent.length,1);
 const m=sent[0].Messages[0];assert.equal(m.From.Name,'FormaPoint Tim');assert.equal(m.To[0].Email,'personal@gmail.com');assert.equal(m.Subject,'Vaš FormaPoint poštanski sandučić');
 assert.match(m.TextPart,/Poštovani,/);assert.match(m.TextPart,/https:\/\/www.webmailhr.com\//);assert.match(m.TextPart,/Korisničko ime: marko.maric@formapoint.online/);assert.match(m.TextPart,/S poštovanjem,\nFormaPoint Tim$/);
 assert.match(m.TextPart,/Lozinka: ona koju ste postavili za prijavu na FormaPoint/);
 const user=(await db.query('select * from users where id=$1',[owner.u.id])).rows[0];assert.equal(user.password,null);
 const done=(await db.query('select * from formapoint_welcomes where uid=$1',[owner.u.id])).rows[0];assert.equal(done.status,'sent');
 await transaction(c=>queue(c,owner.u.id,owner.b.id));await deliver();assert.equal(sent.length,1);
});
test('Independent WebmailHR password assignment cancels an obsolete same-password notification',async()=>{
 const {u,b}=await account('new.password@formapoint.online','new@gmail.com');await transaction(c=>queue(c,u.id,b.id));
 await db.query("update users set password='user-changed-password' where id=$1",[u.id]);await deliver();
 const row=(await db.query('select * from formapoint_welcomes where uid=$1',[u.id])).rows[0];assert.equal(row.status,'cancelled');assert.equal(sent.length,1);
});
test('Ambiguous provider failure is never automatically resent or assigned a password',async()=>{
 const {u,b}=await account('unknown@formapoint.online','unknown@gmail.com');await transaction(c=>queue(c,u.id,b.id));
 fail=true;assert.equal((await deliver()).unknown,1);fail=false;const before=sent.length;
 await deliver();await transaction(c=>queue(c,u.id,b.id));await deliver();assert.equal(sent.length,before);
 assert.equal((await db.query('select status from formapoint_welcomes where uid=$1',[u.id])).rows[0].status,'unknown');
});
test('Existing independently assigned passwords are preserved',async()=>{
 const {u,b}=await account('existing.password@formapoint.online','existing@gmail.com');await db.query("update users set password='preserve' where id=$1",[u.id]);
 await transaction(c=>queue(c,u.id,b.id));assert.equal((await db.query('select count(*)::int n from formapoint_welcomes where uid=$1',[u.id])).rows[0].n,0);
});

test('A real signed signup request creates a named mailbox, mails its original address once and keeps FormaPoint login',async()=>{
 const {createHash,createHmac}=await import('node:crypto');
 Object.assign(process.env,{FORMAPOINT_AUTO_MAILBOXES:'1',FORMAPOINT_PROVISION_SECRET:'local-signup-provision-secret-0123456789',FORMAPOINT_SUPABASE_URL:'http://127.0.0.1:1',FORMAPOINT_SUPABASE_AUTH_KEY:'local-public'});
 const {default:app}=await import('../../server/app.ts');const api=app.listen(0,'127.0.0.1');await once(api,'listening');const base='http://127.0.0.1:'+api.address().port;
 const p={id:randomUUID(),email:'signup@gmail.com',name:'Ana Šarić',confirmed:true,anonymous:false};
 async function signup(){
  const body=JSON.stringify({project:'forma-test',users:[p]}),timestamp=String(Date.now()),hash=createHash('sha256').update(body).digest('hex');
  const r=await fetch(base+'/api/integrations/formapoint/provision',{method:'POST',headers:{'Content-Type':'application/json','x-webmail-sync-timestamp':timestamp,'x-webmail-sync-hash':hash,'x-webmail-sync-signature':createHmac('sha256',process.env.FORMAPOINT_PROVISION_SECRET).update(timestamp+'\n'+hash).digest('hex')},body});assert.equal(r.status,200);return r.json();
 }
 const originalFetch=globalThis.fetch;
 try{
  const initial=sent.length;const first=await signup();assert.equal(first.results[0].address,'ana.saric@formapoint.online');assert.equal(first.welcomes.sent,1);
  assert.equal(sent.length,initial+1);assert.equal(sent.at(-1).Messages[0].To[0].Email,p.email);assert.match(sent.at(-1).Messages[0].TextPart,/Lozinka: ona koju ste postavili za prijavu na FormaPoint/);
  assert.equal((await signup()).results[0].status,'existing');assert.equal(sent.length,initial+1);
  assert.equal((await db.query('select password from users where source_user_id=$1',[p.id])).rows[0].password,null);
  globalThis.fetch=async(url,options)=>String(url).startsWith('http://127.0.0.1:1/auth/')?(assert.equal(JSON.parse(options.body).password,'original-formapoint-password'),Response.json({user:{id:p.id}})):originalFetch(url,options);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:'ana.saric@formapoint.online',password:'original-formapoint-password'})});assert.equal(login.status,200,await login.text());
  const me=await fetch(base+'/api/me',{headers:{cookie:login.headers.get('set-cookie').split(';')[0]}}).then(r=>r.json());assert.deepEqual(me.boxes.map(x=>x.address),['ana.saric@formapoint.online']);
 }finally{globalThis.fetch=originalFetch;api.close();}
});
