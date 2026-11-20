import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';

const url=process.env.TEST_MIGRATION_DATABASE_URL;
test('Prisma-style GRANT/REVOKE restrictions preserve migration and server-only RLS',{skip:!url},async()=>{
  const parsed=new URL(url);
  assert.ok(['127.0.0.1','localhost'].includes(parsed.hostname),'Use an isolated local test database');
  const c=new pg.Client({connectionString:url});await c.connect();
  try{
    assert.equal((await c.query("select to_regclass('users') as name")).rows[0].name,null,'Use an empty disposable DB');
    await c.query(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='prisma_migration') then create role prisma_migration; end if;
      if not exists(select 1 from pg_roles where rolname='prisma_application') then create role prisma_application; end if;
    end $$;
    grant usage,create on schema public to prisma_migration;
    grant usage on schema public to prisma_application;
    alter default privileges for role prisma_migration grant select,insert,update,delete on tables to prisma_application;
    alter default privileges for role prisma_migration grant usage,select on sequences to prisma_application;
    create function reject_acl_changes() returns event_trigger language plpgsql as $$ begin
      if tg_tag in ('GRANT','REVOKE') then raise insufficient_privilege using message='restricted superuser cannot grant or revoke privileges'; end if;
    end $$;
    create event trigger prisma_acl_restriction on ddl_command_start execute function reject_acl_changes();`);
    await c.query('set role prisma_migration');
    await c.query(await readFile(new URL('../../server/schema.sql',import.meta.url),'utf8'));
    const native=await readFile(new URL('../../migrations/001-native-mail.sql',import.meta.url),'utf8');
    await c.query(native);await c.query(native);
    const passwords=await readFile(new URL('../../migrations/002-mail-passwords.sql',import.meta.url),'utf8');
    await c.query(passwords);await c.query(passwords);
    const provisioning=await readFile(new URL('../../migrations/003-mailbox-provisioning.sql',import.meta.url),'utf8');
    await c.query(provisioning);await c.query(provisioning);
    assert.equal((await c.query("select exists(select 1 from information_schema.columns where table_name='users' and column_name='password_scheme') as ok")).rows[0].ok,true);
    await assert.rejects(c.query('revoke all on native_messages from public'),{code:'42501'});
    await c.query(`insert into organizations(id,name) values(1,'Test');
      insert into mailboxes(id,org,address,label,storage_kind) values(1,1,'demo@skolehr.xyz','Demo','native');
      insert into native_messages(box,path,raw,subject,text_body,sent_at,bytes)
      values(1,'INBOX',decode('01','hex'),'Test','Test',now(),1)`);
    assert.equal((await c.query(`select count(*)::int as n from pg_class c,
      lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid in ('native_messages'::regclass,'native_attachments'::regclass,'native_send_attempts'::regclass) and a.grantee=0`)).rows[0].n,0);
    await c.query('reset role');await c.query('set role prisma_application');
    assert.equal((await c.query('select count(*)::int as n from native_messages')).rows[0].n,1);
    await c.query('reset role');
    await c.query('alter event trigger prisma_acl_restriction disable');
    await c.query('grant select on native_messages to public');
    await c.query('alter event trigger prisma_acl_restriction enable');
    await c.query('set role prisma_migration');
    await assert.rejects(c.query(native),{code:'42501'}); // Fail closed when PUBLIC grants really exist.
  }finally{await c.end();}
});
