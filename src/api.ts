export async function api<T>(url:string,method='GET',body?:unknown):Promise<T>{
  const response=await fetch('/api'+url,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.headers.get('content-type')?.includes('application/json')){
    throw new Error('API WebmailHR-a nije dostupan na ovoj adresi.');
  }
  const result=await response.json();
  if(!response.ok) throw new Error(result.error || 'Radnja nije uspjela.');
  return result as T;
}
export type Box={id:number;address:string;label:string;can_send:boolean;can_calendar:boolean;aliases:string[]};
export type Session={account:{name:string;email:string;role:string;auth_kind:string;shared_password:boolean};boxes:Box[];demo:boolean};
export type Contact={id:number;name:string;email:string};
export const toError=(e:unknown)=>e instanceof Error?e.message:'Radnja nije uspjela.';
export const initials=(name:string)=>name.split(/[ .@]+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();
