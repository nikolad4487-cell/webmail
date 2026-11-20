create table if not exists school_mail_identities(
 uid int primary key references users on delete cascade,
 project text not null,
 subject text not null,
 source_login text not null,
 person_kind text not null check(person_kind in ('student','parent','teacher')),
 oib text, dob date, gender text, valid_until date,
 school_data jsonb not null default '{}',
 initial_password text,
 issued_at timestamptz,
 seen_run text,
 last_synced_at timestamptz not null default now(),
 disabled_by_sync boolean not null default false,
 unique(project,subject)
);
create table if not exists school_mail_sync_state(
 project text primary key, page int not null default 0, run text not null,
 started_at timestamptz not null default now(),
 conflicts int not null default 0,
 updated_at timestamptz not null default now()
);
alter table school_mail_identities enable row level security;
alter table school_mail_sync_state enable row level security;
do $school_mail_acl$ begin
 if exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid in ('school_mail_identities'::regclass,'school_mail_sync_state'::regclass) and a.grantee=0) then
  revoke all on school_mail_identities,school_mail_sync_state from public;
 end if;
 if current_user='prisma_migration' and exists(select 1 from pg_roles where rolname='prisma_application') then
  if not exists(select 1 from pg_policy where polrelid='school_mail_identities'::regclass and polname='webmailhr_prisma_server') then
   create policy webmailhr_prisma_server on school_mail_identities to prisma_application using(true) with check(true);
  end if;
  if not exists(select 1 from pg_policy where polrelid='school_mail_sync_state'::regclass and polname='webmailhr_prisma_server') then
   create policy webmailhr_prisma_server on school_mail_sync_state to prisma_application using(true) with check(true);
  end if;
 end if;
end $school_mail_acl$;
