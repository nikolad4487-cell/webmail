// Does not create users, grant access, change DNS or copy legacy mail.
import {db,transaction} from '../server/db.js';
try{
  await transaction(async c=>{
    const {rows:[m]}=await c.query(`select m.* from mailboxes m join domains d
      on d.name=split_part(m.address,'@',2) and d.org=m.org
      where m.address='demo@skolehr.xyz' and m.active and not m.shared and d.inbound and d.outbound for update of m`);
    if(!m)throw new Error('U administraciji prvo dodajte aktivni osobni sandučić demo@skolehr.xyz na domeni njegove organizacije.');
    const {rows:grants}=await c.query('select g.*,u.active,u.email,u.org from grants g join users u on u.id=g.uid where g.box=$1',[m.id]);
    if(grants.length!==1||!grants[0].active||!grants[0].can_send||grants[0].org!==m.org)throw new Error('Potreban je točno jedan aktivni vlasnik iz iste organizacije s ovlasti slanja.');
    await c.query("update mailboxes set storage_kind='native' where id=$1",[m.id]);
    await c.query("insert into audits(action,target) values('mailbox.native.pilot',$1)",[String(m.id)]);
    console.log('demo@skolehr.xyz koristi PostgreSQL i Mailjet. Postojeća prijava i dodjela su sačuvane. MX nije promijenjen.');
  });
}finally{await db.end();}
