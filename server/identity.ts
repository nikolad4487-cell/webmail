import {createHmac,randomInt} from 'node:crypto';
import {z} from 'zod';
import {demo,HttpError} from './mail.js';

export const authKind=z.enum(['local','staff','ednevnik','formapoint']);
export type ExternalKind='ednevnik'|'formapoint';
export const externalKind=(kind:string):kind is ExternalKind=>kind==='ednevnik'||kind==='formapoint';
export const isLinkedFormaPoint=(account:{auth_kind:string;source_project?:string|null;source_user_id?:string|null;source_email?:string|null})=>
  account.auth_kind==='formapoint'&&!!account.source_project&&!!account.source_user_id&&!!account.source_email;
export const sourceId=z.string().trim().min(1).max(200);
export const invalidLogin=()=>new HttpError(401,'Korisničko ime, adresa ili lozinka nije ispravna.');
const unavailable=()=>new HttpError(503,'Prijava putem odabranog sustava trenutačno nije dostupna.');

function project(kind:ExternalKind){
  const prefix=kind==='ednevnik'?'EDNEVNIK':'FORMAPOINT';
  const get=(key:string)=>process.env[prefix+'_'+key]?.trim() || '';
  const projectId=get('SUPABASE_PROJECT_ID');
  const other=kind==='ednevnik'?'FORMAPOINT':'EDNEVNIK';
  const url=safeUrl(get('SUPABASE_URL'));
  const otherUrl=process.env[other+'_SUPABASE_URL'];
  if(!projectId || projectId.length>200 || projectId===process.env[other+'_SUPABASE_PROJECT_ID']?.trim() ||
     (otherUrl && URL.canParse(otherUrl) && new URL(otherUrl).origin===url.origin)) throw unavailable();
  return {projectId,url,apiKey:get('SUPABASE_AUTH_KEY'),
    loginUrl:get('USERNAME_LOGIN_URL'),loginToken:get('USERNAME_LOGIN_TOKEN')};
}

function safeUrl(value:string){
  try {
    const url=new URL(value);
    if(url.username || url.password || url.search || url.hash) throw unavailable();
    if(url.protocol==='https:' || (demo && url.protocol==='http:' && url.hostname==='127.0.0.1')) return url;
  }catch{throw unavailable();}
  throw unavailable();
}

async function request(url:URL,body:object,headers:Record<string,string>,invalidStatuses:number[]){
  try {
    const response=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'application/json'},
      body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000)});
    if(invalidStatuses.includes(response.status)) throw invalidLogin();
    if(!response.ok) throw unavailable();
    return await response.json() as unknown;
  }catch(error){
    if(error instanceof HttpError) throw error;
    throw unavailable();
  }
}

export const projectIdFor=(kind:ExternalKind)=>project(kind).projectId;
export async function verifyStudent(username:string,password:string){
  const config=project('ednevnik');
  if(!config.loginUrl || !config.loginToken) throw unavailable();
  const result=await request(safeUrl(config.loginUrl),{username,password},{Authorization:'Bearer '+config.loginToken},[401,403]);
  const parsed=sourceId.safeParse((result as {user_id?:unknown}|null)?.user_id);
  if(!parsed.success) throw unavailable();
  return {projectId:config.projectId,userId:parsed.data};
}

async function formaPointSession(email:string,password:string,link:{projectId:string;userId:string}){
  const config=project('formapoint');
  if(!config.apiKey) throw unavailable();
  if(config.projectId!==link.projectId) throw invalidLogin();
  const result=await request(new URL('/auth/v1/token?grant_type=password',config.url),
    {email,password},{apikey:config.apiKey},[400,401,403]);
  const parsed=sourceId.safeParse((result as {user?:{id?:unknown}}|null)?.user?.id);
  if(!parsed.success || parsed.data!==link.userId) throw invalidLogin();
  return {config,result:result as {access_token?:unknown},link};
}
export async function verifyFormaPoint(email:string,password:string,link:{projectId:string;userId:string}){
  return (await formaPointSession(email,password,link)).link;
}
export async function changeFormaPointPassword(email:string,currentPassword:string,password:string,link:{projectId:string;userId:string}){
  const {config,result}=await formaPointSession(email,currentPassword,link);
  if(typeof result.access_token!=='string'||result.access_token.length<16)throw unavailable();
  let response:Response;
  try{
    response=await fetch(new URL('/auth/v1/user',config.url),{method:'PUT',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{apikey:config.apiKey,Authorization:'Bearer '+result.access_token,'Content-Type':'application/json'},
      body:JSON.stringify({password,current_password:currentPassword})});
  }catch{throw unavailable();}
  if([400,422].includes(response.status))throw new HttpError(400,'FormaPoint nije prihvatio novu lozinku. Unesite najmanje 8 znakova i pokušajte ponovno.');
  if([401,403].includes(response.status))throw invalidLogin();
  if(!response.ok)throw unavailable();
  let updated:unknown;try{updated=await response.json();}catch{throw unavailable();}
  const record=updated as {id?:unknown;user?:{id?:unknown}}|null;
  if((record?.user?.id??record?.id)!==link.userId)throw unavailable();
}

export function staffSecret(pin:string){
  const pepper=process.env.STAFF_PIN_PEPPER || (demo?'local-webmail-staff-test-only':undefined);
  if(!pepper || (!demo && pepper.length<32)) throw new HttpError(503,'Prijava djelatnika nije konfigurirana.');
  return createHmac('sha256',pepper).update(pin).digest('hex');
}
export const generatePin=()=>String(randomInt(100_000_000)).padStart(8,'0');
