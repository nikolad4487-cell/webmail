import {randomInt} from 'node:crypto';
import {z} from 'zod';
import {verifyPassword} from './db.js';
import {staffSecret,verifyFormaPoint} from './identity.js';

export const newPassword=z.string().min(8,'Lozinka mora imati najmanje 8 znakova.').max(512);
export const generatePassword=()=>String(randomInt(100_000_000)).padStart(8,'0');
export type PasswordAccount={auth_kind:string;password:string|null;password_scheme:string;source_project:string|null;source_user_id:string|null;source_email:string|null};
export async function matchesPassword(account:PasswordAccount,value:string){
  if(!account.password)return false;
  if(account.auth_kind==='staff'&&account.password_scheme==='staff_pin'){
    if(!/^[0-9]{8}$/.test(value))return false;
    return verifyPassword(staffSecret(value),account.password);
  }
  return verifyPassword(value,account.password);
}
export async function verifyCurrentPassword(account:PasswordAccount,value:string){
  if(account.auth_kind==='formapoint'&&!account.password){
    if(!account.source_email||!account.source_project||!account.source_user_id)return false;
    await verifyFormaPoint(account.source_email,value,{projectId:account.source_project,userId:account.source_user_id});
    return true;
  }
  return matchesPassword(account,value);
}
