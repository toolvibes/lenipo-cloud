import { afterEach, describe, expect, it, vi } from 'vitest';
import { StripePayments } from './payments.js';
import { SMALL_BUSINESS_NOTE, vatSuffix } from './vat.js';

const request = {
  tenantId: 't1',
  priceId: 'price_team_month',
  seats: 3,
  email: 'mia@mess.example',
  customerId: null,
  successUrl: 'https://cloud.lenipo.test/ok',
  cancelUrl: 'https://cloud.lenipo.test/back',
};

async function checkoutForm(mode: 'small-business' | 'standard') {
  const fetch = vi.fn(async () => Response.json({ url: 'https://checkout.stripe.test/s' }));
  vi.stubGlobal('fetch', fetch);
  await new StripePayments('sk_test_x', mode).checkout(request);
  const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
  return new URLSearchParams(String(init.body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VAT mode', () => {
  it('charges no VAT as a small business and says so at checkout (§ 19 UStG)', async () => {
    const form = await checkoutForm('small-business');
    expect(form.get('automatic_tax[enabled]')).toBeNull();
    expect(form.get('tax_id_collection[enabled]')).toBeNull();
    expect(form.get('custom_text[submit][message]')).toBe(SMALL_BUSINESS_NOTE);
    expect(vatSuffix('small-business')).toBe('ohne Umsatzsteuer (§ 19 UStG)');
  });

  it('adds VAT through Stripe Tax in the standard mode', async () => {
    const form = await checkoutForm('standard');
    expect(form.get('automatic_tax[enabled]')).toBe('true');
    expect(form.get('tax_id_collection[enabled]')).toBe('true');
    expect(form.get('custom_text[submit][message]')).toBeNull();
    expect(vatSuffix('standard')).toBe('zzgl. USt.');
  });
});
