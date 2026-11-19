-- Additive migration: existing mailboxes remain on IMAP/SMTP.
alter table mailboxes add column if not exists storage_kind text not null default 'imap'
  check(storage_kind in ('imap','native'));
create table if not exists native_messages(
  id serial primary key,
  box int not null references mailboxes on delete cascade,
  path text not null check(path in ('INBOX','Sent','Drafts','Junk','Trash')),
  delivery_hash text,
  envelope_from text,
  raw bytea not null,
  subject text not null,
  sender_name text,
  sender_address text,
  text_body text not null,
  message_id text,
  in_reply_to text,
  sent_at timestamptz not null,
  seen boolean not null default false,
  starred boolean not null default false,
  bytes int not null check(bytes>0),
  received_at timestamptz not null default now(),
  unique(box,delivery_hash)
);
create index if not exists native_messages_folder on native_messages(box,path,sent_at desc,id desc);
create table if not exists native_attachments(
  message int not null references native_messages on delete cascade,
  ordinal int not null check(ordinal>=0),
  filename text not null,
  content_type text not null,
  content bytea not null,
  primary key(message,ordinal)
);
-- Access uses WebmailHR sessions/grants through the server's DB role, never the Data API.
alter table native_messages enable row level security;
alter table native_attachments enable row level security;
revoke all on native_messages,native_attachments from public;
-- Conservative application budget; provider quotas must also be monitored in Mailjet.
create table if not exists native_send_attempts(
  id serial primary key,
  box int not null references mailboxes on delete cascade,
  recipients int not null check(recipients>0),
  at timestamptz not null default now(),
  status text not null default 'unknown' check(status in ('unknown','submitted','sandbox'))
);
create index if not exists native_send_attempts_at on native_send_attempts(at);
alter table native_send_attempts enable row level security;
revoke all on native_send_attempts from public;
