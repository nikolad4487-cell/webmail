import { readFile } from 'node:fs/promises';
import { db, transaction } from '../server/db.js';
import {runMigrationQueries} from './migration-diagnostics.js';
import {shortenExistingFormaPointAddresses} from '../server/formapoint-addresses.js';
import {queueFormaPointWelcome,deliverFormaPointWelcomes} from '../server/formapoint-welcome.js';
try {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL nije postavljen.");
  const schema=await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8');
  const native=await readFile(new URL('../migrations/001-native-mail.sql', import.meta.url),'utf8');
  const passwords=await readFile(new URL('../migrations/002-mail-passwords.sql', import.meta.url),'utf8');
  const provisioning=await readFile(new URL('../migrations/003-mailbox-provisioning.sql', import.meta.url),'utf8');
  const addresses=await readFile(new URL('../migrations/004-formapoint-original-address.sql', import.meta.url),'utf8');
  const welcomes=await readFile(new URL('../migrations/005-formapoint-welcome.sql', import.meta.url),'utf8');
  await transaction(async client=>{
    await runMigrationQueries(client,schema,native,passwords,provisioning,addresses,welcomes);
    const renamed=await shortenExistingFormaPointAddresses(client);
    const {rows:changed}=await client.query(`select u.id,m.id box from users u join mailboxes m on m.address=u.email
      where exists(select 1 from audits a where a.uid=u.id and a.action='formapoint.address.shorten' and a.at=transaction_timestamp())`);
    for(const row of changed)await queueFormaPointWelcome(client,row.id,row.box);
    if(renamed)console.log(`WebmailHR: shortened ${renamed} personal FormaPoint mailbox addresses; existing IDs and content preserved.`);
    const {rows:[check]}=await client.query(`select u.email=m.address and u.email='admin@formapoint.online' and u.role='user'
      and m.storage_kind='native' and not m.shared and m.active
      and exists(select 1 from grants g where g.box=m.id and g.uid=u.id) as verified
      from users u join mailboxes m on m.address=u.email
      where u.source_project='heseilggogbtmqeuwlku' and u.source_email='admin@formapoint.online'
        and exists(select 1 from audits a where a.uid=u.id and a.action='formapoint.address.correct'
          and a.at=transaction_timestamp())`);
    if(check){
      if(!check.verified)throw new Error('FormaPoint address correction verification failed');
      console.log('WebmailHR: FormaPoint original address and personal mailbox verified.');
    }
  });
  const notifications=await deliverFormaPointWelcomes();
  console.log('WebmailHR: FormaPoint welcome delivery totals '+JSON.stringify(notifications));
} finally { await db.end(); }
