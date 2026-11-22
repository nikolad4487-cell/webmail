import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {schoolBridge} from '../../integrations/school-bridge/handler.ts';
const subject='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',profile='33333333-3333-4333-8333-333333333333';
const secret='local-school-bridge-only-token';
function bridge({scope='school-1',targetKind='STUDENT',authStatus=200}={}){
 const mutations=[];
 const send=async(url,options)=>{
  const u=new URL(url),path=u.pathname;
  if(path==='/auth/v1/user')return options.headers.Authorization==='Bearer user-jwt'?Response.json({id:actor,email:'school-admin@example.test'}):new Response('{}',{status:401});
  if(path.startsWith('/auth/v1/admin/users/')&&options.method==='PUT'){mutations.push(JSON.parse(options.body));return Response.json({id:subject});}
  if(path.startsWith('/auth/v1/admin/users/')&&options.method==='GET')return authStatus===200?Response.json({id:subject,email:'luka@example.test',email_confirmed_at:'2026-01-01'}):new Response('{}',{status:authStatus});
  if(path==='/rest/v1/user_profiles'){
   assert.ok(!u.searchParams.get('select').includes('pin'));assert.ok(!u.searchParams.get('select').includes('authenticator'));
   if(u.searchParams.get('auth_user_id')==='eq.'+actor)return Response.json([{id:actor,auth_user_id:actor,role:'SCHOOL_ADMIN',school_id:scope}]);
   return Response.json([{id:profile,auth_user_id:subject,email:'luka@example.test',name:'Luka Kovač',role:targetKind,school_id:'school-1',oib:'00000000002',dob:'2010-03-06'}]);
  }
  if(path==='/rest/v1/user_school_roles')return Response.json(u.searchParams.get('user_id')==='eq.'+actor?[{school_id:scope,role:'SCHOOL_ADMIN',status:'ACTIVE'}]:[{school_id:'school-1',role:targetKind,status:'ACTIVE'}]);
  if(path==='/rest/v1/schools')return Response.json([{id:'school-1',name:'Primjer škole'}]);
  if(path==='/rest/v1/school_years')return Response.json([{id:'year',ends_at:'2027-08-31'}]);
  if(path==='/rest/v1/registry_students')return Response.json([{oib:'00000000002',date_of_birth:'2010-03-06',status:'ACTIVE'}]);
  throw new Error('Unexpected source operation '+path);
 };
 return {handler:schoolBridge({url:'https://school.example.test',key:'server-key',tokenHash:createHash('sha256').update(secret).digest('hex'),origins:['https://e-matica.skolehr.xyz']},send),mutations};
}
function request(handler,token,action='issue-student-password'){return handler(new Request('https://school.example.test/functions/v1/webmail-school-bridge',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action,profileId:profile,schoolId:'school-1'})}));}
test('School admin issues one new student password and never reads or modifies the PIN',async()=>{
 const {handler,mutations}=bridge();const response=await request(handler,'user-jwt');assert.equal(response.status,200);
 const body=await response.json(),password=body.credential.password;assert.match(password,/^[a-zA-Z0-9]{8}$/);assert.match(password,/[a-z]/);assert.match(password,/[A-Z]/);assert.match(password,/[0-9]/);
 assert.deepEqual(mutations,[{password}]);assert.equal(body.credential.subject,subject);
});
test('Cross-school reset, teacher reset and server-token reset are rejected before any mutation',async()=>{
 for(const settings of [{scope:'other-school'},{targetKind:'TEACHER'}]){const {handler,mutations}=bridge(settings);assert.equal((await request(handler,'user-jwt')).status,403);assert.equal(mutations.length,0);}
 const {handler,mutations}=bridge();assert.equal((await request(handler,secret)).status,403);assert.equal(mutations.length,0);
});
test('Reading student print metadata does not issue a password',async()=>{
 const {handler,mutations}=bridge();const response=await request(handler,'user-jwt','student-details');assert.equal(response.status,200);assert.equal((await response.json()).person.kind,'student');assert.equal(mutations.length,0);
});

test('Roster distinguishes removed accounts from source outages',async()=>{
 for(const status of [401,429,500]){const {handler}=bridge({authStatus:status});assert.notEqual((await request(handler,secret,'roster')).status,200);}
 const {handler}=bridge({authStatus:404});const response=await request(handler,secret,'roster');assert.equal(response.status,200);assert.deepEqual((await response.json()).people,[]);
});
