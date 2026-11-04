import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenants } from './db/schema.js';
import { signStripePayload } from './payments.js';
import { TRIAL_LIMITS } from './plans.js';
import { startTestCloud, type TestCloud } from './test/harness.js';

let t: TestCloud;
let cookie = '';
const DAY = 86_400_000;

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const post = (url: string, fields: Record<string, string> = {}) =>
  t.app.inject({
    method: 'POST',
    url,
    payload: form(fields),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  });
const tokenOf = (link: string) => new URL(link).searchParams.get('token') ?? '';
const tenantBySlug = async (slug: string) => {
  const [row] = await t.database.db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!row) throw new Error(`No tenant ${slug}`);
  return row;
};
const advance = (days: number) => {
  t.clock.now = new Date(t.clock.now.getTime() + days * DAY);
};
const lastMailTo = (address: string) => t.mailer.sent.findLast((mail) => mail.to === address);

/** Stripe calling the webhook, signed as Stripe signs. */
const webhook = (type: string, object: unknown, secret = 'whsec_test') => {
  const body = JSON.stringify({ id: `evt_${type}`, type, data: { object } });
  return t.app.inject({
    method: 'POST',
    url: '/stripe/webhook',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signStripePayload(secret, body, t.clock.now.getTime()),
    },
  });
};

/** A subscription object as the Stripe API sends it. */
const stripeSubscription = (id: string, overrides: Record<string, unknown> = {}) => {
  const sub = t.payments.subscriptions.get(id);
  if (!sub) throw new Error(`No subscription ${id}`);
  return {
    id: sub.id,
    customer: sub.customerId,
    status: sub.status,
    cancel_at_period_end: sub.cancelAtPeriodEnd,
    metadata: { tenantId: sub.tenantId },
    items: {
      data: [
        {
          id: 'si_1',
          quantity: sub.seats,
          current_period_end: Math.floor(sub.periodEnd.getTime() / 1000),
          price: { id: sub.priceId },
        },
      ],
    },
    ...overrides,
  };
};

async function signUp(email: string, slug: string) {
  await post('/signup', { business: 'on', terms: 'on', email, name: `Firma ${slug}`, slug });
  const confirmed = await post('/signup/confirm', { token: tokenOf(t.mailer.linkTo(email)) });
  cookie = String(confirmed.headers['set-cookie']).split(';')[0] ?? '';
  await t.cloud.runJobs();
  return tenantBySlug(slug);
}

beforeAll(async () => {
  t = await startTestCloud();
});

afterAll(async () => {
  await t?.close();
});

describe('plans and payment (TL-103)', () => {
  it('gives the trial its frame and counts what is used', async () => {
    const firma = await signUp('anna@firma.example', 'firma');
    // Support is the address of the service until a portal is configured (TL-106).
    expect(t.limits.get('firma')).toEqual({
      ...TRIAL_LIMITS,
      supportUrl: 'mailto:support@lenipo.de',
    });
    t.usage.set('firma', { persons: 4, agents: 1, storageMb: 120 });
    await t.cloud.tick();
    await t.cloud.runJobs();
    expect(await t.cloud.seatsInUse(firma.id)).toBe(4);
    // Once a day only.
    await t.cloud.tick();
    expect(await t.cloud.runJobs()).toBe(0);
  });

  it('books a plan through Stripe Checkout with at least the seats in use', async () => {
    const firma = await tenantBySlug('firma');
    const few = await post(`/account/tenants/${firma.id}/checkout`, {
      plan: 'team',
      interval: 'year',
      seats: '3',
    });
    expect(few.statusCode).toBe(400);
    expect(few.body).toContain('4 Personen aktiv');
    const checkout = await post(`/account/tenants/${firma.id}/checkout`, {
      plan: 'team',
      interval: 'year',
      seats: '5',
    });
    expect(checkout.headers.location).toBe('https://checkout.stripe.test/1');
    expect(t.payments.checkouts.at(-1)).toMatchObject({
      tenantId: firma.id,
      email: 'anna@firma.example',
      customerId: null,
      priceId: 'price_team_year',
      seats: 5,
    });
  });

  it('activates the plan when Stripe reports the payment, signed', async () => {
    const subscription = t.payments.complete('year');
    expect(
      (
        await webhook(
          'checkout.session.completed',
          { subscription: subscription.id },
          'whsec_fremd',
        )
      ).statusCode,
    ).toBe(400);
    const ok = await webhook('checkout.session.completed', {
      id: 'cs_1',
      subscription: subscription.id,
    });
    expect(ok.statusCode).toBe(200);
    const firma = await tenantBySlug('firma');
    expect(firma).toMatchObject({
      status: 'active',
      plan: 'team',
      interval: 'year',
      seats: 5,
      subscriptionId: subscription.id,
      trialEndsAt: null,
      paymentState: 'ok',
    });
    expect(lastMailTo('anna@firma.example')?.subject).toBe('Lenipo: Danke für Ihre Buchung');
    await t.cloud.runJobs();
    expect(t.limits.get('firma')).toEqual({
      plan: 'Team',
      persons: 5,
      agents: 2,
      storageMb: 10_000,
      modules: null,
      serviceDesk: false,
      requestsPerMinute: { people: 600, tokens: 300, anonymous: 120 },
      supportUrl: 'mailto:support@lenipo.de',
    });
    // The same message again changes nothing.
    await webhook('checkout.session.completed', { id: 'cs_1', subscription: subscription.id });
    expect(
      t.mailer.sent.filter((mail) => mail.subject === 'Lenipo: Danke für Ihre Buchung'),
    ).toHaveLength(1);
    const account = await t.app.inject({ method: 'GET', url: '/account', headers: { cookie } });
    expect(account.body).toContain('Tarif Team, 5 Plätze (4 belegt), jährlich');
    expect(account.body).toContain('Zahlungsdaten und Rechnungen');
    expect(account.body).toContain('je Platz und Monat ohne Umsatzsteuer (§ 19 UStG)');
    const portal = await post('/account/billing');
    expect(portal.headers.location).toBe(`https://billing.stripe.test/${subscription.customerId}`);
  });

  it('charges more at once and less from the next period', async () => {
    const firma = await tenantBySlug('firma');
    await post(`/account/tenants/${firma.id}/plan`, { plan: 'business', seats: '8' });
    await post(`/account/tenants/${firma.id}/plan`, { plan: 'team', seats: '6' });
    expect(
      t.payments.changes.map(({ priceId, seats, prorate }) => [priceId, seats, prorate]),
    ).toEqual([
      ['price_business_year', 8, true],
      ['price_team_year', 6, false],
    ]);
    expect(
      (await post(`/account/tenants/${firma.id}/plan`, { plan: 'team', seats: '2' })).statusCode,
    ).toBe(400);
    await t.cloud.runJobs();
    expect(t.limits.get('firma')).toMatchObject({ plan: 'Team', persons: 6, storageMb: 11_000 });
  });

  it('cancels at the end of the period and can take it back', async () => {
    const firma = await tenantBySlug('firma');
    await post(`/account/tenants/${firma.id}/cancel`);
    const cancelled = await tenantBySlug('firma');
    expect(cancelled.status).toBe('active');
    expect(cancelled.cancelAt?.toISOString()).toBe(cancelled.periodEnd?.toISOString());
    await post(`/account/tenants/${firma.id}/keep`);
    expect((await tenantBySlug('firma')).cancelAt).toBeNull();

    await webhook('invoice.payment_failed', { id: 'in_1', subscription: firma.subscriptionId });
    expect(lastMailTo('anna@firma.example')?.subject).toBe('Lenipo: Zahlung fehlgeschlagen');
    await webhook(
      'customer.subscription.updated',
      stripeSubscription(firma.subscriptionId ?? '', { status: 'past_due' }),
    );
    expect((await tenantBySlug('firma')).paymentState).toBe('past_due');

    await post(`/account/tenants/${firma.id}/cancel`);
    advance(366);
    await t.cloud.tick();
    expect(await tenantBySlug('firma')).toMatchObject({
      status: 'suspended',
      suspendReason: 'cancelled',
    });
  });

  it('brings an instance back with its data when booked after the trial', async () => {
    const neu = await signUp('ben@neu.example', 'neu');
    advance(31);
    await t.cloud.tick();
    await t.cloud.runJobs();
    expect(await tenantBySlug('neu')).toMatchObject({
      status: 'suspended',
      suspendReason: 'trial-ended',
    });
    expect(t.platform.state.get('neu')).toMatchObject({ container: 'stopped', hosts: [] });
    // A month later the session is gone; sign in by link.
    await post('/login', { email: 'ben@neu.example' });
    const login = await post('/login/confirm', {
      token: tokenOf(t.mailer.linkTo('ben@neu.example')),
    });
    cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    const checkout = await post(`/account/tenants/${neu.id}/checkout`, {
      plan: 'business',
      interval: 'month',
      seats: '3',
    });
    expect(checkout.headers.location).toBe('https://checkout.stripe.test/2');
    const subscription = t.payments.complete('month');
    await webhook('customer.subscription.created', stripeSubscription(subscription.id));
    expect(await tenantBySlug('neu')).toMatchObject({
      status: 'active',
      plan: 'business',
      deleteAfter: null,
    });
    await t.cloud.runJobs();
    expect(t.platform.state.get('neu')).toMatchObject({
      container: 'running',
      hosts: ['neu.lenipo.test'],
    });
    expect(t.limits.get('neu')).toMatchObject({ plan: 'Business', persons: 3, serviceDesk: true });

    // Stripe gives up on the payments: the instance stops like after a cancellation.
    await webhook(
      'customer.subscription.deleted',
      stripeSubscription(subscription.id, { status: 'canceled' }),
    );
    expect((await tenantBySlug('neu')).status).toBe('suspended');
  });
});
