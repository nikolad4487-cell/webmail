import {z} from 'zod';

export type DirectorySource='ednevnik'|'formapoint';
type School={subject:string;name:string};
export type DirectoryPerson={
  subject:string;name:string;address:string;sourceEmail:string;
  kind:'ednevnik'|'staff'|'formapoint';schools:School[];
};

const id=z.string().min(1).max(200);
const address=z.string().trim().toLowerCase().email().max(254);
const authUser=z.object({
  id:z.uuid(),email:address.nullish(),email_confirmed_at:z.string().nullish(),banned_until:z.string().nullish(),
  user_metadata:z.object({name:z.string().optional(),full_name:z.string().optional()}).optional(),
});
const profile=z.object({id,auth_user_id:z.uuid().nullish(),name:z.string().nullish(),role:z.string().nullish(),access_role:z.string().nullish(),school_id:id.nullish()});
const role=z.object({user_id:id,school_id:id,role:z.string(),status:z.string()});
const school=z.object({id,name:z.string().trim().min(1).max(240)});
const staffRoles=new Set(['PRINCIPAL','EXPERT','TEACHER','HOMEROOM','DEPUTY','HOMEROOM_TEACHER','STAFF','ADMIN',
  'SCHOOL_ADMIN','MAIN_ADMIN','SUPER_ADMIN','REGISTRAR','PEDAGOGUE','PSYCHOLOGIST']);
const reserved=new Set(['admin','administrator','abuse','mailer-daemon','postmaster','webmaster','info','referada','promocije','narudzba']);
const normalize=(role:string)=>role.trim().toUpperCase();

export function directoryConfig(source:DirectorySource){
  const prefix=source.toUpperCase();
  const project=id.parse(process.env[prefix+'_SUPABASE_PROJECT_ID']);
  const endpoint=new URL(process.env[prefix+'_SUPABASE_URL']||'');
  const key=process.env[prefix+'_DIRECTORY_KEY'];
  const other=source==='ednevnik'?'FORMAPOINT':'EDNEVNIK';
  const otherEndpoint=process.env[other+'_SUPABASE_URL'];
  if(project===process.env[other+'_SUPABASE_PROJECT_ID'] ||
    (otherEndpoint && URL.canParse(otherEndpoint) && new URL(otherEndpoint).origin===endpoint.origin)){
    throw new Error('e-Dnevnik i FormaPoint moraju koristiti različite Supabase projekte.');
  }
  if(endpoint.protocol!=='https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !key){
    throw new Error('Potrebni su HTTPS Supabase URL i zaseban serverski ključ izvora.');
  }
  const organization=process.env[prefix+'_DIRECTORY_ORG']?.trim() || (source==='ednevnik'?'ŠkoleHR':'FormaPoint');
  const domain=process.env[prefix+'_MAIL_DOMAIN']?.trim().toLowerCase() || (source==='ednevnik'?'skolehr.xyz':'formapoint.online');
  if(!address.safeParse('test@'+domain).success || (source==='ednevnik' && domain!=='skolehr.xyz')){
    throw new Error('Poštanska domena izvora nije valjana.');
  }
  return {source,project,endpoint,key,domain,organization};
}
type DirectoryConfig=ReturnType<typeof directoryConfig>;

async function get(config:DirectoryConfig,path:string){
  const response=await fetch(new URL(path,config.endpoint),{headers:{apikey:config.key,...(config.key.startsWith('eyJ')?{Authorization:'Bearer '+config.key}:{})},
    redirect:'error',signal:AbortSignal.timeout(12000)});
  if(!response.ok) throw new Error(`Izvor nije dostupan (HTTP ${response.status}).`);
  return await response.json() as unknown;
}

const pageSize=100;
async function restTable<T>(config:DirectoryConfig,table:string,columns:string,order:string,schema:z.ZodType<T>){
  const result:T[]=[];
  for(let offset=0;;){
    const query=new URLSearchParams({select:columns,order,limit:String(pageSize),offset:String(offset)});
    const page=z.array(schema).parse(await get(config,`/rest/v1/${table}?${query}`));
    result.push(...page);
    if(page.length===0)return result;
    offset+=page.length;
  }
}

async function authUsers(config:DirectoryConfig){
  const result:z.infer<typeof authUser>[]=[];
  for(let page=1;;page++){
    const data=z.object({users:z.array(authUser)}).parse(await get(config,`/auth/v1/admin/users?page=${page}&per_page=${pageSize}`));
    result.push(...data.users);
    if(data.users.length<pageSize)return result;
  }
}

export function personAddress(source:DirectorySource,domain:string,sourceEmail:string,_subject:string,name?:string,preserveSourceAddress=true){
  const [local,origin]=sourceEmail.split('@');
  if(source==='ednevnik'){
    if(!['skolehr.xyz','eskole.me'].includes(origin) || reserved.has(local) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local))return;
    return local+'@'+domain;
  }
  // FormaPoint has already verified ownership of this source email. Its local part
  // does not confer administrator privileges; collision checks protect existing mailboxes.
  if(preserveSourceAddress && origin===domain && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(local))return sourceEmail;
  const words=(name||'').trim().split(/\s+/).filter(Boolean);
  const clean=(value:string)=>value.toLowerCase().replace(/đ/g,'d').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'.').replace(/^\.|\.$/g,'');
  const fullName=words.length>=2&&!words.some(word=>word.includes('@'))?words.map(clean).filter(Boolean).join('.'):'';
  const prefix=(fullName||clean(local)||'korisnik').slice(0,60).replace(/\.$/,'');
  return `${prefix}@${domain}`;
}

export async function directoryPeople(config:DirectoryConfig){
  const users=(await authUsers(config)).filter(user=>user.email && user.email_confirmed_at && !(user.banned_until && Date.parse(user.banned_until)>Date.now()));
  if(config.source==='formapoint'){
    return users.map(user=>({
      subject:user.id,name:(user.user_metadata?.full_name||user.user_metadata?.name||user.email!).trim().slice(0,240)||user.email!,
      address:personAddress('formapoint',config.domain,user.email!,user.id,user.user_metadata?.full_name||user.user_metadata?.name)!,
      sourceEmail:user.email!,kind:'formapoint' as const,schools:[],
    }));
  }
  const [profiles,roles,schools]=await Promise.all([
    restTable(config,'user_profiles','id,auth_user_id,name,role,access_role,school_id','id.asc',profile),
    restTable(config,'user_school_roles','user_id,school_id,role,status','user_id.asc,school_id.asc,role.asc',role),
    restTable(config,'schools','id,name','id.asc',school),
  ]);
  const byId=new Map(users.map(user=>[user.id,user]));
  const schoolsById=new Map(schools.map(item=>[item.id,{subject:item.id,name:item.name}]));
  const byProfile=new Map<string,z.infer<typeof role>[]>();
  for(const member of roles){
    const list=byProfile.get(member.user_id) || [];
    list.push(member);
    byProfile.set(member.user_id,list);
  }
  const people:DirectoryPerson[]=[];
  for(const item of profiles){
    const user=byId.get(item.auth_user_id??item.id);
    if(!user?.email)continue;
    const destination=personAddress('ednevnik',config.domain,user.email,user.id);
    if(!destination)continue;
    const members=byProfile.get(item.id)||[];
    const active=members.filter(member=>normalize(member.status)==='ACTIVE' && schoolsById.has(member.school_id));
    const activeRoles=active.map(member=>normalize(member.role));
    const profileRoles=[item.role,item.access_role].filter((value):value is string=>!!value).map(normalize).filter(value=>value!=='USER');
    const isStudent=activeRoles.includes('STUDENT') && [...activeRoles,...profileRoles].every(value=>value==='STUDENT');
    const isStaff=activeRoles.some(value=>staffRoles.has(value)) && [...activeRoles,...profileRoles].every(value=>staffRoles.has(value));
    if(!isStudent && !isStaff)continue;
    const ids=[...new Set(active.filter(member=>isStudent?normalize(member.role)==='STUDENT':staffRoles.has(normalize(member.role)))
      .map(member=>member.school_id))].sort();
    if(item.school_id && ids.includes(item.school_id))ids.splice(0,ids.length,item.school_id,...ids.filter(value=>value!==item.school_id));
    people.push({subject:user.id,name:item.name?.trim().slice(0,240)||user.email,address:destination,sourceEmail:user.email,
      kind:isStudent?'ednevnik':'staff',schools:ids.map(value=>schoolsById.get(value)!)});
  }
  return people;
}
