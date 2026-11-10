import { bigint, char, index, jsonb, pgTable, primaryKey, text, timestamp, uuid, integer } from 'drizzle-orm/pg-core';

/** Mirrors migrations/0001_init.sql. The SQL file is authoritative (it carries RLS and triggers). */
export const cases = pgTable('cases', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  caseTypeKey: text('case_type_key').notNull(),
  caseTypeVersion: integer('case_type_version').notNull(),
  department: text('department').notNull(),
  state: text('state').notNull(),
  stateEnteredAt: timestamp('state_entered_at', { withTimezone: true }).notNull(),
  confidentiality: text('confidentiality').notNull(),
  fields: jsonb('fields').notNull().default({}),
  parties: jsonb('parties').notNull().default([]),
  artifacts: jsonb('artifacts').notNull().default([]),
  approvals: jsonb('approvals').notNull().default([]),
  actions: jsonb('actions').notNull().default([]),
  assignee: jsonb('assignee'),
  legalHold: jsonb('legal_hold'),
  parentCaseId: uuid('parent_case_id'),
  matterId: uuid('matter_id'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => [index('cases_tenant_idx').on(t.tenantId)]);

export const auditEvents = pgTable('audit_events', {
  tenantId: uuid('tenant_id').notNull(),
  caseId: uuid('case_id').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  type: text('type').notNull(),
  actorId: text('actor_id').notNull(),
  actorKind: text('actor_kind').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
  payload: jsonb('payload').notNull(),
  prevHash: char('prev_hash', { length: 64 }).notNull(),
  hash: char('hash', { length: 64 }).notNull(),
}, (t) => [primaryKey({ columns: [t.caseId, t.seq] })]);
