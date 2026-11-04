import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { SMALL_BUSINESS_NOTE, type VatMode } from './vat.js';

/** A subscription as far as Lenipo Cloud cares. */
export interface Subscription {
  id: string;
  customerId: string;
  /** Stripe's status: active, trialing, past_due, unpaid, canceled, incomplete … */
  status: string;
  priceId: string;
  seats: number;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
  tenantId: string | null;
}

export interface CheckoutRequest {
  tenantId: string;
  email: string;
  customerId: string | null;
  priceId: string;
  seats: number;
  successUrl: string;
  cancelUrl: string;
}

/** The payment provider (E-154: Stripe); a stand-in keeps everything in memory for tests. */
export interface Payments {
  checkout(request: CheckoutRequest): Promise<{ url: string }>;
  portal(customerId: string, returnUrl: string): Promise<{ url: string }>;
  subscription(id: string): Promise<Subscription>;
  /** A new price or number of seats; upgrades are charged at once, downgrades are not. */
  change(
    id: string,
    change: { priceId: string; seats: number; prorate: boolean },
  ): Promise<Subscription>;
  cancelAtPeriodEnd(id: string, cancel: boolean): Promise<Subscription>;
}

/** Stripe's webhook signature: `t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function verifyStripeSignature(
  secret: string,
  header: string | undefined,
  body: string,
  now = Date.now(),
): boolean {
  if (!header) return false;
  const parts = header.split(',').map((part) => part.split('=') as [string, string]);
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  if (!timestamp || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  return parts
    .filter(([key]) => key === 'v1')
    .some(([, value]) => {
      const given = Buffer.from(value ?? '', 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

export function signStripePayload(secret: string, body: string, now = Date.now()): string {
  const timestamp = Math.floor(now / 1000);
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end?: number;
  metadata?: Record<string, string>;
  items: {
    data: Array<{
      id: string;
      quantity?: number;
      current_period_end?: number;
      price: { id: string };
    }>;
  };
}

/** Reads a subscription object of the Stripe API or of a webhook. */
export function fromStripe(object: StripeSubscription): Subscription {
  const item = object.items.data[0];
  // Newer API versions keep the period on the item.
  const end = item?.current_period_end ?? object.current_period_end ?? 0;
  return {
    id: object.id,
    customerId: object.customer,
    status: object.status,
    priceId: item?.price.id ?? '',
    seats: item?.quantity ?? 1,
    periodEnd: new Date(end * 1000),
    cancelAtPeriodEnd: object.cancel_at_period_end,
    tenantId: object.metadata?.tenantId ?? null,
  };
}

export class StripePayments implements Payments {
  constructor(
    private readonly secretKey: string,
    private readonly vatMode: VatMode,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>) {
    const response = await fetch(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        ...(form
          ? {
              'content-type': 'application/x-www-form-urlencoded',
              // Retries of the same change do not charge twice.
              'idempotency-key': randomUUID(),
            }
          : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const json = (await response.json()) as T & { error?: { message?: string } };
    if (!response.ok) throw new Error(`Stripe ${path}: ${json.error?.message ?? response.status}`);
    return json;
  }

  async checkout(request: CheckoutRequest) {
    const form: Record<string, string> = {
      mode: 'subscription',
      'line_items[0][price]': request.priceId,
      'line_items[0][quantity]': String(request.seats),
      client_reference_id: request.tenantId,
      'subscription_data[metadata][tenantId]': request.tenantId,
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      billing_address_collection: 'required',
      locale: 'de',
    };
    if (this.vatMode === 'standard') {
      form['automatic_tax[enabled]'] = 'true';
      form['tax_id_collection[enabled]'] = 'true';
    } else {
      // No VAT: say so on the checkout page; the invoice footer is set in Stripe (README).
      form['custom_text[submit][message]'] = SMALL_BUSINESS_NOTE;
    }
    if (request.customerId) {
      form.customer = request.customerId;
      form['customer_update[address]'] = 'auto';
      form['customer_update[name]'] = 'auto';
    } else {
      form.customer_email = request.email;
    }
    const session = await this.call<{ url: string }>('POST', '/checkout/sessions', form);
    return { url: session.url };
  }

  async portal(customerId: string, returnUrl: string) {
    const session = await this.call<{ url: string }>('POST', '/billing_portal/sessions', {
      customer: customerId,
      return_url: returnUrl,
      locale: 'de',
    });
    return { url: session.url };
  }

  async subscription(id: string) {
    return fromStripe(await this.call<StripeSubscription>('GET', `/subscriptions/${id}`));
  }

  async change(id: string, change: { priceId: string; seats: number; prorate: boolean }) {
    const current = await this.call<StripeSubscription>('GET', `/subscriptions/${id}`);
    const item = current.items.data[0];
    if (!item) throw new Error('The subscription has no item');
    return fromStripe(
      await this.call<StripeSubscription>('POST', `/subscriptions/${id}`, {
        'items[0][id]': item.id,
        'items[0][price]': change.priceId,
        'items[0][quantity]': String(change.seats),
        proration_behavior: change.prorate ? 'always_invoice' : 'none',
      }),
    );
  }

  async cancelAtPeriodEnd(id: string, cancel: boolean) {
    return fromStripe(
      await this.call<StripeSubscription>('POST', `/subscriptions/${id}`, {
        cancel_at_period_end: String(cancel),
      }),
    );
  }
}

/** Keeps subscriptions in memory; a checkout is completed with `complete` (tests, development). */
export class MemoryPayments implements Payments {
  readonly subscriptions = new Map<string, Subscription>();
  readonly checkouts: CheckoutRequest[] = [];
  readonly changes: Array<{ id: string; priceId: string; seats: number; prorate: boolean }> = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async checkout(request: CheckoutRequest) {
    this.checkouts.push(request);
    return { url: `https://checkout.stripe.test/${this.checkouts.length}` };
  }

  async portal(customerId: string) {
    return { url: `https://billing.stripe.test/${customerId}` };
  }

  /** What Stripe does once the customer paid: a subscription for the last checkout. */
  complete(interval: 'month' | 'year' = 'month'): Subscription {
    const request = this.checkouts.at(-1);
    if (!request) throw new Error('No checkout');
    const end = new Date(this.now());
    if (interval === 'month') end.setMonth(end.getMonth() + 1);
    else end.setFullYear(end.getFullYear() + 1);
    const subscription: Subscription = {
      id: `sub_${this.subscriptions.size + 1}`,
      customerId: request.customerId ?? `cus_${this.subscriptions.size + 1}`,
      status: 'active',
      priceId: request.priceId,
      seats: request.seats,
      periodEnd: end,
      cancelAtPeriodEnd: false,
      tenantId: request.tenantId,
    };
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  async subscription(id: string) {
    const found = this.subscriptions.get(id);
    if (!found) throw new Error(`No subscription ${id}`);
    return found;
  }

  async change(id: string, change: { priceId: string; seats: number; prorate: boolean }) {
    this.changes.push({ id, ...change });
    const updated = {
      ...(await this.subscription(id)),
      priceId: change.priceId,
      seats: change.seats,
    };
    this.subscriptions.set(id, updated);
    return updated;
  }

  async cancelAtPeriodEnd(id: string, cancel: boolean) {
    const updated = { ...(await this.subscription(id)), cancelAtPeriodEnd: cancel };
    this.subscriptions.set(id, updated);
    return updated;
  }
}
