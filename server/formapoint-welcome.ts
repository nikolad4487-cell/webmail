import type {PoolClient} from 'pg';
import {db,transaction} from './db.js';
import {sendMailjet} from './mailjet.js';
import {HttpError} from './mail.js';

export function welcomeEnabled(){return process.env.FORMAPOINT_WELCOME_EMAIL==='1';}
export async function queueFormaPointWelcome(c:PoolClient,uid:number,box:number){
  if(!welcomeEnabled())return;
  const {rows:[u]}=await c.query('select * from users where id=$1 for update',[uid]);
  if(!u||!u.active||u.auth_kind!=='formapoint'||!u.source_email||u.password||
    (await c.query('select 1 from formapoint_welcomes where uid=$1',[uid])).rowCount)return;
  await c.query(`insert into formapoint_welcomes(uid,box,address,recipient,source_project,source_user_id)
    values($1,$2,$3,$4,$5,$6)`,[uid,box,u.email,u.source_email,u.source_project,u.source_user_id]);
}
export function formaPointWelcomeText(address:string){
  return `Poštovani,\n\nzahvaljujemo na registraciji na FormaPoint (https://www.formapoint.online). Za Vas smo kreirali poseban poštanski sandučić i e-mail adresu za buduću suradnju.\n\nPodaci za pristup sandučiću:\n\nAdresa za prijavu: https://www.webmailhr.com/\nKorisničko ime: ${address}\nLozinka: ona koju ste postavili za prijavu na FormaPoint\n\nS poštovanjem,\nFormaPoint Tim`;
}
export async function deliverFormaPointWelcomes(){
  if(!welcomeEnabled())return {sent:0,unknown:0,pending:0};
  if(process.env.MAILJET_SANDBOX!=='0')return {sent:0,unknown:0,pending:1};
  // Claim in a committed transaction before contacting the provider. An ambiguous
  // attempt is retained for operator review, never automatically emailed twice.
  const claimed=await transaction(async c=>{
    const {rows}=await c.query(`select w.*,u.password current_password,u.email current_address,u.source_email current_recipient,
      u.source_project current_project,u.source_user_id current_subject,u.auth_kind current_kind,
      u.active and m.active and not m.shared and m.storage_kind='native' active
      from formapoint_welcomes w join users u on u.id=w.uid join mailboxes m on m.id=w.box
      where w.status='pending' order by w.uid limit 10 for update of w,u skip locked`);
    const ready=[];
    for(const w of rows){
      if(!w.active||w.current_password!==null||w.current_kind!=='formapoint'||w.current_project!==w.source_project||w.current_subject!==w.source_user_id||w.current_address!==w.address||w.current_recipient!==w.recipient){
        await c.query("update formapoint_welcomes set status='cancelled' where uid=$1",[w.uid]);continue;
      }
      await c.query("update formapoint_welcomes set status='sending',attempted_at=now() where uid=$1",[w.uid]);ready.push(w);
    }
    return ready;
  });
  const counts={sent:0,unknown:0,pending:0};
  await Promise.all(claimed.map(async w=>{
    try{
      const receipt=await sendMailjet(w.address,{from:w.address,to:[w.recipient],subject:'Vaš FormaPoint poštanski sandučić',text:formaPointWelcomeText(w.address)},'FormaPoint Tim');
      if(receipt.sandbox)throw new HttpError(503,'Obavijest nije poslana u sandbox načinu.');
      await db.query("update formapoint_welcomes set status='sent',sent_at=now() where uid=$1 and status='sending'",[w.uid]);counts.sent++;
    }catch(error){
      // Quota/config failures happen before provider fetch and can safely wait.
      const pending=error instanceof HttpError&&[429,503].includes(error.status);
      await db.query("update formapoint_welcomes set status=$2 where uid=$1 and status='sending'",[w.uid,pending?'pending':'unknown']);
      counts[pending?'pending':'unknown']++;
    }
  }));
  return counts;
}
