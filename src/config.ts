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
