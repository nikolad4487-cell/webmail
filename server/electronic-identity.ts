import {createHash,timingSafeEqual} from 'node:crypto';
import type {Router} from 'express';
import {z} from 'zod';
import {db,transaction,hashPassword,verifyPassword} from './db.js';
import {HttpError} from './mail.js';
import {verifyStudent,staffSecret} from './identity.js';

export const identityPassword=(value:string)=>/^[A-Za-z0-9]{8}$/.test(value)&&/[A-Z]/.test(value)&&/[a-z]/.test(value)&&/[0-9]/.test(value);
export function issuanceTokenValid(header:string,expected:string|undefined){
 const token=/^Bearer ([^\s]+)$/.exec(header)?.[1];
 return !!expected&&!!token&&token.length<=4096&&timingSafeEqual(createHash('sha256').update(token).digest(),createHash('sha256').update(expected).digest());
}
export function setupElectronicIdentity(api:Router,services={database:db,transact:transaction,verifyStudent,hashPassword,verifyPassword,staffSecret}){
 api.post('/integrations/ednevnik/electronic-identity',async(req,res)=>{
  res.set('Cache-Control','no-store');
  const secret=process.env.EDNEVNIK_IDENTITY_ISSUANCE_TOKEN;
  if(!secret)throw new HttpError(503,'Povezivanje izdavanja identiteta nije konfigurirano.');
  if(!issuanceTokenValid(req.get('authorization')||'',secret))throw new HttpError(401,'Nevaljan serverski token.');
  const x=z.object({operation:z.enum(['prepare','activate']),user_id:z.uuid(),school_id:z.string().min(1).max(200),email:z.email(),relationship:z.enum(['STUDENT','TEACHER']),password:z.string().optional()}).strict().parse(req.body);
  const project=process.env.EDNEVNIK_SUPABASE_PROJECT_ID;
  const find=async(client:Pick<typeof db,'query'>)=>{
   const {rows}=await client.query(`select u.id,u.email,u.auth_kind from users u join directory_identities d on d.uid=u.id
    join directory_school_memberships sm on sm.uid=u.id join directory_schools s on s.school=sm.school
    join mailboxes m on m.address=u.email join grants g on g.uid=u.id and g.box=m.id
    left join directory_mailboxes dm on dm.uid=u.id and dm.box=m.id
    left join school_mail_identities si on si.uid=u.id and si.project=d.project and si.subject=d.subject
    where d.project=$1 and d.subject=$2 and s.project=$1 and s.subject=$3 and u.email=$4 and u.active and u.role='user'
    and (dm.ready or (m.storage_kind='native' and si.uid is not null and not si.disabled_by_sync and si.person_kind=case when $5='TEACHER' then 'teacher' else 'student' end)) and m.active and not m.shared and m.address=u.email`,[project,x.user_id,x.school_id,x.email,x.relationship]);
   if(rows.length!==1||rows[0].auth_kind!==(x.relationship==='STUDENT'?'ednevnik':'staff'))throw new HttpError(409,'Pokrenite postojeću sinkronizaciju imenika i dovršite dodjelu osobnog sandučića za ovaj Auth ID i školu.');
   return rows[0];
  };
  const account=await find(services.database);
  if(x.operation==='activate'){
   if(!x.password||!identityPassword(x.password))throw new HttpError(400,'Lozinka mora imati 8 znakova, veliko i malo slovo i znamenku.');
   if(x.relationship==='STUDENT'){
    const verified=await services.verifyStudent(x.email,x.password);
    if(verified.projectId!==project||verified.userId!==x.user_id)throw new HttpError(403,'Potvrđeni identitet se razlikuje od odabranog računa.');
   }
   const staffHash=x.relationship==='TEACHER'?await services.hashPassword(x.password):null;
   await services.transact(async client=>{
    await client.query('select id from users where id=$1 for update',[account.id]);
    await find(client);
    if(staffHash){
     const {rows:[saved]}=await client.query("update users set identity_password=true,password_scheme='scrypt',password=$2 where id=$1 returning password",[account.id,staffHash]);
     if(!saved||!await services.verifyPassword(x.password!,saved.password))throw new HttpError(503,'Lozinka WebmailHR-a nije potvrđena.');
    }
    if(staffHash)await client.query('update school_mail_identities set initial_password=null,issued_at=now() where uid=$1',[account.id]);
    await client.query('delete from sessions where uid=$1',[account.id]);
    await client.query('delete from resets where uid=$1',[account.id]);
   });
  }
  res.json({ready:true,user_id:x.user_id,school_id:x.school_id,email:x.email});
 });
}
