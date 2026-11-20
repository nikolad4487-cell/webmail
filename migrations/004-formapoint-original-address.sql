-- Correct the first imported, verified admin@formapoint.online personal account.
-- Keep the same account/mailbox IDs, passwords, grants, messages and attachments.
do $formapoint_address$
declare
  owner_row users%rowtype;
  box_row mailboxes%rowtype;
  previous constant text := 'admin.7b806f4df0c35d76@formapoint.online';
  original constant text := 'admin@formapoint.online';
begin
  select * into owner_row from users
    where email=previous and source_email=original and auth_kind='formapoint'
      and source_project='heseilggogbtmqeuwlku' and source_user_id is not null
    for update;
  if not found then return; end if;
  if not owner_row.active or owner_row.role<>'user' then
    raise exception 'FormaPoint address correction requires the original active personal user';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(original,0));
  if exists(select 1 from users where email=original and id<>owner_row.id)
    or exists(select 1 from mailboxes where address=original)
    or exists(select 1 from aliases where address in (original,previous))
    or exists(select 1 from senders where address in (original,previous)) then
    raise exception 'FormaPoint original address is already assigned';
  end if;
  select * into box_row from mailboxes where address=previous for update;
  if not found or box_row.org<>owner_row.org or box_row.shared or not box_row.active
    or box_row.storage_kind<>'native'
    or not exists(select 1 from grants where box=box_row.id and uid=owner_row.id)
    or exists(select 1 from grants where box=box_row.id and uid<>owner_row.id)
    or not exists(select 1 from domains where name='formapoint.online' and org=owner_row.org and mailbox_backend='native') then
    raise exception 'FormaPoint address correction requires the existing privately owned native mailbox';
  end if;
  update users set email=original where id=owner_row.id;
  update mailboxes set address=original where id=box_row.id;
  delete from sessions where uid=owner_row.id;
  insert into audits(uid,action,target) values(owner_row.id,'formapoint.address.correct',original);
end $formapoint_address$;
