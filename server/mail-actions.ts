import type {ImapFlow} from 'imapflow';
import {transaction} from './db.js';
import {folder,HttpError,imap} from './mail.js';
import {isNative,nativePaths} from './native-mail.js';

export type MailLocation={id:number;path:string};
export type MailAction='trash'|'junk'|'inbox'|'read'|'unread'|'star'|'unstar'|'delete';
const unique=(items:MailLocation[])=>[...new Map(items.map(item=>[item.path+':'+item.id,item])).values()];
const isMove=(action:MailAction)=>['trash','junk','inbox'].includes(action);
export async function nativeBatch(address:string,action:MailAction,items:MailLocation[]){
 const messages=unique(items);
 return transaction(async c=>{
  // Same lock as receipt/budget accounting: deletion makes room immediately.
  await c.query("select pg_advisory_xact_lock(hashtext('webmailhr.native.storage'))");
  const {rows}=await c.query(`select n.id,n.path,n.bytes,n.box from native_messages n
   join mailboxes m on m.id=n.box
   join jsonb_to_recordset($2::jsonb) as wanted(id bigint,path text) on wanted.id=n.id and wanted.path=n.path
   where m.address=$1 and m.active for update of n`,[address,JSON.stringify(messages)]);
  if(rows.length!==messages.length)throw new HttpError(404,'Neke poruke više nisu dostupne. Osvježite popis.');
  if(action==='delete'&&rows.some(row=>!['Trash','Junk'].includes(row.path)))throw new HttpError(403,'Trajno brisanje dopušteno je samo iz Otpada i Neželjene pošte.');
  const ids=rows.map(row=>row.id);
  if(action==='delete')await c.query('delete from native_messages where id=any($1::int[])',[ids]);
  else{
   const column=isMove(action)?'path':['read','unread'].includes(action)?'seen':'starred';
   const value=isMove(action)?nativePaths[action]:['read','star'].includes(action);
   await c.query(`update native_messages set ${column}=$2 where id=any($1::int[])`,[ids,value]);
  }
  return {affected:rows.length,freedBytes:action==='delete'?rows.reduce((sum,row)=>sum+Number(row.bytes),0):0};
 });
}
export async function nativeEmpty(address:string,key:'trash'|'junk'){
 return transaction(async c=>{
  await c.query("select pg_advisory_xact_lock(hashtext('webmailhr.native.storage'))");
  const {rows}=await c.query(`delete from native_messages n using mailboxes m
   where n.box=m.id and m.address=$1 and m.active and n.path=$2 returning n.bytes`,[address,nativePaths[key]]);
  return {affected:rows.length,freedBytes:rows.reduce((sum,row)=>sum+Number(row.bytes),0)};
 });
}
export async function imapBatch(client:ImapFlow,action:MailAction,items:MailLocation[]){
 const groups=new Map<string,number[]>();
 for(const message of unique(items))groups.set(message.path,[...(groups.get(message.path)||[]),message.id]);
 const allowed=action==='delete'?(await Promise.all([folder(client,'trash'),folder(client,'junk')])).filter(Boolean):[];
 if(action==='delete'&&[...groups.keys()].some(path=>!allowed.includes(path)))throw new HttpError(403,'Trajno brisanje dopušteno je samo iz Otpada i Neželjene pošte.');
 if(action==='delete'&&!client.capabilities.has('UIDPLUS'))throw new HttpError(409,'Poslužitelj ne podržava sigurno brisanje odabranih poruka. Možete isprazniti cijelu mapu.');
 // Preflight every folder before mutation; never trust a UID without its folder.
 for(const [path,ids] of groups){
  const lock=await client.getMailboxLock(path);
  try{const found=await client.search({uid:ids.join(',')},{uid:true});if(!found||found.length!==ids.length)throw new HttpError(404,'Neke poruke više nisu dostupne. Osvježite popis.');}
  finally{lock.release();}
 }
 const destination=isMove(action)?await folder(client,action,true):undefined;
 let affected=0;
 try{
  for(const [path,ids] of groups){
   const lock=await client.getMailboxLock(path);
   try{
    const range=ids.join(',');
    const found=await client.search({uid:range},{uid:true});
    if(!found||found.length!==ids.length)throw new Error('stale selection');
    if(action==='delete'){if(!await client.messageDelete(range,{uid:true}))throw new Error('delete');}
    else if(destination){if(destination!==path&&!await client.messageMove(range,destination,{uid:true}))throw new Error('move');}
    else{
     const flag=['read','unread'].includes(action)?'\\Seen':'\\Flagged';
     const ok=['read','star'].includes(action)?await client.messageFlagsAdd(range,[flag],{uid:true}):await client.messageFlagsRemove(range,[flag],{uid:true});
     if(!ok)throw new Error('flag');
    }
    affected+=ids.length;
   }finally{lock.release();}
  }
 }catch{throw new HttpError(502,affected?'Dio poruka je obrađen. Osvježite popis prije ponovnog pokušaja.':'Obrada poruka nije potvrđena. Osvježite popis.');}
 return {affected,freedBytes:null};
}
export async function bulkMail(address:string,action:MailAction,items:MailLocation[]){
 return await isNative(address)?nativeBatch(address,action,items):imap(address,client=>imapBatch(client,action,items));
}
export async function emptyMail(address:string,key:'trash'|'junk'){
 if(await isNative(address))return nativeEmpty(address,key);
 return imap(address,client=>imapEmpty(client,key));
}
export async function imapEmpty(client:ImapFlow,key:'trash'|'junk'){
  const path=await folder(client,key);if(!path)return {affected:0,freedBytes:null};
  const lock=await client.getMailboxLock(path);
  try{
   const ids=await client.search({all:true},{uid:true});
   if(!ids||!ids.length)return {affected:0,freedBytes:null};
   // Whole-folder deletion is explicit; EXPUNGE may clear all deleted messages here.
   // All existing UIDs lie within this range. Avoid enormous command lines and
   // exclude new messages whose UID is above the snapshot's last UID.
   const min=ids.reduce((a,b)=>Math.min(a,b)),max=ids.reduce((a,b)=>Math.max(a,b));
   if(!await client.messageDelete(min+':'+max,{uid:true}))throw new HttpError(502,'Brisanje nije potvrđeno. Osvježite mapu.');
   return {affected:ids.length,freedBytes:null};
  }finally{lock.release();}
}
