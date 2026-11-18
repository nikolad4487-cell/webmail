import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';

export function mailboxKey(){
  const value=process.env.MAILBOX_ENCRYPTION_KEY?.trim() || '';
  if(!/^[0-9a-f]{64}$/i.test(value)) throw new Error('Potreban je MAILBOX_ENCRYPTION_KEY od 64 heksadecimalna znaka.');
  return Buffer.from(value,'hex');
}

export function sealMailboxPassword(address:string,password:string){
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',mailboxKey(),nonce);
  cipher.setAAD(Buffer.from(address));
  const encrypted=Buffer.concat([cipher.update(password,'utf8'),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
}

export function openMailboxPassword(address:string,sealed:string){
  const data=Buffer.from(sealed,'base64url');
  const decipher=createDecipheriv('aes-256-gcm',mailboxKey(),data.subarray(0,12));
  decipher.setAAD(Buffer.from(address));
  decipher.setAuthTag(data.subarray(12,28));
  return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');
}
