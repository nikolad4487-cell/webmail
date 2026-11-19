#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/c9a3ac584fc624a11dad879dd4879e6292aca65765eb6073a6713e8cf9cb2ee0/contract';
import endContract from '../../snapshots/c9a3ac584fc624a11dad879dd4879e6292aca65765eb6073a6713e8cf9cb2ee0/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
  sql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'aliases',
        columns: [
          col('address', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('box', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('send_as', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
        ],
        constraints: [
          primaryKey(['address'], { name: 'aliases_pkey' }),
          checkExpression('aliases_address_check', sql`(address = lower(address))`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'audits',
        columns: [
          col('action', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('at', 'timestamptz(6)', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 6 } },
          }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('target', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('uid', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'], { name: 'audits_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'contacts',
        columns: [
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('uid', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'], { name: 'contacts_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'deliveries',
        columns: [
          col('at', 'timestamptz(6)', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 6 } },
          }),
          col('external_id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('list', 'text', {
            notNull: true,
            default: lit(''),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('recipient', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sender', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id'], { name: 'deliveries_pkey' }),
          checkExpression(
            'deliveries_status_check',
            sql`(status = ANY (ARRAY['pending'::text, 'submitted'::text, 'failed'::text, 'delivered'::text, 'unknown'::text]))`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'directory_identities',
        columns: [
          col('project', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('subject', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('uid', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['project', 'subject'], { name: 'directory_identities_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'directory_school_memberships',
        columns: [
          col('school', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('uid', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['uid', 'school'], { name: 'directory_school_memberships_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'directory_schools',
        columns: [
          col('project', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('school', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('subject', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['project', 'subject'], { name: 'directory_schools_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'domains',
        columns: [
          col('inbound', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('org', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('outbound', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
        ],
        constraints: [
          primaryKey(['name'], { name: 'domains_pkey' }),
          checkExpression('domains_name_check', sql`(name = lower(name))`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'events',
        columns: [
          col('attendees', 'text[]', {
            notNull: true,
            default: lit([]),
            codecRef: { codecId: 'pg/text@1', many: true },
          }),
          col('box', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('ends', 'timestamptz(6)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 6 } },
          }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('starts', 'timestamptz(6)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 6 } },
          }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('uid', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id'], { name: 'events_pkey' }),
          checkExpression('events_check', sql`(ends > starts)`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'grants',
        columns: [
          col('box', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('can_calendar', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('can_send', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('uid', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['uid', 'box'], { name: 'grants_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'login_limits',
        columns: [
          col('count', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('expires', 'timestamptz(6)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 6 } },
          }),
          col('key', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['key'], { name: 'login_limits_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'mailboxes',
        columns: [
          col('active', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('address', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('label', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('org', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('shared', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('storage_kind', 'text', {
            notNull: true,
            default: lit('imap'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('target_quota_gb', 'int4', {
            notNull: true,
            default: lit(15),
            codecRef: { codecId: 'pg/int4@1' },
          }),
        ],
        constraints: [
          primaryKey(['id'], { name: 'mailboxes_pkey' }),
          checkExpression('mailboxes_address_check', sql`(address = lower(address))`),
          checkExpression(
            'mailboxes_storage_kind_check',
            sql`(storage_kind = ANY (ARRAY['imap'::text, 'native'::text]))`,
          ),
          checkExpression('mailboxes_target_quota_gb_check', sql`(target_quota_gb > 0)`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'native_attachments',
        columns: [
          col('content', 'bytea', { notNull: true, codecRef: { codecId: 'pg/bytea@1' } }),
          col('content_type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('filename', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('message', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('ordinal', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['message', 'ordinal'], { name: 'native_attachments_pkey' }),
          checkExpression('native_attachments_ordinal_check', sql`(ordinal >= 0)`),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'native_messages',
        columns: [
          col('box', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('bytes', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('delivery_hash', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('envelope_from', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('in_reply_to', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('message_id', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('path', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('raw', 'bytea', { notNull: true, codecRef: { codecId: 'pg/bytea@1' } }),
          col('received_at', 'timestamptz(6)', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 6 } },
          }),
          col('seen', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('sender_address', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('sender_name', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('sent_at', 'timestamptz(6)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 6 } },
          }),
          col('starred', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('subject', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('text_body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id'], { name: 'native_messages_pkey' }),
          checkExpression('native_messages_bytes_check', sql`(bytes > 0)`),
          checkExpression(
            'native_messages_path_check',
            sql`(path = ANY (ARRAY['INBOX'::text, 'Sent'::text, 'Drafts'::text, 'Junk'::text, 'Trash'::text]))`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'native_send_attempts',
        columns: [
          col('at', 'timestamptz(6)', {
            notNull: true,
            default: fn(sql`now()`),
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 6 } },
          }),
          col('box', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('recipients', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('unknown'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [
          primaryKey(['id'], { name: 'native_send_attempts_pkey' }),
          checkExpression('native_send_attempts_recipients_check', sql`(recipients > 0)`),
          checkExpression(
            'native_send_attempts_status_check',
            sql`(status = ANY (ARRAY['unknown'::text, 'submitted'::text, 'sandbox'::text]))`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'organizations',
        columns: [
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'], { name: 'organizations_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'resets',
        columns: [
          col('expires', 'timestamptz(6)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 6 } },
          }),
          col('token', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('uid', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['token'], { name: 'resets_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'schools',
        columns: [
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('org', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'], { name: 'schools_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'senders',
        columns: [
          col('active', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('address', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('org', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('reply_to', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id'], { name: 'senders_pkey' }),
          checkExpression(
            'senders_kind_check',
            sql`(kind = ANY (ARRAY['order'::text, 'promotion'::text]))`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'sessions',
        columns: [
          col('expires', 'timestamptz(6)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 6 } },
          }),
          col('token', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('uid', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['token'], { name: 'sessions_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'subscriptions',
        columns: [
          col('allowed', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('list', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('recipient', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sender', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['sender', 'list', 'recipient'], { name: 'subscriptions_pkey' })],
      }),
      this.createTable({
        schema: 'public',
        table: 'users',
        columns: [
          col('active', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('auth_kind', 'text', {
            notNull: true,
            default: lit('local'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('org', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('password', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('recovery', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('role', 'text', {
            notNull: true,
            default: lit('user'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('school', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('source_email', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('source_project', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('source_user_id', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id'], { name: 'users_pkey' }),
          checkExpression(
            'users_auth_identity',
            sql`(((auth_kind = ANY (ARRAY['local'::text, 'staff'::text])) AND (source_project IS NULL) AND (source_user_id IS NULL)) OR ((auth_kind = ANY (ARRAY['ednevnik'::text, 'formapoint'::text])) AND (source_project IS NOT NULL) AND (source_user_id IS NOT NULL) AND (password IS NULL)))`,
          ),
          checkExpression(
            'users_auth_kind_check',
            sql`(auth_kind = ANY (ARRAY['local'::text, 'staff'::text, 'ednevnik'::text, 'formapoint'::text]))`,
          ),
          checkExpression(
            'users_check',
            sql`((source_email IS NULL) OR ((auth_kind = 'formapoint'::text) AND (source_email = lower(source_email))))`,
          ),
          checkExpression('users_email_check', sql`(email = lower(email))`),
          checkExpression(
            'users_role_check',
            sql`(role = ANY (ARRAY['root'::text, 'admin'::text, 'user'::text]))`,
          ),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'contacts',
        constraint: 'contacts_uid_email_key',
        columns: ['uid', 'email'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'deliveries',
        constraint: 'deliveries_sender_external_id_recipient_list_key',
        columns: ['sender', 'external_id', 'recipient', 'list'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'directory_identities',
        constraint: 'directory_identities_uid_key',
        columns: ['uid'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'directory_schools',
        constraint: 'directory_schools_school_key',
        columns: ['school'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'domains',
        constraint: 'domains_org_name_key',
        columns: ['org', 'name'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'mailboxes',
        constraint: 'mailboxes_address_key',
        columns: ['address'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'mailboxes',
        constraint: 'mailboxes_org_id_key',
        columns: ['org', 'id'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'native_messages',
        constraint: 'native_messages_box_delivery_hash_key',
        columns: ['box', 'delivery_hash'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'organizations',
        constraint: 'organizations_name_key',
        columns: ['name'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'schools',
        constraint: 'schools_org_id_key',
        columns: ['org', 'id'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'schools',
        constraint: 'schools_org_name_key',
        columns: ['org', 'name'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'senders',
        constraint: 'senders_address_key',
        columns: ['address'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'users',
        constraint: 'users_email_key',
        columns: ['email'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'deliveries',
        index: 'deliveries_order_event',
        columns: ['sender', 'external_id'],
        extras: { where: sql`(list = ''::text)`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'native_messages',
        index: 'native_messages_folder',
        columns: ['box', 'path', 'sent_at', 'id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'native_send_attempts',
        index: 'native_send_attempts_at',
        columns: ['at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'users',
        index: 'users_source_email',
        columns: ['source_email'],
        extras: { where: sql`(source_email IS NOT NULL)`, unique: true },
      }),
      this.createIndex({
        schema: 'public',
        table: 'users',
        index: 'users_source_identity',
        columns: ['source_project', 'source_user_id'],
        extras: { unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'aliases',
        foreignKey: {
          name: 'aliases_box_fkey',
          columns: ['box'],
          references: { schema: 'public', table: 'mailboxes', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'audits',
        foreignKey: {
          name: 'audits_uid_fkey',
          columns: ['uid'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'contacts',
        foreignKey: {
          name: 'contacts_uid_fkey',
          columns: ['uid'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'deliveries',
        foreignKey: {
          name: 'deliveries_sender_fkey',
          columns: ['sender'],
          references: { schema: 'public', table: 'senders', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'directory_identities',
        foreignKey: {
          name: 'directory_identities_uid_fkey',
          columns: ['uid'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'directory_school_memberships',
        foreignKey: {
          name: 'directory_school_memberships_school_fkey',
          columns: ['school'],
          references: { schema: 'public', table: 'schools', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'directory_school_memberships',
        foreignKey: {
          name: 'directory_school_memberships_uid_fkey',
          columns: ['uid'],
          references: { schema: 'public', table: 'directory_identities', columns: ['uid'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'directory_schools',
        foreignKey: {
          name: 'directory_schools_school_fkey',
          columns: ['school'],
          references: { schema: 'public', table: 'schools', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'domains',
        foreignKey: {
          name: 'domains_org_fkey',
          columns: ['org'],
          references: { schema: 'public', table: 'organizations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'events',
        foreignKey: {
          name: 'events_box_fkey',
          columns: ['box'],
          references: { schema: 'public', table: 'mailboxes', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'events',
        foreignKey: {
          name: 'events_uid_fkey',
          columns: ['uid'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'grants',
        foreignKey: {
          name: 'grants_box_fkey',
          columns: ['box'],
          references: { schema: 'public', table: 'mailboxes', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'grants',
        foreignKey: {
          name: 'grants_uid_fkey',
          columns: ['uid'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'mailboxes',
        foreignKey: {
          name: 'mailboxes_org_fkey',
          columns: ['org'],
          references: { schema: 'public', table: 'organizations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'native_attachments',
        foreignKey: {
          name: 'native_attachments_message_fkey',
          columns: ['message'],
          references: { schema: 'public', table: 'native_messages', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'native_messages',
        foreignKey: {
          name: 'native_messages_box_fkey',
          columns: ['box'],
          references: { schema: 'public', table: 'mailboxes', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'native_send_attempts',
        foreignKey: {
          name: 'native_send_attempts_box_fkey',
          columns: ['box'],
          references: { schema: 'public', table: 'mailboxes', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'resets',
        foreignKey: {
          name: 'resets_uid_fkey',
          columns: ['uid'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schools',
        foreignKey: {
          name: 'schools_org_fkey',
          columns: ['org'],
          references: { schema: 'public', table: 'organizations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'senders',
        foreignKey: {
          name: 'senders_org_fkey',
          columns: ['org'],
          references: { schema: 'public', table: 'organizations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'sessions',
        foreignKey: {
          name: 'sessions_uid_fkey',
          columns: ['uid'],
          references: { schema: 'public', table: 'users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'subscriptions',
        foreignKey: {
          name: 'subscriptions_sender_fkey',
          columns: ['sender'],
          references: { schema: 'public', table: 'senders', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'users',
        foreignKey: {
          name: 'users_org_fkey',
          columns: ['org'],
          references: { schema: 'public', table: 'organizations', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'users',
        foreignKey: {
          name: 'users_org_school_fkey',
          columns: ['org', 'school'],
          references: { schema: 'public', table: 'schools', columns: ['org', 'id'] },
        },
      }),
      this.enableRowLevelSecurity({ schema: 'public', table: 'native_attachments' }),
      this.enableRowLevelSecurity({ schema: 'public', table: 'native_messages' }),
      this.enableRowLevelSecurity({ schema: 'public', table: 'native_send_attempts' }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
