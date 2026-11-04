import { and, desc, eq, gt, lt, ne, sql } from 'drizzle-orm';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import {
  acceptances,
  customers,
  legalAnnouncements,
  legalNotices,
  loginLinks,
  sessions,
  signups,
  tenants,
  usageSamples,
} from './db/schema.js';
import {
  ACCEPTED,
  DOCUMENTS,
  type DocumentKey,
  isDocument,
  Legal,
  type LegalVersion,
  NOTICE_DAYS,
} from './legal.js';
import type { Mailer } from './mail.js';

const DAY = 86_400_000;

/** How long what is kept about customers (E-157); the TOM and the privacy policy say the same. */
export const RETENTION = {
  signupDays: 7,
  expiredLinkDays: 30,
  usageDays: 396,
  accountDays: 90,
} as const;

export class ComplianceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface ComplianceContext {
  config: Config;
  database: Database;
  mailer: Mailer;
  now: () => Date;
  legal?: Legal;
}

const day = (value: Date) => value.toLocaleDateString('de-DE', { timeZone: 'UTC' });

/**
 * Law and privacy of Lenipo Cloud (TL-105, E-157): the legal documents and their versions, what
 * customers accepted, announcements of new versions, and the deletion periods.
 */
export class Compliance {
  readonly legal: Legal;

  constructor(private readonly ctx: ComplianceContext) {
    this.legal = ctx.legal ?? new Legal();
  }

  private get db() {
    return this.ctx.database.db;
  }

  private url(path: string) {
    return `${this.ctx.config.CLOUD_URL.replace(/\/+$/, '')}${path}`;
  }

  async announced(): Promise<Set<string>> {
    const rows = await this.db.select().from(legalAnnouncements);
    return new Set(rows.map((row) => `${row.document}:${row.version}`));
  }

  async current(document: DocumentKey): Promise<LegalVersion> {
    return this.legal.current(document, this.ctx.now(), await this.announced());
  }

  async upcoming(document: DocumentKey): Promise<LegalVersion | undefined> {
    return this.legal.upcoming(document, this.ctx.now(), await this.announced());
  }

  /** The versions a sign-up accepts now: the contract and its annexes. */
  async toAccept(): Promise<Record<string, number>> {
    const announced = await this.announced();
    return Object.fromEntries(
      ACCEPTED.map((key) => [key, this.legal.current(key, this.ctx.now(), announced).version]),
    );
  }

  /** The latest version of each document a customer accepted. */
  async acceptedBy(customerId: string): Promise<Partial<Record<DocumentKey, number>>> {
    const rows = await this.db
      .select()
      .from(acceptances)
      .where(eq(acceptances.customerId, customerId))
      .orderBy(desc(acceptances.acceptedAt));
    const out: Partial<Record<DocumentKey, number>> = {};
    for (const row of rows) {
      if (isDocument(row.document) && out[row.document] === undefined) {
        out[row.document] = row.version;
      }
    }
    return out;
  }

  /**
   * Releases a new version for the date in its file. Contract documents need at least six weeks;
   * the customers get a mail with the date and their right to object.
   */
  async announce(document: string, version: number): Promise<{ effective: Date }> {
    if (!isDocument(document)) throw new ComplianceError(`Unknown document ${document}`);
    const entry = this.legal.version(document, version);
    if (!entry) throw new ComplianceError(`${document} has no version ${version} in legal/`);
    if (version === 1) throw new ComplianceError('Version 1 applies from the start');
    const now = this.ctx.now();
    if (
      DOCUMENTS[document].contract &&
      entry.effective.getTime() < now.getTime() + NOTICE_DAYS * DAY
    ) {
      throw new ComplianceError(
        `${document} ${version} takes effect on ${entry.effective.toISOString().slice(0, 10)}; a contract document needs ${NOTICE_DAYS} days of notice`,
      );
    }
    if (!DOCUMENTS[document].contract && entry.effective < now) {
      throw new ComplianceError('The date in the file has passed; give it a date from today on');
    }
    const [row] = await this.db
      .insert(legalAnnouncements)
      .values({ document, version, announcedAt: now, effectiveAt: entry.effective })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ComplianceError(`${document} ${version} is announced already`, 409);
    return { effective: entry.effective };
  }

  async announcements() {
    return this.db.select().from(legalAnnouncements).orderBy(desc(legalAnnouncements.announcedAt));
  }

  /** Every minute: announcement mails, then the deletion periods. */
  async tick() {
    await this.sendNotices();
    await this.purge();
  }

  /** Each customer with an instance gets one mail per announced version until it takes effect. */
  private async sendNotices() {
    const now = this.ctx.now();
    const pending = await this.db
      .select()
      .from(legalAnnouncements)
      .where(gt(legalAnnouncements.effectiveAt, now));
    for (const announcement of pending) {
      if (!isDocument(announcement.document)) continue;
      const entry = this.legal.version(announcement.document, announcement.version);
      if (!entry) continue;
      const due = await this.db
        .select({ id: customers.id, email: customers.email })
        .from(customers)
        .where(
          and(
            sql`exists (select 1 from ${tenants} where ${tenants.customerId} = ${customers.id} and ${tenants.status} <> 'deleted')`,
            sql`not exists (select 1 from ${legalNotices} where ${legalNotices.customerId} = ${customers.id} and ${legalNotices.document} = ${announcement.document} and ${legalNotices.version} = ${announcement.version})`,
          ),
        );
      for (const customer of due) {
        const [fresh] = await this.db
          .insert(legalNotices)
          .values({
            customerId: customer.id,
            document: announcement.document,
            version: announcement.version,
            sentAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (!fresh) continue;
        await this.ctx.mailer.send({
          to: customer.email,
          subject: `Lenipo Cloud: Neue Fassung „${entry.title}“ ab ${day(entry.effective)}`,
          text: this.noticeText(entry),
        });
      }
    }
  }

  private noticeText(entry: LegalVersion): string {
    const link = this.url(`/${entry.document}/v/${entry.version}`);
    const previous = this.url(`/${entry.document}`);
    const contract = DOCUMENTS[entry.document].contract;
    return `Guten Tag,

ab dem ${day(entry.effective)} gilt eine neue Fassung von „${entry.title}“ (Fassung ${entry.version}):

${link}

Die bisher gültige Fassung finden Sie unter ${previous}, alle Fassungen unter ${this.url('/rechtliches')}.
${
  contract
    ? `
Sind Sie mit der neuen Fassung nicht einverstanden, können Sie bis zum ${day(entry.effective)} widersprechen (eine Antwort auf diese Mail genügt) oder Ihren Vertrag zu diesem Tag im Kundenkonto kündigen. Widersprechen Sie nicht, gilt die neue Fassung ab dem ${day(entry.effective)}.
`
    : ''
}
Ihr Lenipo-Team`;
  }

  /** The fixed periods of the deletion concept (E-157). */
  async purge() {
    const now = this.ctx.now().getTime();
    const before = (days: number) => new Date(now - days * DAY);
    await this.db.delete(signups).where(lt(signups.createdAt, before(RETENTION.signupDays)));
    await this.db
      .delete(loginLinks)
      .where(lt(loginLinks.expiresAt, before(RETENTION.expiredLinkDays)));
    await this.db.delete(sessions).where(lt(sessions.expiresAt, before(RETENTION.expiredLinkDays)));
    await this.db
      .delete(usageSamples)
      .where(lt(usageSamples.day, before(RETENTION.usageDays).toISOString().slice(0, 10)));
    const gone = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          sql`not exists (select 1 from ${tenants} where ${tenants.customerId} = ${customers.id} and ${tenants.status} <> 'deleted')`,
          sql`greatest(${customers.createdAt}, coalesce((select max(${tenants.deletedAt}) from ${tenants} where ${tenants.customerId} = ${customers.id}), ${customers.createdAt})) < ${before(RETENTION.accountDays).toISOString()}::timestamptz`,
        ),
      );
    for (const customer of gone) await this.removeCustomer(customer.id, 'expired');
  }

  /** Whether the customer has nothing left running, so the account can go. */
  async canDelete(customerId: string): Promise<boolean> {
    const [live] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.customerId, customerId), ne(tenants.status, 'deleted')))
      .limit(1);
    return !live;
  }

  /** The customer deletes the account once every instance is deleted. */
  async deleteAccount(customerId: string) {
    if (!(await this.canDelete(customerId))) {
      throw new ComplianceError(
        'Solange eine Umgebung besteht, bleibt das Kundenkonto. Löschen Sie zuerst die Umgebungen.',
        409,
      );
    }
    await this.removeCustomer(customerId, 'requested');
  }

  /** Account, sessions, links, acceptances and what is left of deleted instances. */
  private async removeCustomer(customerId: string, why: 'requested' | 'expired') {
    const [customer] = await this.db.select().from(customers).where(eq(customers.id, customerId));
    if (!customer) return;
    await this.ctx.database.db.transaction(async (tx) => {
      await tx
        .delete(tenants)
        .where(and(eq(tenants.customerId, customerId), eq(tenants.status, 'deleted')));
      await tx.delete(customers).where(eq(customers.id, customerId));
    });
    await this.ctx.mailer.send({
      to: customer.email,
      subject: 'Lenipo Cloud: Ihr Kundenkonto ist gelöscht',
      text: `Guten Tag,

${
  why === 'requested'
    ? 'wie gewünscht haben wir Ihr Kundenkonto bei Lenipo Cloud gelöscht'
    : `${RETENTION.accountDays} Tage nach dem Löschen Ihrer letzten Umgebung haben wir Ihr Kundenkonto bei Lenipo Cloud gelöscht`
}: E-Mail-Adresse, Name, Zustimmungen und den Verlauf Ihrer Umgebungen. Rechnungen bewahrt unser Zahlungsdienstleister Stripe nach den gesetzlichen Fristen auf.

Ihr Lenipo-Team`,
    });
  }

  /** For the operator: which places in legal/ still need filling in. */
  openItems(): string[] {
    return this.legal.openItems();
  }

  /** For the operator: what the customer with this address accepted; null without such one. */
  async acceptancesByEmail(email: string) {
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.email, email.trim().toLowerCase()));
    return customer ? this.acceptancesOf(customer.id) : null;
  }

  /** Who accepted what, for evidence: newest first. */
  async acceptancesOf(customerId: string) {
    return this.db
      .select()
      .from(acceptances)
      .where(eq(acceptances.customerId, customerId))
      .orderBy(desc(acceptances.acceptedAt));
  }
}
