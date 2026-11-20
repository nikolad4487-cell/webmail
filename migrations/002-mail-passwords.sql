-- Existing staff PIN hashes remain valid until explicitly replaced.
do $mail_passwords$ begin
  if not exists(select 1 from pg_attribute where attrelid='users'::regclass and attname='password_scheme' and not attisdropped) then
    alter table users add column password_scheme text not null default 'scrypt' check(password_scheme in ('scrypt','staff_pin'));
    update users set password_scheme='staff_pin' where auth_kind='staff' and password is not null;
  end if;
end $mail_passwords$;
alter table users drop constraint if exists users_auth_identity;
alter table users add constraint users_auth_identity check (
  (auth_kind in ('local','staff') and source_project is null and source_user_id is null)
  or (auth_kind='ednevnik' and source_project is not null and source_user_id is not null and password is null)
  or (auth_kind='formapoint' and (
    (source_project is not null and source_user_id is not null)
    or (source_project is null and source_user_id is null and source_email is null and password is not null)
  ))
);
