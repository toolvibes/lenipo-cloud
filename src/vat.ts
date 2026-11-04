/**
 * How prices relate to VAT. `small-business`: the operator is a "Kleinunternehmer" under
 * § 19 UStG and charges no VAT; prices are final and every price and invoice says so.
 * `standard`: prices plus VAT, worked out by Stripe Tax.
 */
export const VAT_MODES = ['small-business', 'standard'] as const;
export type VatMode = (typeof VAT_MODES)[number];

export const SMALL_BUSINESS_NOTE = 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.';

/** Short addition after a price, e.g. "je Platz und Monat zzgl. USt.". */
export function vatSuffix(mode: VatMode): string {
  return mode === 'standard' ? 'zzgl. USt.' : 'ohne Umsatzsteuer (§ 19 UStG)';
}
