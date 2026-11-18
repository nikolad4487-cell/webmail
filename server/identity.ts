import {createHmac,randomInt} from 'node:crypto';
import {z} from 'zod';
import {demo,HttpError} from './mail';

export const authKind=z.enum(['local','staff','ednevnik','formapoint']);
export type ExternalKind='ednevnik'|'formapoint';
export const externalKind=(kind:string):kind is ExternalKind=>kind==='ednevnik'||kind==='formapoint';
export const sourceId=z.string().trim().min(1).max(200);
export const invalidLogin=()=>new HttpError(401,'Prijava nije uspjela. Provjerite lozinku i pokušajte s punom adresom svojeg WebmailHR računa.');
const unavailable=()=>new HttpError(503,'Prijava trenutačno nije dostupna.');

function project(kind:ExternalKind){
  const prefix=kind==='ednevnik'?'EDNEVNIK':'FORMAPOINT';
  const get=(key:string)=>process.env[prefix+'_'+key]?.trim() || '';
  const projectId=get('SUPABASE_PROJECT_ID');
  const other=kind==='ednevnik'?'FORMAPOINT':'EDNEVNIK';
  const url=safeUrl(get('SUPABASE_URL'));
  const otherUrl=process.env[other+'_SUPABASE_URL'];
  if(!projectId || projectId.length>200 || projectId===process.env[other+'_SUPABASE_PROJECT_ID']?.trim() ||
     (otherUrl && URL.canParse(otherUrl) && new URL(otherUrl).origin===url.origin)) throw unavailable();
  return {projectId,url,apiKey:get('SUPABASE_AUTH_KEY'),rpc:get('USERNAME_RPC'),resolverToken:get('USERNAME_RPC_TOKEN'),
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
export async function verifyExternal(kind:ExternalKind,username:string,password:string){
  const config=project(kind);
  if(config.loginUrl){
    if(!config.loginToken) throw unavailable();
    const result=await request(safeUrl(config.loginUrl),{username,password},{Authorization:'Bearer '+config.loginToken},[401,403,404]);
    const parsed=sourceId.safeParse((result as {user_id?:unknown}|null)?.user_id);
    if(!parsed.success) throw unavailable();
    return {projectId:config.projectId,userId:parsed.data};
  }
  if(!config.apiKey || !config.resolverToken || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(config.rpc)) throw unavailable();
  const resolved=await request(new URL('/rest/v1/rpc/'+config.rpc,config.url),{username},
    {apikey:config.apiKey,Authorization:'Bearer '+config.resolverToken},[]);
  if(resolved===null) throw invalidLogin();
  const identity=z.union([z.object({email:z.email(),phone:z.never().optional()}),
    z.object({phone:z.string().regex(/^\+?[0-9]{6,20}$/),email:z.never().optional()})]).safeParse(resolved);
  if(!identity.success) throw unavailable();
  const result=await request(new URL('/auth/v1/token?grant_type=password',config.url),
    {...identity.data,password},{apikey:config.apiKey},[400,401,403]);
  const parsed=sourceId.safeParse((result as {user?:{id?:unknown}}|null)?.user?.id);
  if(!parsed.success) throw unavailable();
  return {projectId:config.projectId,userId:parsed.data};
}

export function staffSecret(pin:string){
  const pepper=process.env.STAFF_PIN_PEPPER || (demo?'local-webmail-staff-test-only':undefined);
  if(!pepper || (!demo && pepper.length<32)) throw new HttpError(503,'Prijava djelatnika nije konfigurirana.');
  return createHmac('sha256',pepper).update(pin).digest('hex');
}
export const generatePin=()=>String(randomInt(100_000_000)).padStart(8,'0');
