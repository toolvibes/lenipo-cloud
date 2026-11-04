import { randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { rm } from 'node:fs/promises';
import { and, desc, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { Compliance } from './compliance.js';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import {
  acceptances,
  customers,
  type JobKind,
  jobs,
  loginLinks,
  notices,
  sessions,
  signups,
  type TenantStatus,
  tenantEvents,
  tenants,
  usageSamples,
} from './db/schema.js';
import { fileKey, sealFile } from './files.js';
import { Fleet, type Job } from './fleet.js';
import type { Mailer } from './mail.js';
import { fromStripe, type Payments, type Subscription, verifyStripeSignature } from './payments.js';
import {
  type Interval,
  isInterval,
  isPlanKey,
  limitsOf,
  PLANS,
  type PlanKey,
  TRIAL_LIMITS,
} from './plans.js';
import type { Instance, Platform } from './platform/platform.js';
import { databaseName } from './platform/platform.js';
import { decrypt, encrypt, randomToken, sha256 } from './secrets.js';

const DAY = 86_400_000;
const SIGNUP_HOURS = 48;
const LOGIN_MINUTES = 30;
const SESSION_DAYS = 14;
const MAX_ATTEMPTS = 10;

/** 3–30 characters: lower-case letters, digits and hyphens, starting with a letter. */
export const SLUG = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const RESERVED = new Set([
  'www',
  'app',
  'api',
  'cloud',
  'admin',
  'status',
  'help',
  'hilfe',
  'support',
  'docs',
  'mail',
  'smtp',
  'imap',
  'ftp',
  'blog',
  'shop',
  'login',
  'auth',
  'sso',
  'demo',
  'test',
  'staging',
  'dev',
  'lenipo',
  'billing',
  'konto',
  'account',
]);
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface TenantSecrets {
  databasePassword: string;
  setupToken: string;
}

type TenantRow = typeof tenants.$inferSelect;

export interface Resolver {
  cname(host: string): Promise<string[]>;
  a(host: string): Promise<string[]>;
}

const systemResolver: Resolver = {
  cname: (host) => dns.resolveCname(host).catch(() => []),
  a: (host) => dns.resolve4(host).catch(() => []),
};

/**
 * The business of Lenipo Cloud (E-153): sign-up with confirmation, sign-in by link, the life of
 * an instance from provisioning through trial, cancellation and export to deletion.
 */
export class Cloud {
  /** Versions, backups, sleep, health and capacity of all instances (E-156). */
  readonly fleet: Fleet;
  /** Legal documents, acceptances, announcements and deletion periods (E-157). */
  readonly compliance: Compliance;

  constructor(
    private readonly config: Config,
    private readonly database: Database,
    private readonly platform: Platform,
    private readonly mailer: Mailer,
    private readonly payments: Payments,
    private readonly resolver: Resolver = systemResolver,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.compliance = new Compliance({ config, database, mailer, now });
    this.fleet = new Fleet({
      config,
      database,
      platform,
      mailer,
      now,
      event: (tenantId, kind, details) => this.event(tenantId, kind, details),
      enqueue: (tenantId, kind, payload) => this.enqueue(tenantId, kind, this.now(), payload),
      instance: (tenant, version) => this.instance(tenant, version),
      waitUntilLive: (base) => this.waitUntilLive(base),
    });
  }

  private get db() {
    return this.database.db;
  }

  private link(path: string, token: string) {
    return `${this.config.CLOUD_URL.replace(/\/+$/, '')}${path}?token=${encodeURIComponent(token)}`;
  }

  host(tenant: Pick<TenantRow, 'slug'>) {
    return `${tenant.slug}.${this.config.BASE_DOMAIN}`;
  }

  /** The address people use: the verified own domain, else the subdomain. */
  address(tenant: Pick<TenantRow, 'slug' | 'customDomain' | 'customDomainVerifiedAt'>) {
    return `https://${tenant.customDomain && tenant.customDomainVerifiedAt ? tenant.customDomain : this.host(tenant)}`;
  }

  private async event(tenantId: string, kind: string, details: Record<string, unknown> = {}) {
    await this.db.insert(tenantEvents).values({ tenantId, kind, details });
  }

  /** Sends a mail about an instance at most once per kind. */
  private async noticeOnce(tenant: TenantRow, kind: string, subject: string, text: string) {
    const [fresh] = await this.db
      .insert(notices)
      .values({ tenantId: tenant.id, kind })
      .onConflictDoNothing()
      .returning();
    if (!fresh) return;
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, tenant.customerId));
    if (customer) await this.mailer.send({ to: customer.email, subject, text });
  }

  // ---------------------------------------------------------------- sign-up

  async slugProblem(slug: string): Promise<string | null> {
    if (!SLUG.test(slug)) {
      return 'Der Name hat 3 bis 30 Zeichen: Kleinbuchstaben, Ziffern und Bindestriche, am Anfang ein Buchstabe.';
    }
    if (RESERVED.has(slug)) return 'Dieser Name ist reserviert.';
    const [taken] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.slug, slug), ne(tenants.status, 'deleted')));
    if (taken) return 'Dieser Name ist schon vergeben.';
    const [waiting] = await this.db
      .select({ id: signups.id })
      .from(signups)
      .where(
        and(eq(signups.slug, slug), isNull(signups.confirmedAt), gt(signups.expiresAt, this.now())),
      );
    return waiting ? 'Dieser Name ist schon vergeben.' : null;
  }

  /** Stores the sign-up and mails the confirmation link. */
  async signup(input: {
    email: string;
    name: string;
    slug: string;
    ip: string | null;
    /** Acts for a business, authority or association, not as a consumer (E-157). */
    business: boolean;
    /** Accepts the terms and the data processing agreement with its annexes. */
    terms: boolean;
  }) {
    const email = input.email.trim().toLowerCase();
    const slug = input.slug.trim().toLowerCase();
    const name = input.name.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new CloudError('Bitte eine gültige E-Mail-Adresse angeben.');
    }
    if (name.length < 2 || name.length > 80) {
      throw new CloudError('Bitte den Namen der Organisation angeben (2 bis 80 Zeichen).');
    }
    const problem = await this.slugProblem(slug);
    if (problem) throw new CloudError(problem);
    if (!input.business) {
      throw new CloudError(
        'Lenipo Cloud gibt es nur für Unternehmen, Behörden und Vereine. Bitte bestätigen Sie, dass Sie nicht als Verbraucher handeln.',
      );
    }
    if (!input.terms) {
      throw new CloudError(
        'Bitte stimmen Sie den AGB und dem Vertrag zur Auftragsverarbeitung zu.',
      );
    }
    if ((await this.fleet.capacity()).full) {
      throw new CloudError(
        'Wir sind gerade ausgebucht und richten weitere Server ein. Bitte versuchen Sie es in ein paar Tagen erneut.',
        503,
      );
    }
    const [recent] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(signups)
      .where(
        and(eq(signups.email, email), gt(signups.createdAt, new Date(this.now().getTime() - DAY))),
      );
    if ((recent?.count ?? 0) >= 5) {
      throw new CloudError('Zu viele Anmeldungen mit dieser Adresse; bitte morgen erneut.', 429);
    }
    const token = randomToken();
    await this.db.insert(signups).values({
      id: randomUUID(),
      email,
      name,
      slug,
      tokenHash: sha256(token),
      ip: input.ip,
      accepted: await this.compliance.toAccept(),
      createdAt: this.now(),
      expiresAt: new Date(this.now().getTime() + SIGNUP_HOURS * 3_600_000),
    });
    await this.mailer.send({
      to: email,
      subject: 'Lenipo: Bitte bestätigen Sie Ihre Anmeldung',
      text: `Guten Tag,

Sie haben Lenipo für „${name}“ unter ${slug}.${this.config.BASE_DOMAIN} angemeldet. Mit diesem Link bestätigen Sie die Anmeldung; danach richten wir Ihre Umgebung ein:

${this.link('/signup/confirm', token)}

Der Link gilt ${SIGNUP_HOURS} Stunden. Haben Sie sich nicht angemeldet, ignorieren Sie diese Mail einfach.

Ihr Lenipo-Team`,
    });
  }

  async pendingSignup(token: string) {
    const [row] = await this.db
      .select()
      .from(signups)
      .where(eq(signups.tokenHash, sha256(token)));
    if (!row || row.confirmedAt || row.expiresAt < this.now()) {
      throw new CloudError('Dieser Link ist nicht (mehr) gültig.', 410);
    }
    return row;
  }

  /** Creates customer and instance and starts the provisioning; returns the customer. */
  async confirmSignup(token: string): Promise<string> {
    const signup = await this.pendingSignup(token);
    return this.database.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(signups)
        .set({ confirmedAt: this.now() })
        .where(and(eq(signups.id, signup.id), isNull(signups.confirmedAt)))
        .returning();
      if (!claimed) throw new CloudError('Dieser Link wurde schon benutzt.', 410);
      const [taken] = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(and(eq(tenants.slug, signup.slug), ne(tenants.status, 'deleted')));
      if (taken) throw new CloudError('Dieser Name ist inzwischen vergeben.', 409);
      await tx
        .insert(customers)
        .values({ id: randomUUID(), email: signup.email, name: signup.name, createdAt: this.now() })
        .onConflictDoNothing();
      const [customer] = await tx.select().from(customers).where(eq(customers.email, signup.email));
      if (!customer) throw new Error('Customer missing');
      // What was accepted with the form, as evidence (E-157).
      const accepted = Object.entries(signup.accepted);
      if (accepted.length > 0) {
        await tx.insert(acceptances).values(
          accepted.map(([document, version]) => ({
            customerId: customer.id,
            document,
            version,
            acceptedAt: signup.createdAt,
            ip: signup.ip,
          })),
        );
      }
      const tenantId = randomUUID();
      const secrets: TenantSecrets = {
        databasePassword: randomToken(24),
        setupToken: randomToken(32),
      };
      await tx.insert(tenants).values({
        id: tenantId,
        customerId: customer.id,
        slug: signup.slug,
        name: signup.name,
        status: 'provisioning',
        secrets: encrypt(this.config.SECRET_KEY, secrets),
        trialEndsAt: new Date(this.now().getTime() + this.config.TRIAL_DAYS * DAY),
        createdAt: this.now(),
      });
      await tx
        .insert(jobs)
        .values({ id: randomUUID(), tenantId, kind: 'provision', runAfter: this.now() });
      await tx.insert(tenantEvents).values({ tenantId, kind: 'signed-up' });
      return customer.id;
    });
  }

  // ---------------------------------------------------------------- sign-in

  /** Mails a sign-in link if the address belongs to a customer; answers the same either way. */
  async requestLogin(emailInput: string) {
    const email = emailInput.trim().toLowerCase();
    const [customer] = await this.db.select().from(customers).where(eq(customers.email, email));
    if (!customer) return;
    const token = randomToken();
    await this.db.insert(loginLinks).values({
      tokenHash: sha256(token),
      customerId: customer.id,
      expiresAt: new Date(this.now().getTime() + LOGIN_MINUTES * 60_000),
    });
    await this.mailer.send({
      to: email,
      subject: 'Lenipo: Ihr Anmeldelink',
      text: `Mit diesem Link melden Sie sich bei Lenipo Cloud an (gültig ${LOGIN_MINUTES} Minuten, einmal):

${this.link('/login/confirm', token)}

Haben Sie keinen Link angefordert, ignorieren Sie diese Mail.`,
    });
  }

  async consumeLogin(token: string): Promise<string> {
    const [row] = await this.db
      .update(loginLinks)
      .set({ usedAt: this.now() })
      .where(
        and(
          eq(loginLinks.tokenHash, sha256(token)),
          isNull(loginLinks.usedAt),
          gt(loginLinks.expiresAt, this.now()),
        ),
      )
      .returning();
    if (!row) throw new CloudError('Dieser Link ist nicht (mehr) gültig.', 410);
    return row.customerId;
  }

  async createSession(customerId: string): Promise<{ id: string; expiresAt: Date }> {
    const id = randomToken();
    const expiresAt = new Date(this.now().getTime() + SESSION_DAYS * DAY);
    await this.db.insert(sessions).values({ idHash: sha256(id), customerId, expiresAt });
    return { id, expiresAt };
  }

  async customerOfSession(id: string | undefined) {
    if (!id) return null;
    const [row] = await this.db
      .select({ customer: customers })
      .from(sessions)
      .innerJoin(customers, eq(customers.id, sessions.customerId))
      .where(and(eq(sessions.idHash, sha256(id)), gt(sessions.expiresAt, this.now())));
    return row?.customer ?? null;
  }

  async endSession(id: string | undefined) {
    if (id) await this.db.delete(sessions).where(eq(sessions.idHash, sha256(id)));
  }

  // ---------------------------------------------------------------- the customer's instances

  async tenantsOf(customerId: string) {
    return this.db
      .select()
      .from(tenants)
      .where(and(eq(tenants.customerId, customerId), ne(tenants.status, 'deleted')))
      .orderBy(desc(tenants.createdAt));
  }

  async tenantOf(customerId: string, tenantId: string): Promise<TenantRow> {
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), eq(tenants.customerId, customerId)));
    if (!row || row.status === 'deleted') throw new CloudError('Nicht gefunden.', 404);
    return row;
  }

  async tenantByHost(host: string): Promise<TenantRow | null> {
    const suffix = `.${this.config.BASE_DOMAIN}`;
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(
        and(
          ne(tenants.status, 'deleted'),
          host.endsWith(suffix)
            ? eq(tenants.slug, host.slice(0, -suffix.length))
            : eq(tenants.customDomain, host),
        ),
      );
    return row ?? null;
  }

  /**
   * Cancels: in the trial at once, a booked plan at the end of the paid period (E-154). Then the
   * instance stops and the export follows.
   */
  async cancel(customerId: string, tenantId: string) {
    const tenant = await this.tenantOf(customerId, tenantId);
    if (tenant.status !== 'trial' && tenant.status !== 'active') {
      throw new CloudError('Diese Umgebung läuft nicht.', 409);
    }
    if (tenant.subscriptionId) {
      const subscription = await this.payments.cancelAtPeriodEnd(tenant.subscriptionId, true);
      await this.applySubscription(subscription);
      await this.event(tenant.id, 'cancel-requested', { at: subscription.periodEnd });
      return;
    }
    await this.db.update(tenants).set({ cancelAt: this.now() }).where(eq(tenants.id, tenant.id));
    await this.event(tenant.id, 'cancelled');
    await this.suspend(tenant, 'cancelled');
  }

  /** Deletes a stopped instance before its date, on the customer's request (E-157). */
  async deleteNow(customerId: string, tenantId: string) {
    const tenant = await this.tenantOf(customerId, tenantId);
    if (tenant.status !== 'suspended') {
      throw new CloudError(
        'Löschen lässt sich nur eine angehaltene Umgebung. Bitte zuerst kündigen.',
        409,
      );
    }
    await this.db
      .update(tenants)
      .set({ status: 'deleting', deleteAfter: this.now() })
      .where(and(eq(tenants.id, tenant.id), eq(tenants.status, 'suspended')));
    await this.event(tenant.id, 'delete-requested');
    await this.enqueue(tenant.id, 'delete');
  }

  /** Takes back a cancellation that has not yet taken effect. */
  async keep(customerId: string, tenantId: string) {
    const tenant = await this.tenantOf(customerId, tenantId);
    if (tenant.status !== 'active' || !tenant.subscriptionId || !tenant.cancelAt) {
      throw new CloudError('Hier ist keine Kündigung offen.', 409);
    }
    await this.applySubscription(
      await this.payments.cancelAtPeriodEnd(tenant.subscriptionId, false),
    );
    await this.event(tenant.id, 'cancel-withdrawn');
  }

  // ---------------------------------------------------------------- plans and payment (E-154)

  private priceId(plan: PlanKey, interval: Interval): string {
    const id = this.config.STRIPE_PRICES[`${plan}:${interval}`];
    if (!id) throw new CloudError('Dieser Tarif ist gerade nicht buchbar.', 503);
    return id;
  }

  private planOfPrice(priceId: string): { plan: PlanKey; interval: Interval } | null {
    for (const [key, id] of Object.entries(this.config.STRIPE_PRICES)) {
      const [plan = '', interval = ''] = key.split(':');
      if (id === priceId && isPlanKey(plan) && isInterval(interval)) return { plan, interval };
    }
    return null;
  }

  /** People who take a seat now, from the latest reading; at least one. */
  async seatsInUse(tenantId: string): Promise<number> {
    const [sample] = await this.db
      .select({ persons: usageSamples.persons })
      .from(usageSamples)
      .where(eq(usageSamples.tenantId, tenantId))
      .orderBy(desc(usageSamples.day))
      .limit(1);
    return Math.max(1, sample?.persons ?? 1);
  }

  private async checkSeats(tenantId: string, seats: number) {
    if (!Number.isInteger(seats) || seats < 1 || seats > 10_000) {
      throw new CloudError('Bitte eine Zahl von Plätzen zwischen 1 und 10.000 angeben.');
    }
    const used = await this.seatsInUse(tenantId);
    if (seats < used) {
      throw new CloudError(
        `In Ihrer Umgebung sind ${used} Personen aktiv. Deaktivieren Sie erst Personen oder buchen Sie mindestens ${used} Plätze.`,
      );
    }
  }

  /** The way to Stripe Checkout for an instance in its trial or stopped after it. */
  async checkout(
    customerId: string,
    tenantId: string,
    choice: { plan: string; interval: string; seats: number },
  ): Promise<string> {
    const tenant = await this.tenantOf(customerId, tenantId);
    const resumable =
      tenant.status === 'trial' ||
      (tenant.status === 'suspended' && tenant.suspendReason === 'trial-ended');
    if (!resumable || tenant.subscriptionId) {
      throw new CloudError('Für diese Umgebung lässt sich kein neuer Tarif buchen.', 409);
    }
    if (!isPlanKey(choice.plan) || !isInterval(choice.interval)) {
      throw new CloudError('Bitte Tarif und Laufzeit wählen.');
    }
    await this.checkSeats(tenant.id, choice.seats);
    const [customer] = await this.db.select().from(customers).where(eq(customers.id, customerId));
    if (!customer) throw new CloudError('Nicht gefunden.', 404);
    const base = this.config.CLOUD_URL.replace(/\/+$/, '');
    const { url } = await this.payments.checkout({
      tenantId: tenant.id,
      email: customer.email,
      customerId: customer.stripeCustomerId,
      priceId: this.priceId(choice.plan, choice.interval),
      seats: choice.seats,
      successUrl: `${base}/account?ok=checkout`,
      cancelUrl: `${base}/account`,
    });
    return url;
  }

  /** Payment method, invoices and billing address at Stripe. */
  async portal(customerId: string): Promise<string> {
    const [customer] = await this.db.select().from(customers).where(eq(customers.id, customerId));
    if (!customer?.stripeCustomerId) {
      throw new CloudError('Rechnungen gibt es, sobald ein Tarif gebucht ist.', 409);
    }
    return (
      await this.payments.portal(
        customer.stripeCustomerId,
        `${this.config.CLOUD_URL.replace(/\/+$/, '')}/account`,
      )
    ).url;
  }

  /** Another plan or number of seats; more is charged at once, less from the next period. */
  async changePlan(customerId: string, tenantId: string, choice: { plan: string; seats: number }) {
    const tenant = await this.tenantOf(customerId, tenantId);
    if (tenant.status !== 'active' || !tenant.subscriptionId || !tenant.plan || !tenant.seats) {
      throw new CloudError('Für diese Umgebung ist kein Tarif gebucht.', 409);
    }
    if (!isPlanKey(choice.plan)) throw new CloudError('Bitte einen Tarif wählen.');
    await this.checkSeats(tenant.id, choice.seats);
    const interval = isInterval(tenant.interval ?? '') ? (tenant.interval as Interval) : 'month';
    const before = PLANS[tenant.plan as PlanKey].price[interval] * tenant.seats;
    const after = PLANS[choice.plan].price[interval] * choice.seats;
    const subscription = await this.payments.change(tenant.subscriptionId, {
      priceId: this.priceId(choice.plan, interval),
      seats: choice.seats,
      prorate: after > before,
    });
    await this.applySubscription(subscription);
    await this.event(tenant.id, 'plan-changed', { plan: choice.plan, seats: choice.seats });
  }

  /** A webhook of Stripe; false when the signature does not fit. */
  async stripeWebhook(body: string, signature: string | undefined): Promise<boolean> {
    const secret = this.config.STRIPE_WEBHOOK_SECRET;
    if (!secret || !verifyStripeSignature(secret, signature, body, this.now().getTime())) {
      return false;
    }
    const event = JSON.parse(body) as { type: string; data: { object: Record<string, unknown> } };
    const object = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
        if (typeof object.subscription === 'string') {
          await this.applySubscription(await this.payments.subscription(object.subscription));
        }
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.applySubscription(fromStripe(object as never));
        break;
      case 'invoice.payment_failed': {
        const subscriptionId =
          typeof object.subscription === 'string'
            ? object.subscription
            : ((object.parent as { subscription_details?: { subscription?: string } } | undefined)
                ?.subscription_details?.subscription ?? null);
        const [tenant] = subscriptionId
          ? await this.db.select().from(tenants).where(eq(tenants.subscriptionId, subscriptionId))
          : [];
        if (tenant) {
          await this.noticeOnce(
            tenant,
            `payment-failed-${String(object.id)}`,
            'Lenipo: Zahlung fehlgeschlagen',
            `Die Zahlung für ${this.address(tenant)} hat nicht geklappt. Wir versuchen es in den nächsten Tagen erneut; bitte prüfen Sie Ihre Zahlungsdaten im Kundenkonto: ${this.config.CLOUD_URL}/account`,
          );
        }
        break;
      }
    }
    return true;
  }

  /** Takes over what Stripe says about a subscription; repeats change nothing. */
  async applySubscription(subscription: Subscription) {
    const [bySubscription] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.subscriptionId, subscription.id));
    const [byMetadata] =
      bySubscription || !subscription.tenantId
        ? []
        : await this.db.select().from(tenants).where(eq(tenants.id, subscription.tenantId));
    const tenant = bySubscription ?? byMetadata;
    if (!tenant || tenant.status === 'deleting' || tenant.status === 'deleted') return;
    const priced = this.planOfPrice(subscription.priceId);
    if (!priced) throw new Error(`Unknown price ${subscription.priceId}`);
    await this.db
      .update(customers)
      .set({ stripeCustomerId: subscription.customerId })
      .where(eq(customers.id, tenant.customerId));
    const running = ['active', 'trialing', 'past_due'].includes(subscription.status);
    const ended = ['canceled', 'unpaid', 'incomplete_expired'].includes(subscription.status);
    await this.db
      .update(tenants)
      .set({
        plan: priced.plan,
        interval: priced.interval,
        seats: subscription.seats,
        subscriptionId: subscription.id,
        periodEnd: subscription.periodEnd,
        paymentState: subscription.status === 'past_due' ? 'past_due' : 'ok',
        cancelAt: subscription.cancelAtPeriodEnd ? subscription.periodEnd : null,
      })
      .where(eq(tenants.id, tenant.id));
    if (running && (tenant.status === 'trial' || tenant.status === 'suspended')) {
      // Booked: the trial ends, a stopped instance comes back with its data.
      await this.db
        .update(tenants)
        .set({
          status: 'active',
          trialEndsAt: null,
          suspendedAt: null,
          suspendReason: null,
          deleteAfter: null,
        })
        .where(eq(tenants.id, tenant.id));
      await this.event(tenant.id, 'booked', { plan: priced.plan, seats: subscription.seats });
      if (tenant.status === 'suspended') await this.enqueue(tenant.id, 'resume');
      await this.noticeOnce(
        tenant,
        `booked-${subscription.id}`,
        'Lenipo: Danke für Ihre Buchung',
        `Ihr Tarif ${PLANS[priced.plan].name} mit ${subscription.seats} Plätzen für ${this.address(tenant)} ist aktiv. Rechnungen und Zahlungsdaten finden Sie im Kundenkonto: ${this.config.CLOUD_URL}/account`,
      );
    }
    if (running || tenant.status === 'trial' || tenant.status === 'active') {
      await this.enqueue(tenant.id, 'limits');
    }
    if (ended && tenant.status === 'active') {
      await this.event(tenant.id, 'subscription-ended', { status: subscription.status });
      await this.suspend({ ...tenant, status: 'active' }, 'cancelled');
    }
  }

  /** The frame of the plan in the instance (the product's provider limits). */
  private async pushLimits(tenant: TenantRow) {
    const limits =
      tenant.plan && isPlanKey(tenant.plan) && tenant.seats
        ? limitsOf(PLANS[tenant.plan], tenant.seats)
        : TRIAL_LIMITS;
    const secrets = decrypt<TenantSecrets>(this.config.SECRET_KEY, tenant.secrets);
    const response = await fetch(
      `${this.platform.instanceUrl(tenant.slug)}/api/v1/provider/limits`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${secrets.setupToken}`,
        },
        body: JSON.stringify(limits),
      },
    );
    if (!response.ok) throw new Error(`Limits: ${response.status} ${await response.text()}`);
  }

  /** What the instance uses, kept once a day. */
  private async readUsage(tenant: TenantRow) {
    const secrets = decrypt<TenantSecrets>(this.config.SECRET_KEY, tenant.secrets);
    const response = await fetch(
      `${this.platform.instanceUrl(tenant.slug)}/api/v1/provider/usage`,
      {
        headers: { authorization: `Bearer ${secrets.setupToken}` },
      },
    );
    if (!response.ok) throw new Error(`Usage: ${response.status} ${await response.text()}`);
    const usage = (await response.json()) as {
      persons: number;
      agents: number;
      storageMb: number;
      lastActiveAt?: string | null;
    };
    if (usage.lastActiveAt) {
      await this.db
        .update(tenants)
        .set({ lastActiveAt: new Date(usage.lastActiveAt) })
        .where(eq(tenants.id, tenant.id));
    }
    const day = this.now().toISOString().slice(0, 10);
    const values = {
      persons: usage.persons,
      agents: usage.agents,
      storageMb: usage.storageMb,
    };
    await this.db
      .insert(usageSamples)
      .values({ tenantId: tenant.id, day, ...values })
      .onConflictDoUpdate({ target: [usageSamples.tenantId, usageSamples.day], set: values });
  }

  async latestUsage(tenantId: string) {
    const [sample] = await this.db
      .select()
      .from(usageSamples)
      .where(eq(usageSamples.tenantId, tenantId))
      .orderBy(desc(usageSamples.day))
      .limit(1);
    return sample ?? null;
  }

  async setDomain(customerId: string, tenantId: string, input: string) {
    const tenant = await this.tenantOf(customerId, tenantId);
    const domain = input.trim().toLowerCase().replace(/\.$/, '');
    if (domain === '') {
      await this.db
        .update(tenants)
        .set({ customDomain: null, customDomainVerifiedAt: null })
        .where(eq(tenants.id, tenant.id));
      if (tenant.customDomainVerifiedAt) await this.enqueue(tenant.id, 'route');
      return;
    }
    if (!DOMAIN.test(domain) || domain.endsWith(`.${this.config.BASE_DOMAIN}`)) {
      throw new CloudError('Bitte eine eigene Domain wie projekte.beispiel.de angeben.');
    }
    const [taken] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(
        and(
          eq(tenants.customDomain, domain),
          ne(tenants.id, tenant.id),
          ne(tenants.status, 'deleted'),
        ),
      );
    if (taken) throw new CloudError('Diese Domain ist schon eingetragen.', 409);
    await this.db
      .update(tenants)
      .set({ customDomain: domain, customDomainVerifiedAt: null })
      .where(eq(tenants.id, tenant.id));
    if (tenant.customDomainVerifiedAt) await this.enqueue(tenant.id, 'route');
  }

  /** The domain counts once it points to the subdomain (CNAME) or its addresses (A). */
  async verifyDomain(customerId: string, tenantId: string): Promise<boolean> {
    const tenant = await this.tenantOf(customerId, tenantId);
    if (!tenant.customDomain) throw new CloudError('Keine eigene Domain eingetragen.');
    const target = this.host(tenant);
    const cnames = await this.resolver.cname(tenant.customDomain);
    let ok = cnames.some((name) => name.replace(/\.$/, '') === target);
    if (!ok) {
      const [own, expected] = await Promise.all([
        this.resolver.a(tenant.customDomain),
        this.resolver.a(target),
      ]);
      ok = own.length > 0 && own.every((address) => expected.includes(address));
    }
    if (!ok) return false;
    await this.db
      .update(tenants)
      .set({ customDomainVerifiedAt: this.now() })
      .where(eq(tenants.id, tenant.id));
    await this.event(tenant.id, 'domain-verified', { domain: tenant.customDomain });
    await this.enqueue(tenant.id, 'route');
    return true;
  }

  /** For Caddy's on-demand TLS: only verified domains of live instances get a certificate. */
  async tlsAllowed(domain: string): Promise<boolean> {
    const host = domain.toLowerCase();
    if (host === this.config.BASE_DOMAIN || host.endsWith(`.${this.config.BASE_DOMAIN}`)) {
      return (await this.tenantByHost(host)) !== null;
    }
    const tenant = await this.tenantByHost(host);
    return !!tenant?.customDomainVerifiedAt;
  }

  // ---------------------------------------------------------------- lifecycle

  private async enqueue(
    tenantId: string,
    kind: JobKind,
    runAfter = this.now(),
    payload: Record<string, unknown> = {},
  ) {
    await this.db
      .insert(jobs)
      .values({ id: randomUUID(), tenantId, kind, runAfter, payload, createdAt: this.now() });
  }

  private async suspend(tenant: TenantRow, reason: 'trial-ended' | 'cancelled') {
    const deleteAfter = new Date(this.now().getTime() + this.config.RETENTION_DAYS * DAY);
    await this.db
      .update(tenants)
      .set({
        status: 'suspended',
        suspendedAt: this.now(),
        suspendReason: reason,
        deleteAfter,
        sleepingAt: null,
        downSince: null,
        healthFailures: 0,
      })
      .where(eq(tenants.id, tenant.id));
    await this.event(tenant.id, 'suspended', { reason });
    await this.enqueue(tenant.id, 'suspend');
  }

  /** Reminders and deadlines; runs every minute. */
  async tick() {
    const now = this.now();
    const within = (days: number) => new Date(now.getTime() + days * DAY);
    const live = await this.db
      .select()
      .from(tenants)
      .where(inArray(tenants.status, ['trial', 'active', 'suspended'] satisfies TenantStatus[]));
    const today = now.toISOString().slice(0, 10);
    const counted = new Set(
      (
        await this.db
          .select({ tenantId: usageSamples.tenantId })
          .from(usageSamples)
          .where(eq(usageSamples.day, today))
      ).map((row) => row.tenantId),
    );
    const waiting = new Set(
      (
        await this.db
          .select({ tenantId: jobs.tenantId })
          .from(jobs)
          .where(and(eq(jobs.kind, 'usage'), eq(jobs.status, 'queued')))
      ).map((row) => row.tenantId),
    );
    for (const tenant of live) {
      // Once a day: what the running instances use.
      if (
        (tenant.status === 'trial' || tenant.status === 'active') &&
        !tenant.sleepingAt &&
        !counted.has(tenant.id) &&
        !waiting.has(tenant.id)
      ) {
        await this.enqueue(tenant.id, 'usage');
      }
      // A cancellation at the end of the period; Stripe's own message may come first.
      if (tenant.status === 'active' && tenant.cancelAt && tenant.cancelAt <= now) {
        await this.suspend(tenant, 'cancelled');
        continue;
      }
      if (tenant.status === 'trial' && tenant.trialEndsAt) {
        if (tenant.trialEndsAt <= now) {
          await this.suspend(tenant, 'trial-ended');
          continue;
        }
        // The nearest deadline first; one reminder per pass.
        for (const days of [1, 7]) {
          if (tenant.trialEndsAt <= within(days)) {
            await this.noticeOnce(
              tenant,
              `trial-${days}d`,
              `Lenipo: Ihre Testphase endet ${days === 1 ? 'morgen' : `in ${days} Tagen`}`,
              `Die Testphase von ${this.address(tenant)} endet am ${tenant.trialEndsAt.toLocaleDateString('de-DE')}. Danach halten wir die Umgebung an; Ihre Daten bleiben ${this.config.RETENTION_DAYS} Tage erhalten und stehen als Export bereit.

Ihr Konto: ${this.config.CLOUD_URL}/account`,
            );
            break;
          }
        }
      }
      if (tenant.status === 'suspended' && tenant.deleteAfter) {
        if (tenant.deleteAfter <= now) {
          await this.db
            .update(tenants)
            .set({ status: 'deleting' })
            .where(eq(tenants.id, tenant.id));
          await this.enqueue(tenant.id, 'delete');
          continue;
        }
        // The nearest deadline first; one reminder per pass.
        for (const days of [1, 7]) {
          if (tenant.deleteAfter <= within(days)) {
            await this.noticeOnce(
              tenant,
              `delete-${days}d`,
              `Lenipo: Ihre Daten werden ${days === 1 ? 'morgen' : `in ${days} Tagen`} gelöscht`,
              `Am ${tenant.deleteAfter.toLocaleDateString('de-DE')} löschen wir die Daten von ${this.address(tenant)} endgültig. Den Export laden Sie bis dahin in Ihrem Konto herunter: ${this.config.CLOUD_URL}/account`,
            );
            break;
          }
        }
      }
    }
    await this.fleet.tick();
    await this.compliance.tick();
  }

  /** Runs waiting jobs until none is due; returns how many ran. */
  async runJobs(): Promise<number> {
    let ran = 0;
    for (;;) {
      const job = await this.database.db.transaction(async (tx) => {
        // Never two jobs of one instance at once: none running, and the instance's lock is free.
        const [next] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.status, 'queued'),
              lte(jobs.runAfter, this.now()),
              sql`not exists (select 1 from jobs running where running.tenant_id = ${jobs.tenantId} and running.status = 'running')`,
              sql`pg_try_advisory_xact_lock(hashtext(${jobs.tenantId}::text))`,
            ),
          )
          .orderBy(jobs.runAfter, jobs.createdAt)
          .limit(1)
          .for('update', { skipLocked: true });
        if (!next) return null;
        await tx
          .update(jobs)
          .set({ attempts: next.attempts + 1, status: 'running' })
          .where(eq(jobs.id, next.id));
        return { ...next, attempts: next.attempts + 1 };
      });
      if (!job) return ran;
      ran += 1;
      try {
        await this.run(job);
        await this.db
          .update(jobs)
          .set({ status: 'done', finishedAt: this.now(), lastError: null })
          .where(eq(jobs.id, job.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const final = job.attempts >= MAX_ATTEMPTS;
        await this.db
          .update(jobs)
          .set({
            status: final ? 'failed' : 'queued',
            lastError: message.slice(0, 2000),
            runAfter: new Date(this.now().getTime() + Math.min(2 ** job.attempts, 60) * 60_000),
            finishedAt: final ? this.now() : null,
          })
          .where(eq(jobs.id, job.id));
        await this.event(job.tenantId, `${job.kind}-error`, { message, attempt: job.attempts });
        if (final && job.kind === 'provision') {
          await this.db
            .update(tenants)
            .set({ status: 'failed' })
            .where(eq(tenants.id, job.tenantId));
        }
        if (final) {
          const tenant = await this.load(job.tenantId);
          await this.fleet.alert(
            `job:${job.id}`,
            `Job ${job.kind} für ${tenant.slug} aufgegeben`,
            `Nach ${job.attempts} Versuchen: ${message}

Nachsehen: ops.js tenant ${tenant.slug}; neu versuchen: ops.js retry ${tenant.slug}`,
          );
        }
      }
    }
  }

  private async load(tenantId: string): Promise<TenantRow> {
    const [tenant] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new Error(`Tenant ${tenantId} missing`);
    return tenant;
  }

  /** What the platform needs: hosts, environment and the database password. */
  instance(tenant: TenantRow, version = this.fleet.versionOf(tenant)): Instance {
    const secrets = decrypt<TenantSecrets>(this.config.SECRET_KEY, tenant.secrets);
    const name = databaseName(tenant.slug);
    const custom =
      tenant.customDomain && tenant.customDomainVerifiedAt ? tenant.customDomain : null;
    const database = `postgres://${name}:${encodeURIComponent(secrets.databasePassword)}@${this.config.TENANT_DATABASE_HOST}/${name}`;
    return {
      slug: tenant.slug,
      image: this.fleet.imageOf(version),
      hosts: custom ? [custom, this.host(tenant)] : [this.host(tenant)],
      databasePassword: secrets.databasePassword,
      env: {
        DATABASE_URL: database,
        PUBLIC_URL: this.address(tenant),
        SETUP_TOKEN: secrets.setupToken,
        STORAGE_DRIVER: 'local',
        MAIL_FROM: this.config.TENANT_MAIL_FROM,
        ...(this.config.TENANT_SMTP_URL ? { SMTP_URL: this.config.TENANT_SMTP_URL } : {}),
      },
    };
  }

  private async run(job: Job & { tenantId: string }) {
    let tenant = await this.load(job.tenantId);
    // Deleted instances have no secrets left; only steps that need them decrypt.
    const instance = () => this.instance(tenant);
    switch (job.kind) {
      case 'provision':
        if (!tenant.version) {
          // New instances start with the version of the last finished rollout.
          const version = await this.fleet.currentVersion();
          await this.db.update(tenants).set({ version }).where(eq(tenants.id, tenant.id));
          tenant = { ...tenant, version };
        }
        return this.provision(tenant, instance());
      case 'route':
        // A sleeping instance gets its hosts when it wakes.
        if (tenant.status !== 'trial' && tenant.status !== 'active') return;
        if (tenant.sleepingAt) return;
        await this.platform.ensureInstance(instance());
        await this.platform.ensureRoute(instance());
        return;
      case 'suspend':
        await this.platform.removeRoute(tenant.slug);
        await this.platform.stopInstance(tenant.slug);
        await this.enqueue(tenant.id, 'export');
        return;
      case 'resume':
        await this.platform.ensureInstance(instance());
        await this.platform.ensureRoute(instance());
        return;
      case 'limits':
        if (tenant.status !== 'trial' && tenant.status !== 'active') return;
        // A plan booked during sleep: the instance wakes up for it.
        if (tenant.sleepingAt) {
          await this.fleet.wakeUp(tenant);
          tenant = await this.load(tenant.id);
        }
        return this.pushLimits(tenant);
      case 'usage':
        if (tenant.status !== 'trial' && tenant.status !== 'active') return;
        if (tenant.sleepingAt) return;
        return this.readUsage(tenant);
      case 'export':
        return this.export(tenant);
      case 'delete':
        return this.remove(tenant);
      default:
        return this.fleet.runJob(job, tenant);
    }
  }

  private async provision(tenant: TenantRow, instance: Instance) {
    if (tenant.status !== 'provisioning') return;
    await this.platform.ensureDatabase(instance);
    await this.platform.ensureInstance(instance);
    await this.platform.ensureRoute(instance);
    const base = this.platform.instanceUrl(tenant.slug);
    await this.waitUntilLive(base);
    const answer = await fetch(`${base}/api/v1/setup/provision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${instance.env.SETUP_TOKEN}`,
      },
      body: JSON.stringify({
        instanceName: tenant.name,
        admin: { email: await this.emailOf(tenant) },
      }),
    });
    // 409: set up in an earlier attempt, the welcome mail went out then.
    if (answer.status !== 409) {
      if (!answer.ok) {
        throw new Error(`Setup of the instance: ${answer.status} ${await answer.text()}`);
      }
      const { link } = (await answer.json()) as { link: string };
      await this.noticeOnce(
        tenant,
        'welcome',
        'Lenipo: Ihre Umgebung ist bereit',
        `Guten Tag,

Ihre Lenipo-Umgebung „${tenant.name}“ ist bereit: ${this.address(tenant)}

Legen Sie mit diesem Link Ihr Konto an; Sie verwalten Lenipo als Administrator und laden Ihr Team ein:

${link}

Die Testphase läuft bis ${tenant.trialEndsAt?.toLocaleDateString('de-DE') ?? '–'}. Ihr Kundenkonto (Domain, Kündigung, Export): ${this.config.CLOUD_URL}/account

Ihr Lenipo-Team`,
      );
    }
    await this.db
      .update(tenants)
      .set({ status: 'trial' })
      .where(and(eq(tenants.id, tenant.id), eq(tenants.status, 'provisioning')));
    // The trial's frame; a plan booked meanwhile replaces it with its own.
    await this.pushLimits(await this.load(tenant.id));
    await this.event(tenant.id, 'provisioned');
  }

  private async emailOf(tenant: TenantRow) {
    const [customer] = await this.db
      .select({ email: customers.email })
      .from(customers)
      .where(eq(customers.id, tenant.customerId));
    if (!customer) throw new Error('Customer missing');
    return customer.email;
  }

  private async waitUntilLive(base: string) {
    const until = Date.now() + 120_000;
    for (;;) {
      try {
        const response = await fetch(`${base}/api/v1/health/live`);
        if (response.ok) return;
      } catch {
        // Not up yet.
      }
      if (Date.now() > until) throw new Error('The instance did not come up within two minutes');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  private async export(tenant: TenantRow) {
    if (tenant.status !== 'suspended') return;
    const file = `${this.config.EXPORT_DIR}/${tenant.slug}-${tenant.id.slice(0, 8)}.zip.enc`;
    try {
      await this.platform.exportInstance(tenant.slug, `${file}.part`);
    } finally {
      await this.platform.stopInstance(tenant.slug);
    }
    // Encrypted at rest; the download decrypts it on the way out (E-157).
    await sealFile(`${file}.part`, file, fileKey(this.config.SECRET_KEY));
    await this.db
      .update(tenants)
      .set({ exportFile: file, exportReadyAt: this.now() })
      .where(eq(tenants.id, tenant.id));
    await this.event(tenant.id, 'exported');
    await this.noticeOnce(
      tenant,
      'export-ready',
      'Lenipo: Ihr Export steht bereit',
      `Ihre Umgebung ${this.address(tenant)} ist angehalten. Den vollständigen Export (eine Sicherung, die jede Lenipo-Instanz wiederherstellen kann) laden Sie in Ihrem Konto herunter: ${this.config.CLOUD_URL}/account

Am ${tenant.deleteAfter?.toLocaleDateString('de-DE') ?? '–'} löschen wir Ihre Daten und den Export endgültig.`,
    );
  }

  private async remove(tenant: TenantRow) {
    if (tenant.status !== 'deleting') return;
    await this.platform.removeRoute(tenant.slug);
    await this.platform.removeInstance(tenant.slug);
    await this.platform.dropDatabase(tenant.slug);
    if (tenant.exportFile) await rm(tenant.exportFile, { force: true });
    await this.fleet.removeBackups(tenant);
    await this.noticeOnce(
      tenant,
      'deleted',
      'Lenipo: Ihre Daten sind gelöscht',
      `Wir haben ${this.address(tenant)} mit allen Daten, Sicherungen und dem Export endgültig gelöscht. Danke, dass Sie Lenipo genutzt haben.`,
    );
    await this.db
      .update(tenants)
      .set({
        status: 'deleted',
        deletedAt: this.now(),
        exportFile: null,
        customDomain: null,
        secrets: '',
      })
      .where(eq(tenants.id, tenant.id));
    await this.event(tenant.id, 'deleted');
  }
}
