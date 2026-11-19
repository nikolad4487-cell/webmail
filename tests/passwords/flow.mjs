import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';

if(!process.env.TEST_PASSWORD_DATABASE_URL)throw new Error('Use TEST_PASSWORD_DATABASE_URL for an empty disposable local DB.');
assert.ok(['localhost','127.0.0.1'].includes(new URL(process.env.TEST_PASSWORD_DATABASE_URL).hostname));
process.env.DATABASE_URL=process.env.TEST_PASSWORD_DATABASE_URL;
process.env.NODE_ENV='test';process.env.DEMO_MODE='1';process.env.ADMIN_ORIGIN='';delete process.env.APP_ORIGIN;
let db,server,sourceServer,base,admin,staff,linked,externalSelf,student,otherAdmin,org;
let sourceCalls=0;
const sourcePassword='External-Password-2026',initial='Assigned-Password-2026',changed='87654321';
async function request(path,{session=admin,body,method=body?'POST':'GET',status=200}={}){
  const r=await fetch(base+'/api'+path,{method,headers:{...(session?{cookie:session}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const output=await r.text();assert.equal(r.status,status,path+' '+output);
  return {body:JSON.parse(output),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const login=(email,password,status=200)=>request('/login',{session:null,body:{identifier:email,password},status});
async function saveUser(email,kind,password,extra={}){
  await request('/admin/users',{body:{org,email,name:email,school:null,role:'user',active:true,recovery:null,auth_kind:kind,...(password?{password}:{}),...extra}});
  return (await request('/admin/users')).body.find(x=>x.email===email);
}
before(async()=>{
  ({db}=await import('../../server/db.ts'));
  assert.equal((await db.query("select to_regclass('users') as name")).rows[0].name,null,'Use an empty disposable DB');
  await db.query(await readFile(new URL('../../server/schema.sql',import.meta.url),'utf8'));
  const {hashPassword,digest}=await import('../../server/db.ts');
  const {staffSecret}=await import('../../server/identity.ts');
  org=(await db.query("insert into organizations(name) values('Passwords') returning id")).rows[0].id;
  const secondOrg=(await db.query("insert into organizations(name) values('Other') returning id")).rows[0].id;
  await db.query("insert into domains(name,org) values('formapoint.test',$1),('skolehr.test',$1),('other.test',$2)",[org,secondOrg]);
  const rootHash=await hashPassword(initial);
  await db.query("insert into users(org,email,name,password,role) values($1,'root@formapoint.test','Root',$2,'root')",[org,rootHash]);
  staff=(await db.query("insert into users(org,email,name,password,auth_kind) values($1,'legacy@skolehr.test','Legacy',$2,'staff') returning *",[org,await hashPassword(staffSecret('12345678'))])).rows[0];
  const migration=await readFile(new URL('../../migrations/002-mail-passwords.sql',import.meta.url),'utf8');
  await db.query(migration);await db.query(migration);
  assert.equal((await db.query('select password_scheme from users where id=$1',[staff.id])).rows[0].password_scheme,'staff_pin');
  sourceServer=createServer(async(req,res)=>{
    sourceCalls++;let body='';for await(const c of req)body+=c;const input=JSON.parse(body);
    const ok=input.password===sourcePassword&&req.headers.apikey==='local-auth-key';
    res.setHeader('Content-Type','application/json');res.statusCode=ok?200:400;
    res.end(JSON.stringify(ok?{user:{id:input.email.startsWith('self')?'self-source':'linked-source'}}:{error:'Invalid login'}));
  }).listen(0,'127.0.0.1');await once(sourceServer,'listening');
  process.env.FORMAPOINT_SUPABASE_PROJECT_ID='formapoint-local';process.env.FORMAPOINT_SUPABASE_AUTH_KEY='local-auth-key';
  process.env.FORMAPOINT_SUPABASE_URL='http://127.0.0.1:'+sourceServer.address().port;
  process.env.EDNEVNIK_SUPABASE_PROJECT_ID='ednevnik-local';process.env.EDNEVNIK_SUPABASE_URL='http://127.0.0.1:9';
  const {default:app}=await import('../../server/app.ts');server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
  admin=(await request('/auth/admin-login',{session:null,body:{identifier:'root@formapoint.test',password:initial}})).cookie;
  const other=(await db.query("insert into users(org,email,name,password,role,auth_kind) values($1,'admin@other.test','Other',$2,'admin','staff') returning id",[secondOrg,rootHash])).rows[0];
  otherAdmin=(await login('admin@other.test',initial)).cookie;
  linked=await saveUser('linked@formapoint.test','formapoint',undefined,{source_user_id:'linked-source',source_email:'linked@external.test'});
  externalSelf=await saveUser('self@formapoint.test','formapoint',undefined,{source_user_id:'self-source',source_email:'self@external.test'});
  for(const u of [linked,externalSelf]){
    const box=(await db.query('insert into mailboxes(org,address,label) values($1,$2,$2) returning id',[org,u.email])).rows[0].id;
    await db.query('insert into grants(uid,box,can_send) values($1,$2,true)',[u.id,box]);
  }
  student=(await db.query("insert into users(org,email,name,password,auth_kind,source_project,source_user_id) values($1,'student@skolehr.test','Student',null,'ednevnik','ednevnik-local','student-id') returning id",[org])).rows[0];
  const token='a'.repeat(64);await db.query("insert into sessions(token,uid,expires) values($1,$2,now()+interval '1 hour')",[digest(token),student.id]);student.cookie='wm_session='+token;
});
after(async()=>{server?.close();sourceServer?.close();await db?.end();});

test('Admin assigns ordinary staff/FormaPoint passwords; generator creates exactly eight digits',async()=>{
  const generated=(await request('/admin/passwords/generate',{method:'POST'})).body.password;
  assert.match(generated,/^[0-9]{8}$/);
  for(const [address,kind]of [['assigned@skolehr.test','staff'],['assigned@formapoint.test','formapoint']]){
    const u=await saveUser(address,kind,initial);
    const first=(await login(address,initial)).cookie;assert.ok(first);
    const {rows:[stored]}=await db.query('select password,password_scheme from users where id=$1',[u.id]);
    assert.notEqual(stored.password,initial);assert.equal(stored.password_scheme,'scrypt');
    const fields=(await request('/admin/users')).body.find(x=>x.id===u.id);assert.equal(fields.password,undefined);
    await request('/admin/users',{body:{org,key:u.id,email:address,name:address,school:null,role:'user',active:true,recovery:null,auth_kind:kind,password:'short'},status:400});
    await saveUser(address,kind,'Manual-Update-2026',{key:u.id});
    await request('/me',{session:first,status:401});
    await login(address,initial,401);assert.ok((await login(address,'Manual-Update-2026')).cookie);
  }
});
test('Old staff PIN survives migration; self-change revokes every session and needs current password',async()=>{
  const first=(await login(staff.email,'12345678')).cookie;
  const second=(await login(staff.email,'12345678')).cookie;
  await request('/account/password',{session:first,body:{currentPassword:'bad',newPassword:changed},status:401});
  await request('/account/password',{session:first,body:{currentPassword:'12345678',newPassword:'7654321'},status:400});
  await request('/account/password',{session:first,body:{currentPassword:'12345678',newPassword:changed,uid:linked.id},status:400});
  await request('/account/password',{session:first,body:{currentPassword:'12345678',newPassword:changed}});
  for(const session of [first,second])await request('/me',{session,status:401});
  await login(staff.email,'12345678',401);assert.ok((await login(staff.email,changed)).cookie);
  await db.query(await readFile(new URL('../../migrations/002-mail-passwords.sql',import.meta.url),'utf8'));
  assert.equal((await db.query('select password_scheme from users where id=$1',[staff.id])).rows[0].password_scheme,'scrypt');
});
test('Existing FormaPoint login remains until admin assigns a WebmailHR password',async()=>{
  const before=(await login(linked.email,sourcePassword)).cookie;
  const count=sourceCalls;
  const password=(await request('/admin/users/'+linked.id+'/password',{method:'POST'})).body.password;
  assert.match(password,/^[0-9]{8}$/);
  await request('/me',{session:before,status:401});
  await login(linked.email,sourcePassword,401);assert.ok((await login(linked.email,password)).cookie);
  assert.equal(sourceCalls,count,'Assigned password must not fall back to external authentication');
  const {rows:[row]}=await db.query('select source_project,source_user_id,source_email from users where id=$1',[linked.id]);
  assert.equal(row.source_user_id,'linked-source');assert.equal(row.source_email,'linked@external.test');
});
test('FormaPoint user may replace source login with an independent WebmailHR password',async()=>{
  const session=(await login(externalSelf.email,sourcePassword)).cookie;
  await request('/account/password',{session,body:{currentPassword:sourcePassword,newPassword:'Own-Webmail-Password-2026'}});
  await login(externalSelf.email,sourcePassword,401);assert.ok((await login(externalSelf.email,'Own-Webmail-Password-2026')).cookie);
  await request('/me',{session,status:401});
});
test('Student, anonymous user and other organization cannot assign or change another password',async()=>{
  await request('/account/password',{session:null,body:{currentPassword:initial,newPassword:changed},status:401});
  await request('/account/password',{session:student.cookie,body:{currentPassword:initial,newPassword:changed},status:403});
  await request('/admin/users/'+linked.id+'/password',{session:student.cookie,method:'POST',status:403});
  await request('/admin/users/'+linked.id+'/password',{session:otherAdmin,method:'POST',status:403});
  await request('/admin/users/'+student.id+'/password',{method:'POST',status:409});
  const staffSession=(await login(staff.email,changed)).cookie;
  const blocked=await fetch(base+'/api/account/password',{method:'POST',headers:{cookie:staffSession,Origin:'https://untrusted.example','Content-Type':'application/json'},body:JSON.stringify({currentPassword:changed,newPassword:'Forged-Change-2026'})});
  assert.equal(blocked.status,403);
});
test('Bulk generation skips existing passwords and invalidates old FormaPoint sessions',async()=>{
  const user=await saveUser('bulk@formapoint.test','formapoint',undefined,{source_user_id:'linked-source-bulk',source_email:'bulk@external.test'});
  // No source login is needed to verify the transactional invalidation of existing sessions.
  const {digest}=await import('../../server/db.ts');const token='b'.repeat(64);
  await db.query("insert into sessions(token,uid,expires) values($1,$2,now()+interval '1 hour')",[digest(token),user.id]);
  const result=(await request('/admin/users/initial-passwords',{body:{org}})).body.generated;
  assert.equal(result.some(x=>x.email===linked.email),false);
  const row=result.find(x=>x.email===user.email);assert.match(row.password,/^[0-9]{8}$/);
  await request('/me',{session:'wm_session='+token,status:401});assert.ok((await login(user.email,row.password)).cookie);
});
