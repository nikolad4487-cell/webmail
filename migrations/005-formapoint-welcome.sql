create table if not exists formapoint_welcomes(
  uid int primary key references users on delete cascade,
  box int not null references mailboxes on delete cascade,
  address text not null,
  recipient text not null,
  source_project text not null,
  source_user_id text not null,
  status text not null default 'pending' check(status in ('pending','sending','sent','unknown','cancelled')),
  created_at timestamptz not null default now(),
  attempted_at timestamptz,
  sent_at timestamptz
);
alter table formapoint_welcomes enable row level security;
do $welcome_acl$ begin
  if exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    where c.oid='formapoint_welcomes'::regclass and a.grantee=0) then
    revoke all on formapoint_welcomes from public;
  end if;
  if current_user='prisma_migration' and exists(select 1 from pg_roles where rolname='prisma_application') then
    if not exists(select 1 from pg_policy where polrelid='formapoint_welcomes'::regclass and polname='webmailhr_prisma_server') then
      create policy webmailhr_prisma_server on formapoint_welcomes to prisma_application using(true) with check(true);
    end if;
  end if;
end $welcome_acl$;
