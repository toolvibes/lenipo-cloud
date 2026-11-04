import { z } from 'zod';

/** Everything the service reads from its environment. */
export const Config = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  PORT: z.coerce.number().int().positive().default(8080),
  /** Public address of this service, e.g. https://cloud.lenipo.de. */
  CLOUD_URL: z.url(),
  /** Instances live at <name>.<BASE_DOMAIN>. */
  BASE_DOMAIN: z.string().min(3).default('lenipo.de'),
  /** Encrypts the secrets of instances at rest; at least 32 characters, never change it. */
  SECRET_KEY: z.string().min(32),
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  MAIL_FROM: z.string().min(3).default('Lenipo <hallo@lenipo.de>'),

  /** docker runs instances, memory only pretends (tests, development). */
  PLATFORM: z.enum(['docker', 'memory']).default('docker'),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  /** The product image every instance runs. */
  LENIPO_IMAGE: z.string().default('ghcr.io/toolvibes/lenipo:latest'),
  /** The Docker network shared by Caddy, this service, PostgreSQL and the instances. */
  DOCKER_NETWORK: z.string().default('lenipo'),
  /** Memory limit of one instance. */
  INSTANCE_MEMORY_MB: z.coerce.number().int().min(256).default(1024),
  /** Superuser connection to the PostgreSQL cluster of the instances. */
  TENANT_DATABASE_ADMIN_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  /** host:port of that cluster as instances reach it. */
  TENANT_DATABASE_HOST: z.string().default('postgres:5432'),
  /** Admin API of Caddy, which routes the hosts of the instances. */
  CADDY_ADMIN_URL: z.url().default('http://caddy:2019'),
  CADDY_SERVER: z.string().default('srv0'),
  /** Where exports wait for download. */
  EXPORT_DIR: z.string().default('/var/lib/lenipo-cloud/exports'),
  /** Mail for the instances' own notifications. */
  TENANT_SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  TENANT_MAIL_FROM: z.string().default('Lenipo <benachrichtigung@lenipo.de>'),

  /** Stripe (E-154); without the secret key, payments only happen in memory (development). */
  STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  /** Price ids per plan and interval, e.g. {"team:month":"price_…","team:year":"price_…"}. */
  STRIPE_PRICES: z
    .string()
    .default('{}')
    .transform((value) => z.record(z.string(), z.string()).parse(JSON.parse(value))),
  /** Stripe Tax works out the VAT; needs it set up in the Stripe account. */
  STRIPE_AUTOMATIC_TAX: z.stringbool().default(true),

  /** Operations (E-156): where alerts go; without it they only show in `ops.js status`. */
  OPS_EMAIL: z.email().optional(),
  /** Bearer token for /ops/metrics (Prometheus); without it the endpoint does not exist. */
  OPS_METRICS_TOKEN: z.string().min(32).optional(),
  /** Nightly backups of every instance, kept 7 days plus one a week for 4 weeks. */
  BACKUP_DIR: z.string().default('/var/lib/lenipo-cloud/backups'),
  /** From this hour (UTC) on, the nightly backups start. */
  BACKUP_HOUR: z.coerce.number().int().min(0).max(23).default(1),
  /** A trial instance nobody used for this many days sleeps until its next request; 0: never. */
  SLEEP_AFTER_DAYS: z.coerce.number().int().min(0).default(7),
  /** Memory of the server for instances; new sign-ups pause once it is taken. */
  SERVER_MEMORY_MB: z.coerce.number().int().min(1024).default(49_152),
  /** What the server costs a month, net, for the cost overview. */
  SERVER_COST_EUR: z.coerce.number().min(0).default(0),
  /** How long an instance may take to get ready after an update or restore. */
  READY_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(300),
  /** Instances run at once by the worker; never two jobs of one instance. */
  JOB_WORKERS: z.coerce.number().int().min(1).max(8).default(2),

  /**
   * Weekly window for updates with downtime (TL-106), Europe/Berlin, e.g. "tue 06:00-08:00";
   * "always" for development and tests. Rollout waves start only within it.
   */
  MAINTENANCE_WINDOW: z
    .string()
    .regex(/^(always|(mon|tue|wed|thu|fri|sat|sun) \d{2}:\d{2}-\d{2}:\d{2})$/)
    .default('tue 06:00-08:00'),
  /** The support portal (a Lenipo instance with service desk), linked in accounts and instances. */
  SUPPORT_URL: z.url({ protocol: /^https?$/ }).optional(),
  SUPPORT_EMAIL: z.email().default('support@lenipo.de'),

  TRIAL_DAYS: z.coerce.number().int().min(1).default(30),
  /** How long data stays after an instance was stopped (trial over, cancelled). */
  RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  /** The background loop; off in tests that drive it by hand. */
  WORKER: z.stringbool().default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = Config.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `- ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
