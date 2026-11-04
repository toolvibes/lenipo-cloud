import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'undici';
import { loadConfig } from './config.js';
import { DockerPlatform } from './platform/docker.js';
import type { Instance } from './platform/platform.js';
import { randomToken } from './secrets.js';

/**
 * Smoke test of the Docker platform against a real Docker, PostgreSQL and Caddy:
 * database, container, route, setup by token, export, restore into an emptied instance, removal.
 * Reads the normal configuration
 * plus SMOKE_GATEWAY (where Caddy listens, e.g. http://localhost:8088) and SMOKE_SLUG.
 *   node dist/smoke.js
 */
const config = loadConfig();
const gateway = process.env.SMOKE_GATEWAY ?? 'http://localhost:80';
const slug = process.env.SMOKE_SLUG ?? 'smoke';
const platform = new DockerPlatform(config);
const host = `${slug}.${config.BASE_DOMAIN}`;
const setupToken = randomToken(32);
const password = randomToken(24);
const name = `t_${slug.replaceAll('-', '_')}`;
const instance: Instance = {
  slug,
  image: config.LENIPO_IMAGE,
  hosts: [host],
  databasePassword: password,
  env: {
    DATABASE_URL: `postgres://${name}:${password}@${config.TENANT_DATABASE_HOST}/${name}`,
    PUBLIC_URL: `http://${host}`,
    SETUP_TOKEN: setupToken,
    STORAGE_DRIVER: 'local',
    COOKIE_SECURE: 'false',
  },
};

const step = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  const result = await work();
  console.log(`ok  ${label} (${Date.now() - started} ms)`);
  return result;
};

// fetch drops the Host header; undici's request keeps it.
const viaCaddy = async (
  path: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = {},
) => {
  const response = await request(`${gateway}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...init.headers, host },
    body: init.body,
  });
  const text = await response.body.text();
  return {
    status: response.statusCode,
    ok: response.statusCode < 300,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
};

const dir = await mkdtemp(join(tmpdir(), 'lenipo-smoke-'));
try {
  await step('database and role', () => platform.ensureDatabase(instance));
  await step('container', () => platform.ensureInstance(instance));
  await step('same container again (no change)', () => platform.ensureInstance(instance));
  await step('route in Caddy', () => platform.ensureRoute(instance));
  const answers = async () => {
    const until = Date.now() + 180_000;
    for (;;) {
      const response = await viaCaddy('/api/v1/health/ready').catch(() => null);
      if (response?.ok) return;
      if (Date.now() > until) throw new Error('No answer within three minutes');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };
  await step('instance answers through Caddy', answers);
  const link = await step('setup by token', async () => {
    const response = await viaCaddy('/api/v1/setup/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${setupToken}` },
      body: JSON.stringify({ instanceName: 'Smoke', admin: { email: 'smoke@example.org' } }),
    });
    if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
    return ((await response.json()) as { link: string }).link;
  });
  console.log(`    ${link}`);
  await step('first administrator accepts', async () => {
    const response = await viaCaddy('/api/v1/invitations/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: new URL(link).searchParams.get('token'),
        displayName: 'Smoke',
        password: randomToken(16),
      }),
    });
    if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  });
  const setupRequired = async () =>
    ((await (await viaCaddy('/api/v1/setup/status')).json()) as { required: boolean }).required;
  const file = join(dir, 'export.zip');
  await step('export', () => platform.exportInstance(slug, file));
  const zip = await readFile(file);
  if (zip.subarray(0, 2).toString() !== 'PK') throw new Error('The export is no ZIP');
  console.log(`    ${zip.length} bytes`);
  // A restore as Lenipo Cloud does it: everything emptied, then the backup played in.
  await step('empty the instance', async () => {
    await platform.removeInstance(slug);
    await platform.dropDatabase(slug);
    await platform.ensureDatabase(instance);
    await platform.ensureInstance(instance);
  });
  await step('fresh instance answers', async () => {
    await answers();
    if (!(await setupRequired())) throw new Error('The emptied instance is still set up');
  });
  await step('restore the export', () => platform.restoreInstance(slug, file));
  await step('restored instance has its administrator', async () => {
    await answers();
    if (await setupRequired()) throw new Error('The restore brought no administrator back');
  });
  await step('stop', () => platform.stopInstance(slug));
} finally {
  // SMOKE_KEEP=1 leaves everything standing, e.g. to read the container's log.
  if (process.env.SMOKE_KEEP === '1') process.exit(process.exitCode ?? 0);
  await step('remove route', () => platform.removeRoute(slug));
  await step('remove container and volume', () => platform.removeInstance(slug));
  await step('drop database and role', () => platform.dropDatabase(slug));
  await rm(dir, { recursive: true, force: true });
}
