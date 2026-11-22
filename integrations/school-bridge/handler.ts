type Settings={url:string;key:string;tokenHash:string;origins:string[]};
const family=new Set(['STUDENT','PARENT']);
const staff=new Set(['TEACHER','HOMEROOM','HOMEROOM_TEACHER','DEPUTY','PRINCIPAL','EXPERT','STAFF','ADMIN','SCHOOL_ADMIN','MAIN_ADMIN','SUPER_ADMIN','REGISTRAR','PEDAGOGUE','PSYCHOLOGIST']);
const issuers=new Set(['MAIN_ADMIN','SUPER_ADMIN','SCHOOL_ADMIN','REGISTRAR','PRINCIPAL']);
const normalize=(v:unknown)=>String(v||'').trim().toUpperCase();
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
export function schoolBridge(config:Settings,send:typeof fetch=fetch){
 async function api(path:string,method='GET',body?:unknown,token?:string){
  const response=await send(config.url+path,{method,redirect:'error',signal:AbortSignal.timeout(12000),headers:{apikey:config.key,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:config.key.startsWith('eyJ')?{Authorization:'Bearer '+config.key}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Object.assign(new Error('Izvor trenutačno nije dostupan.'),{status:[400,401,403].includes(response.status)?401:503,sourceStatus:response.status});
  return response.json();
 }
 async function rows(table:string,select:string,query:Record<string,string>={}){
  return api('/rest/v1/'+table+'?'+new URLSearchParams({select,...query}));
 }
 async function profileFor(subject:string){
  let list=await rows('user_profiles','id,auth_user_id,email,name,role,access_role,school_id',{auth_user_id:'eq.'+subject,limit:'2'});
  if(!list.length)list=await rows('user_profiles','id,auth_user_id,email,name,role,access_role,school_id',{id:'eq.'+subject,limit:'2'});
  if(list.length!==1||list[0].auth_user_id&&list[0].auth_user_id!==subject)throw Object.assign(new Error('Račun nije povezan.'),{status:403});
  return list[0];
 }
 async function roleInfo(profile:any){
  const members=await rows('user_school_roles','school_id,role,status',{user_id:'eq.'+profile.id});
  const active=members.filter((r:any)=>normalize(r.status)==='ACTIVE');
  const values=[profile.role,profile.access_role,...active.map((r:any)=>r.role)].map(normalize).filter(v=>v&&v!=='USER');
  return {members,active,values};
 }
 function randomPassword(){
  const alphabet='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',bytes=new Uint32Array(12);crypto.getRandomValues(bytes);
  // Rejection-free groups ensure the minimum policy, without PIN or symbols.
  const chars=['abcdefghijklmnopqrstuvwxyz'[bytes[0]%26],'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[bytes[1]%26],'0123456789'[bytes[2]%10],...Array.from(bytes.slice(3,8),n=>alphabet[n%alphabet.length])];
  for(let i=chars.length-1;i>0;i--){const j=bytes[11-i]%(i+1);[chars[i],chars[j]]=[chars[j],chars[i]];}
  return chars.join('');
 }
 return async(req:Request)=>{
  const origin=req.headers.get('origin');
  const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(origin&&config.origins.includes(origin)?{'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'}:{})};
  const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers});
  if(origin&&!config.origins.includes(origin))return reply(403,{error:'Izvor nije dopušten.'});
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(req.method!=='POST')return reply(405,{error:'Koristite POST.'});
  try{
   const token=req.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
   if(!token||token.length>8192)return reply(401,{error:'Prijavite se.'});
   const raw=await req.text();if(raw.length>4096)return reply(413,{error:'Prevelik zahtjev.'});
   const body=JSON.parse(raw);
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),v=>v.toString(16).padStart(2,'0')).join('');
   let difference=hash.length^config.tokenHash.length;for(let i=0;i<hash.length;i++)difference|=hash.charCodeAt(i)^(config.tokenHash.charCodeAt(i)||0);
   const service=difference===0;
   if(body.action==='family-login'){
    if(!service||origin)return reply(403,{error:'Servisni pristup je obavezan.'});
    if(typeof body.username!=='string'||typeof body.password!=='string'||body.password.length>512||!body.password||body.username.length>254)return reply(400,{error:'Neispravni podaci.'});
    const local=body.username.trim().toLowerCase().split('@')[0].replace(/[\\%_]/g,'\\$&');
    const candidates=await rows('user_profiles','id,email',{email:'ilike.'+local+'@*',limit:'2'});
    if(candidates.length>1)return reply(401,{error:'Prijava nije ispravna.'});
    const email=candidates[0]?.email||body.username;
    const signed=await api('/auth/v1/token?grant_type=password','POST',{email,password:body.password});
    const auth=signed.user;if(!uuid(auth?.id))return reply(401,{error:'Prijava nije ispravna.'});
    const p=await profileFor(auth.id),info=await roleInfo(p);
    if(!info.values.length||info.values.some(v=>!family.has(v))||info.members.length&&!info.active.length)return reply(403,{error:'Račun nije aktivan učenik ili roditelj.'});
    return reply(200,{user_id:auth.id});
   }
   if(body.action==='issue-student-password'||body.action==='student-details'){
    if(service||!uuid(body.profileId)||typeof body.schoolId!=='string')return reply(403,{error:'Potreban je ovlašten školski račun.'});
    const actorData=await api('/auth/v1/user','GET',undefined,token),actor=actorData.user??actorData;
    if(!uuid(actor?.id)||actor.is_anonymous)return reply(403,{error:'Račun nije ovlašten.'});
    const actorProfile=await profileFor(actor.id),actorRoles=await roleInfo(actorProfile);
    const global=[actorProfile.role,actorProfile.access_role].map(normalize).some(r=>['MAIN_ADMIN','SUPER_ADMIN'].includes(r));
    if(!global&&!actorRoles.active.some((r:any)=>r.school_id===body.schoolId&&issuers.has(normalize(r.role))))return reply(403,{error:'Nemate ovlast za ovu školu.'});
    const targetList=await rows('user_profiles','id,auth_user_id,email,name,role,access_role,school_id,oib,dob,gender',{id:'eq.'+body.profileId,limit:'1'}),p=targetList[0];
    if(!p||!uuid(p.auth_user_id))return reply(404,{error:'Učenički račun nije povezan.'});
    const targetRoles=await roleInfo(p);
    if(!targetRoles.values.length||targetRoles.values.some(v=>v!=='STUDENT')||!targetRoles.active.some((r:any)=>r.school_id===body.schoolId&&normalize(r.role)==='STUDENT'))return reply(403,{error:'Postupak vrijedi samo za aktivnog učenika te škole.'});
    const schoolList=await rows('schools','id,name,code,address,city,postal_code',{id:'eq.'+body.schoolId,limit:'1'});
    const years=await rows('school_years','id,school_id,ends_at,is_active',{school_id:'eq.'+body.schoolId,is_active:'eq.true',limit:'1'});
    const registry=await rows('registry_students','first_name,last_name,oib,date_of_birth,gender,status',{ednevnik_student_id:'eq.'+p.id,limit:'1'});
    const record=registry[0];
    if(record&&record.status!=='ACTIVE')return reply(403,{error:'Učenik nema aktivan matični zapis.'});
    const person={subject:p.auth_user_id,sourceLogin:p.email,name:[record?.first_name,record?.last_name].filter(Boolean).join(' ')||p.name,kind:'student',oib:record?.oib||p.oib,dob:record?.date_of_birth||p.dob,gender:record?.gender||p.gender,schools:schoolList.map((school:any)=>({...school,year_end:years[0]?.ends_at||null}))};
    if(body.action==='student-details')return reply(200,{ok:true,person});
    const password=randomPassword();
    const updated=await api('/auth/v1/admin/users/'+p.auth_user_id,'PUT',{password});
    if((updated.user??updated)?.id!==p.auth_user_id)throw new Error('Nova lozinka nije potvrđena.');
    // No source profile/PIN/TOTP/password_type writes. Password is returned only
    // for this issuance; old passwords cannot be queried or reconstructed.
    return reply(200,{ok:true,credential:{subject:p.auth_user_id,password}});
   }
   if(!['roster','roster-person'].includes(body.action)||!service||origin)return reply(403,{error:'Servisni pristup je obavezan.'});
   const page=body.page??0;if(!Number.isSafeInteger(page)||page<0||page>100000)return reply(400,{error:'Neispravna stranica.'});
   if(body.action==='roster-person'&&!uuid(body.subject))return reply(400,{error:'Neispravan identitet.'});
   let profiles=await rows('user_profiles','id,auth_user_id,email,name,role,access_role,school_id,oib,dob,gender,school_year_id',body.action==='roster-person'?{auth_user_id:'eq.'+body.subject,limit:'2'}:{order:'id',limit:'10',offset:String(page*10)});
   if(body.action==='roster-person'&&!profiles.length)profiles=await rows('user_profiles','id,auth_user_id,email,name,role,access_role,school_id,oib,dob,gender,school_year_id',{id:'eq.'+body.subject,limit:'1'});
   const schools=await rows('schools','id,name,code,address,city,postal_code,is_active',{limit:'1000'});
   const years=await rows('school_years','id,school_id,ends_at,is_active',{limit:'1000'});
   const people=[];
   // Bound concurrency keeps a roster page inside the server request deadline.
   for(let offset=0;offset<profiles.length;offset+=5){
    const batch=await Promise.all(profiles.slice(offset,offset+5).map(async(p:any)=>{
    const subject=p.auth_user_id||p.id;if(!uuid(subject))return;
    let auth;try{const data=await api('/auth/v1/admin/users/'+subject);auth=data.user??data;}catch(error){if((error as {sourceStatus?:number}).sourceStatus===404)return;throw error;}
    if(!auth?.email||!auth.email_confirmed_at||auth.is_anonymous||auth.banned_until&&Date.parse(auth.banned_until)>Date.now())return;
    const info=await roleInfo(p);
    const isFamily=info.values.length&&info.values.every(v=>family.has(v)),isStaff=info.values.length&&info.values.every(v=>staff.has(v));
    if(!isFamily&&!isStaff||info.members.length&&!info.active.length)return;
    const memberIds=[...new Set(info.active.map((r:any)=>r.school_id))];
    if(!memberIds.length&&p.school_id)memberIds.push(p.school_id);
    const memberships=schools.filter((s:any)=>memberIds.includes(s.id)&&s.is_active!==false).map((s:any)=>({...s,year_end:years.find((y:any)=>y.id===p.school_year_id&&y.school_id===s.id)?.ends_at||years.find((y:any)=>y.school_id===s.id&&y.is_active)?.ends_at||null}));
    if(!memberships.length)return;
    const registry=await rows('registry_students','first_name,last_name,oib,date_of_birth,gender,status',{ednevnik_student_id:'eq.'+p.id,limit:'1'});
    const record=registry[0];if(isFamily&&info.values.includes('STUDENT')&&record&&record.status!=='ACTIVE')return;
    return {subject,sourceLogin:auth.email,name:!isStaff&&[record?.first_name,record?.last_name].filter(Boolean).join(' ')||p.name||auth.email,kind:isStaff?'teacher':info.values.includes('PARENT')?'parent':'student',oib:record?.oib||p.oib||null,dob:record?.date_of_birth||p.dob||null,gender:record?.gender||p.gender||null,schools:memberships};
    }));
    people.push(...batch.filter(Boolean));
   }
   return reply(200,{project:new URL(config.url).hostname.split('.')[0],people,nextPage:body.action==='roster'&&profiles.length===10?page+1:null});
  }catch(error){const status=(error as {status?:number}).status||503;return reply(status,{error:status===401?'Prijava nije ispravna.':'Postupak nije potvrđen. Pokušajte ponovno.'});}
 };
}
