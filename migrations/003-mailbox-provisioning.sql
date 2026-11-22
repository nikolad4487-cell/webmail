-- Existing IMAP/Zoho domains keep their backend. Infer only domains already using native mail.
do $mailbox_provisioning$ begin
  if not exists(select 1 from pg_attribute where attrelid='domains'::regclass and attname='mailbox_backend' and not attisdropped) then
    alter table domains add column mailbox_backend text not null default 'imap'
      check(mailbox_backend in ('imap','native'));
    update domains d set mailbox_backend='native'
      where d.name in ('skolehr.xyz','formapoint.online') and d.inbound and d.outbound
        and exists(select 1 from mailboxes m where m.org=d.org
          and split_part(m.address,'@',2)=d.name and m.active and not m.shared and m.storage_kind='native');
  end if;
end $mailbox_provisioning$;
