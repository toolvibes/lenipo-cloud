import { sql } from 'drizzle-orm';
import {
  bigserial,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const created = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/** Who signed up; signs in with a link by e-mail. */
export const customers = pgTable(
  'customers',
  {
    id: uuid().primaryKey(),
    email: text().notNull(),
    name: text().notNull(),
    /** The customer at Stripe, from the first checkout. */
    stripeCustomerId: text(),
    createdAt: created(),
  },
  (table) => [uniqueIndex('customers_email_unique').on(table.email)],
);

/** A sign-up waiting for its confirmation link. */
export const signups = pgTable(
  'signups',
  {
    id: uuid().primaryKey(),
    email: text().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    tokenHash: text().notNull(),
    ip: text(),
    createdAt: created(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    confirmedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    uniqueIndex('signups_token_unique').on(table.tokenHash),
    index('signups_email_idx').on(table.email, table.createdAt),
  ],
);

/** One-time sign-in links. */
export const loginLinks = pgTable(
  'login_links',
  {
    tokenHash: text().primaryKey(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    createdAt: created(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
  },
  (table) => [index('login_links_customer_idx').on(table.customerId, table.createdAt)],
);

export const sessions = pgTable('sessions', {
  idHash: text().primaryKey(),
  customerId: uuid()
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  createdAt: created(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});

export const TENANT_STATUSES = [
  /** Being set up. */
  'provisioning',
  /** Running in its trial. */
  'trial',
  /** Running and paid. */
  'active',
  /** Stopped; data kept until deleteAfter. */
  'suspended',
  /** Being deleted. */
  'deleting',
  'deleted',
  /** Setting up failed for good; needs a person. */
  'failed',
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** One Lenipo instance of a customer (E-152). */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid().primaryKey(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    /** <slug>.<BASE_DOMAIN>, also the name of container, database and volume. */
    slug: text().notNull(),
    name: text().notNull(),
    status: text().$type<TenantStatus>().notNull(),
    /** Encrypted: database password and SETUP_TOKEN of the instance. */
    secrets: text().notNull(),
    customDomain: text(),
    customDomainVerifiedAt: timestamp({ withTimezone: true }),
    trialEndsAt: timestamp({ withTimezone: true }),
    /** When a cancellation takes effect. */
    cancelAt: timestamp({ withTimezone: true }),
    suspendedAt: timestamp({ withTimezone: true }),
    /** Why it was stopped: trial-ended or cancelled. */
    suspendReason: text(),
    deleteAfter: timestamp({ withTimezone: true }),
    /** The export after stopping, a file in EXPORT_DIR. */
    exportFile: text(),
    exportReadyAt: timestamp({ withTimezone: true }),
    /** The booked plan (E-154): team or business, month or year, seats; null in the trial. */
    plan: text(),
    interval: text(),
    seats: integer(),
    subscriptionId: text(),
    periodEnd: timestamp({ withTimezone: true }),
    /** ok, or past_due while Stripe retries a failed payment. */
    paymentState: text(),
    createdAt: created(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    // A deleted instance gives its name free again.
    uniqueIndex('tenants_slug_unique').on(table.slug).where(sql`${table.status} <> 'deleted'`),
    uniqueIndex('tenants_domain_unique')
      .on(table.customDomain)
      .where(sql`${table.status} <> 'deleted'`),
    index('tenants_customer_idx').on(table.customerId),
  ],
);

export const JOB_KINDS = [
  'provision',
  'suspend',
  'resume',
  'export',
  'delete',
  'route',
  /** Sets the plan's frame in the instance. */
  'limits',
  /** Reads what the instance uses. */
  'usage',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Work on an instance; the worker runs it to the end or retries it. */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text().$type<JobKind>().notNull(),
    /** queued, done or failed. */
    status: text().notNull().default('queued'),
    attempts: integer().notNull().default(0),
    runAfter: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastError: text(),
    createdAt: created(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (table) => [index('jobs_queue_idx').on(table.status, table.runAfter)],
);

/** Mails about an instance that go out once (reminders, notices). */
export const notices = pgTable(
  'notices',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    sentAt: created(),
  },
  (table) => [uniqueIndex('notices_unique').on(table.tenantId, table.kind)],
);

/** What happened to an instance, for support. */
export const tenantEvents = pgTable(
  'tenant_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    at: created(),
    kind: text().notNull(),
    details: jsonb().notNull().default({}),
  },
  (table) => [index('tenant_events_tenant_idx').on(table.tenantId, table.at)],
);

/** What an instance used, once a day (E-154). */
export const usageSamples = pgTable(
  'usage_samples',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    day: date().notNull(),
    persons: integer().notNull(),
    agents: integer().notNull(),
    storageMb: real().notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.day] })],
);
