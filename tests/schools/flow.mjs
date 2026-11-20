import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const url=process.env.TEST_SCHOOL_DATABASE_URL;
if(!url||!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw new Error('Use an empty local TEST_SCHOOL_DATABASE_URL.');
Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',DEMO_MODE:'1',ADMIN_ORIGIN:'',EDNEVNIK_SUPABASE_PROJECT_ID:'school-test',FORMAPOINT_SUPABASE_PROJECT_ID:'forma-test',SCHOOL_SYNC_TOKEN:'local-school-source-secret-0123456789',MAILBOX_ENCRYPTION_KEY:'a'.repeat(64),CLOUDFLARE_INBOUND_SECRET:'local-inbound-secret-01234567890123456789',MAILJET_API_KEY:'local',MAILJET_SECRET_KEY:'local',CRON_SECRET:'local-cron-secret-01234567890123456789'});
delete process.env.APP_ORIGIN;
const school={id:'school-a',name:'Primjer škole A',code:'school-a',address:'Primjerna 12',city:'Zagreb',postal_code:'10000',year_end:'2027-08-31'};
const person=(kind,name,sourceLogin,schools=[school])=>({subject:randomUUID(),name,sourceLogin,kind,schools,oib:'00000000002',dob:'2010-03-06',gender:'M'});
const teacher=person('teacher','Marko Marić','teacher@source.test'),student=person('student','Luka Kovač','pupil@source.test'),parent=person('parent','Ana Kovač','parent@source.test');
const passwords=new Map([[student.sourceLogin,'Pupilpwd1'],[parent.sourceLogin,'Parentpw1']]);
const sourcePins=new Map([[teacher.subject,'1234']]);const calls=[];
let db,server,sourceServer,base,root,org,syncPerson,teacherRecord,teacherPassword,sourceFailure=false;
async function request(path,{method='GET',body,cookie=root,token,status=200,origin}={}){
 const r=await fetch(base+'/api'+path,{method,headers:{...(cookie?{cookie}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{})},body:body?JSON.stringify(body):undefined});
 if(r.status!==status)assert.equal(r.status,status,await r.text());return r;
}
async function login(identifier,password,status=200){const r=await request('/login',{method:'POST',body:{identifier,password},cookie:null,status});return r.headers.get('set-cookie')?.split(';')[0];}
function pdfText(buffer){const r=spawnSync('pdftotext',['-','-'],{input:buffer});assert.equal(r.status,0);return r.stdout.toString();}
before(async()=>{
 ({db}=await import('../../server/db.ts'));
 assert.equal((await db.query("select to_regclass('users') name")).rows[0].name,null);
 for(const f of ['server/schema.sql','migrations/001-native-mail.sql','migrations/002-mail-passwords.sql','migrations/003-mailbox-provisioning.sql','migrations/006-school-mailboxes.sql'])await db.query(await readFile(new URL('../../'+f,import.meta.url),'utf8'));
 org=(await db.query("insert into organizations(name) values('Škole') returning id")).rows[0].id;
 await db.query("insert into domains(name,org,mailbox_backend) values('skolehr.xyz',$1,'native')",[org]);
 const uid=(await db.query("insert into users(org,email,name,password,role) values($1,'root@skolehr.test','Root','unused','root') returning id",[org])).rows[0].id;
 const key='b'.repeat(64);await db.query("insert into sessions values($1,$2,now()+interval '1 hour')",[createHash('sha256').update(key).digest('hex'),uid]);root='wm_session='+key;
 sourceServer=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push(body);res.setHeader('Content-Type','application/json');
  if(sourceFailure){res.statusCode=503;res.end('{}');return;}
  if(['student-details','issue-student-password'].includes(body.action)){
   if(req.headers.authorization!=='Bearer school-admin-jwt'){res.statusCode=403;res.end('{}');return;}
   if(body.action==='student-details')res.end(JSON.stringify({ok:true,person:student}));
   else {passwords.set(student.sourceLogin,'Newpupil8');res.end(JSON.stringify({ok:true,credential:{subject:student.subject,password:'Newpupil8'}}));}return;
  }
  assert.equal(req.headers.authorization,'Bearer '+process.env.SCHOOL_SYNC_TOKEN);
  if(body.action==='family-login'){
   const p=[student,parent].find(p=>p.sourceLogin===body.username||p.sourceLogin.split('@')[0]===body.username);
   if(!p||passwords.get(p.sourceLogin)!==body.password){res.statusCode=401;res.end('{}');return;}res.end(JSON.stringify({user_id:p.subject}));return;
  }
  const people=body.action==='roster-person'?[student,parent,teacher].filter(p=>p.subject===body.subject):[teacher,student,parent];
  res.end(JSON.stringify({project:'school-test',people,nextPage:null}));
 }).listen(0,'127.0.0.1');await once(sourceServer,'listening');process.env.EDNEVNIK_SUPABASE_URL='http://127.0.0.1:'+sourceServer.address().port;
 ({syncSchoolPerson:syncPerson}=await import('../../server/school-mailboxes.ts'));
 const {default:app}=await import('../../server/app.ts');server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{server?.close();sourceServer?.close();await db?.end();});
test('School teacher receives native private mailbox and independent mixed password while source PIN stays untouched',async()=>{
 teacherRecord=await syncPerson(teacher,'first');assert.equal(teacherRecord.address,'marko.maric@skolehr.xyz');
 const row=(await db.query('select * from school_mail_identities where uid=$1',[teacherRecord.uid])).rows[0];
 teacherPassword=(await import('../../server/mailbox-secrets.ts')).openMailboxPassword(teacherRecord.address,row.initial_password);
 assert.match(teacherPassword,/^[a-zA-Z0-9]{8}$/);assert.match(teacherPassword,/[a-z]/);assert.match(teacherPassword,/[A-Z]/);assert.match(teacherPassword,/[0-9]/);
 const cookie=await login(teacherRecord.address,teacherPassword);assert.ok(cookie);await login(teacherRecord.address,'1234',401);
 assert.equal(sourcePins.get(teacher.subject),'1234');assert.equal(calls.length,0);
 const repeated=await syncPerson({...teacher,name:'Marko Marić Novi',schools:[{...school,year_end:'2028-08-31'}]},'again');assert.equal(repeated.uid,teacherRecord.uid);assert.equal(repeated.address,teacherRecord.address);
 assert.equal((await db.query('select valid_until::text date from school_mail_identities where uid=$1',[teacherRecord.uid])).rows[0].date,'2028-10-31');
 const second=await syncPerson(person('teacher','Marko Marić','second@source.test'),'again');assert.equal(second.address,'marko.maric2@skolehr.xyz');
});
test('Student and parent provision on first source-verified login; cannot change their password in WebmailHR',async()=>{
 for(const p of [student,parent]){
  const cookie=await login(p.sourceLogin.split('@')[0],passwords.get(p.sourceLogin));assert.ok(cookie);
  const account=await (await request('/me',{cookie})).json();assert.equal(account.account.auth_kind,'ednevnik');assert.equal(account.boxes.length,1);
  await request('/account/password',{cookie,method:'POST',body:{currentPassword:passwords.get(p.sourceLogin),newPassword:'Otherpwd1'},status:403});
 }
 const record=(await db.query('select u.email from users u where source_user_id=$1',[student.subject])).rows[0];assert.equal(record.email,'luka.kovac@skolehr.xyz');
 assert.ok(await login('luka.kovac','Pupilpwd1'));
});
test('Credential PDF preserves Unicode, institution and separate teacher password semantics; cross-school access is blocked',async()=>{
 const response=await request('/admin/users/'+teacherRecord.uid+'/credentials.pdf');assert.equal(response.headers.get('content-type'),'application/pdf');
 const text=pdfText(Buffer.from(await response.arrayBuffer()));assert.match(text,/Marko Marić Novi/);assert.ok(text.includes(teacherPassword));assert.match(text,/PIN za e-Dnevnik je zaseban/);assert.match(text,/31.10.2028/);
 const otherSchool=(await db.query("insert into schools(org,name) values($1,'Other school') returning id",[org])).rows[0].id;
 const u=(await db.query("insert into users(org,school,email,name,password,role,auth_kind) values($1,$2,'scope@skolehr.xyz','Scope','unused','admin','staff') returning id",[org,otherSchool])).rows[0];
 const key='c'.repeat(64);await db.query("insert into sessions values($1,$2,now()+interval '1 hour')",[createHash('sha256').update(key).digest('hex'),u.id]);
 await request('/admin/users/'+teacherRecord.uid+'/credentials.pdf',{cookie:'wm_session='+key,status:403});
});
test('A new pupil password is issued only through authorized e-Matica action and printed once-issued value; no PIN mutation',async()=>{
 const before=calls.filter(x=>x.action==='issue-student-password').length;
 await request('/integrations/schools/student-password.pdf',{cookie:null,method:'POST',body:{profileId:student.subject,schoolId:school.id},status:401});
 await request('/integrations/schools/student-password.pdf',{cookie:null,token:'not-admin',method:'POST',body:{profileId:student.subject,schoolId:school.id},status:403});
 assert.equal(calls.filter(x=>x.action==='issue-student-password').length,before);
 const response=await request('/integrations/schools/student-password.pdf',{cookie:null,token:'school-admin-jwt',method:'POST',origin:'https://e-matica.skolehr.xyz',body:{profileId:student.subject,schoolId:school.id}});
 const text=pdfText(Buffer.from(await response.arrayBuffer()));assert.match(text,/Newpupil8/);assert.match(text,/luka.kovac@skolehr.xyz/);assert.match(text,/Nova lozinka vrijedi za e-Dnevnik i WebmailHR/);
 await login('luka.kovac@skolehr.xyz','Pupilpwd1',401);assert.ok(await login('luka.kovac@skolehr.xyz','Newpupil8'));
 const uid=(await db.query('select id from users where source_user_id=$1',[student.subject])).rows[0].id;
 const existing=pdfText(Buffer.from(await (await request('/admin/users/'+uid+'/credentials.pdf')).arrayBuffer()));assert.ok(!existing.includes('Newpupil8'));assert.match(existing,/Postojeća lozinka/);
 assert.equal(sourcePins.get(teacher.subject),'1234');assert.ok(calls.every(x=>!Object.hasOwn(x,'pin')));
});
test('Teacher can change only the mail password; previous printable password disappears',async()=>{
 const cookie=await login(teacherRecord.address,teacherPassword),before=calls.length;
 await request('/account/password',{cookie,method:'POST',body:{currentPassword:teacherPassword,newPassword:'Changed9'}});
 assert.equal(calls.length,before);assert.equal(sourcePins.get(teacher.subject),'1234');assert.ok(await login(teacherRecord.address,'Changed9'));
 assert.equal((await db.query('select initial_password from school_mail_identities where uid=$1',[teacherRecord.uid])).rows[0].initial_password,null);
 await request('/admin/users/'+teacherRecord.uid+'/credentials.pdf',{status:409});
});
test('Unavailable source cannot deactivate accounts; full successful snapshot safely disables only absent imported identities',async()=>{
 sourceFailure=true;await request('/admin/schools/sync',{method:'POST',status:503});sourceFailure=false;
 assert.equal((await db.query('select active from users where id=$1',[teacherRecord.uid])).rows[0].active,true);
 const missing=await syncPerson(person('teacher','Gone Teacher','gone@source.test'),'old');
 const result=await (await request('/admin/schools/sync',{method:'POST'})).json();assert.equal(result.conflicts,0);
 // A manual import during an interrupted snapshot survives until the next complete snapshot.
 await request('/admin/schools/sync',{method:'POST'});
 assert.equal((await db.query('select active from users where id=$1',[missing.uid])).rows[0].active,false);
 assert.equal((await db.query('select active from users where id=$1',[teacherRecord.uid])).rows[0].active,true);
 await request('/integrations/schools/sync',{cookie:null,status:401});
});

test('A school role change stops the previous mail identity until administrator review',async()=>{
 const changed=person('teacher','Former Teacher','former@source.test');const record=await syncPerson(changed,'role-before');
 await assert.rejects(syncPerson({...changed,kind:'student'},'role-after'),/Promjena vrste školskog računa/);
 assert.equal((await db.query('select active from users where id=$1',[record.uid])).rows[0].active,false);
 assert.equal((await db.query('select initial_password from school_mail_identities where uid=$1',[record.uid])).rows[0].initial_password,null);
});
