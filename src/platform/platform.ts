/** What the platform needs to know about an instance. */
export interface Instance {
  slug: string;
  /** Hosts Caddy routes to the instance, the first is its public address. */
  hosts: string[];
  /** Environment of the container. */
  env: Record<string, string>;
  databasePassword: string;
}

/**
 * Runs instances (E-153): every step is idempotent, so a job that broke off is simply run again.
 * Names derive from the slug: container `lenipo-<slug>`, volume `lenipo-<slug>-files`,
 * database and role `t_<slug>`.
 */
export interface Platform {
  ensureDatabase(instance: Instance): Promise<void>;
  dropDatabase(slug: string): Promise<void>;
  /** Creates or updates the container (new environment = new container) and starts it. */
  ensureInstance(instance: Instance): Promise<void>;
  stopInstance(slug: string): Promise<void>;
  startInstance(slug: string): Promise<void>;
  /** Removes container and files. */
  removeInstance(slug: string): Promise<void>;
  ensureRoute(instance: Instance): Promise<void>;
  removeRoute(slug: string): Promise<void>;
  /** Where this service reaches the API of the instance, without trailing slash. */
  instanceUrl(slug: string): string;
  /** A backup of the instance as ZIP (the product's format) into the given file. */
  exportInstance(slug: string, file: string): Promise<void>;
}

export const databaseName = (slug: string) => `t_${slug.replaceAll('-', '_')}`;
export const containerName = (slug: string) => `lenipo-${slug}`;
export const volumeName = (slug: string) => `lenipo-${slug}-files`;
