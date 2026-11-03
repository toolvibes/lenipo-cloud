/**
 * The plans of Lenipo Cloud (E-154): a price per seat and month, seats bought in advance.
 * Seats are active people who are not external guests; agents take none. The amounts are
 * those of the prices in Stripe (STRIPE_PRICES); the ones here are only shown.
 */
export const PLAN_KEYS = ['team', 'business'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export const INTERVALS = ['month', 'year'] as const;
export type Interval = (typeof INTERVALS)[number];

export interface Plan {
  key: PlanKey;
  name: string;
  /** Euro per seat and month, net; yearly billed as twelve months at this price. */
  price: Record<Interval, number>;
  agents: number;
  /** Storage for attachments: a base plus an amount per seat. */
  storageMb: { base: number; perSeat: number };
  serviceDesk: boolean;
  /** Modules of the product; null: all. */
  modules: string[] | null;
  features: string[];
}

export const PLANS: Record<PlanKey, Plan> = {
  team: {
    key: 'team',
    name: 'Team',
    price: { month: 6, year: 5 },
    agents: 2,
    storageMb: { base: 5_000, perSeat: 1_000 },
    serviceDesk: false,
    modules: null,
    features: [
      'Vorgänge, Boards, Sprints, Wiki',
      '2 KI-Agenten',
      '5 GB Speicher plus 1 GB je Platz',
    ],
  },
  business: {
    key: 'business',
    name: 'Business',
    price: { month: 9, year: 7.5 },
    agents: 20,
    storageMb: { base: 20_000, perSeat: 2_000 },
    serviceDesk: true,
    modules: null,
    features: [
      'Alles aus Team',
      'Service Desk mit Kundenportal',
      '20 KI-Agenten',
      '20 GB Speicher plus 2 GB je Platz',
    ],
  },
};

/** What the trial allows: Business with a seat limit. */
export const TRIAL_LIMITS = {
  plan: 'Testphase',
  persons: 25,
  agents: 5,
  storageMb: 10_000,
  modules: null,
  serviceDesk: true,
};

/** The frame the instance enforces (the product's ProviderLimits). */
export function limitsOf(plan: Plan, seats: number) {
  return {
    plan: plan.name,
    persons: seats,
    agents: plan.agents,
    storageMb: plan.storageMb.base + plan.storageMb.perSeat * seats,
    modules: plan.modules,
    serviceDesk: plan.serviceDesk,
  };
}

export const isPlanKey = (value: string): value is PlanKey =>
  (PLAN_KEYS as readonly string[]).includes(value);
export const isInterval = (value: string): value is Interval =>
  (INTERVALS as readonly string[]).includes(value);
