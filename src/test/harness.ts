import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { Cloud, type Resolver } from '../cloud.js';
import { type Config, loadConfig } from '../config.js';
import { createDatabase, type Database, migrateDatabase } from '../db/client.js';
import { fileKey, openFile } from '../files.js';
import { MemoryMailer } from '../mail.js';
import { MemoryPayments } from '../payments.js';
import { MemoryPlatform } from '../platform/memory.js';
import { createServer } from '../server.js';

/**
 * Stands in for the API of the instances: health and setup by the provider. Readiness fails for
 * slugs in `down` and for instances running a version in `broken`.
 */
async function fakeInstances(imageOf: (slug: string) => string | null) {
  const down = new Set<string>();
  const broken = new Set<string>();
  const provisioned = new Set<string>();
  const calls: Array<{ slug: string; body: unknown; token: string }> = [];
  const limits = new Map<string, unknown>();
  const notices = new Map<string, { text: string; level: string }>();
  const usage = new Map<string, Usage>();
  const server: Server = createHttpServer((request, response) => {
    const [, slug, ...rest] = (request.url ?? '').split('/');
    const path = `/${rest.join('/')}`;
    if (path === '/api/v1/health/live') {
      response.writeHead(200).end('{"status":"ok"}');
      return;
    }
    if (path === '/api/v1/health/ready') {
      const version =
        imageOf(slug ?? '')
          ?.split(':')
          .at(-1) ?? '';
      const ok = !down.has(slug ?? '') && !broken.has(version);
      response.writeHead(ok ? 200 : 503).end(ok ? '{"status":"ok"}' : '{"status":"down"}');
      return;
    }
    if (path === '/api/v1/provider/usage') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(usage.get(slug ?? '') ?? { persons: 1, agents: 0, storageMb: 0 }));
      return;
    }
    if (path === '/api/v1/provider/notice' && request.method === 'PUT') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        notices.set(slug ?? '', JSON.parse(body));
        response.writeHead(200, { 'content-type': 'application/json' }).end(body);
      });
      return;
    }
    if (path === '/api/v1/provider/limits' && request.method === 'PUT') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        limits.set(slug ?? '', JSON.parse(body));
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
      return;
    }
    if (path === '/api/v1/setup/provision' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
        calls.push({ slug: slug ?? '', body: JSON.parse(body), token });
        if (provisioned.has(slug ?? '')) {
          response.writeHead(409).end();
          return;
        }
        provisioned.add(slug ?? '');
        response.writeHead(201, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            link: `https://${slug}.lenipo.test/invite?token=einladung-${slug}`,
            expiresAt: new Date().toISOString(),
          }),
        );
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    calls,
    limits,
    notices,
    usage,
    down,
    broken,
    url: (slug: string) => `http://127.0.0.1:${port}/${slug}`,
  };
}

export interface Usage {
  persons: number;
  agents: number;
  storageMb: number;
  lastActiveAt?: string | null;
}

export interface TestCloud {
  config: Config;
  database: Database;
  cloud: Cloud;
  platform: MemoryPlatform;
  mailer: MemoryMailer;
  dns: { cname: Map<string, string[]>; a: Map<string, string[]> };
  clock: { now: Date };
  setupCalls: Array<{ slug: string; body: unknown; token: string }>;
  /** The frame each instance got, and what it reports as used. */
  limits: Map<string, unknown>;
  /** The provider notice each instance got (TL-106). */
  notices: Map<string, { text: string; level: string }>;
  usage: Map<string, Usage>;
  /** Instances whose readiness check fails, and versions that never get ready. */
  down: Set<string>;
  broken: Set<string>;
  backupDir: string;
  payments: MemoryPayments;
  app: Awaited<ReturnType<typeof createServer>>;
  /** The plain content of an encrypted backup or export (E-157). */
  readPlain(file: string): Promise<string>;
  close(): Promise<void>;
}

/** A fresh database on the server of TEST_DATABASE_URL or DATABASE_URL, migrated. */
export async function startTestCloud(overrides: Record<string, string> = {}): Promise<TestCloud> {
  const serverUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!serverUrl) throw new Error('Set DATABASE_URL to a PostgreSQL server for the tests');
  const name = `lenipo_cloud_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = postgres(serverUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const exports = await mkdtemp(join(tmpdir(), 'lenipo-cloud-exports-'));
  const backupDir = await mkdtemp(join(tmpdir(), 'lenipo-cloud-backups-'));
  const config = loadConfig({
    DATABASE_URL: url.toString(),
    CLOUD_URL: 'https://cloud.lenipo.test',
    BASE_DOMAIN: 'lenipo.test',
    SECRET_KEY: 'test-secret-key-0123456789abcdefghijklmn',
    PLATFORM: 'memory',
    EXPORT_DIR: exports,
    BACKUP_DIR: backupDir,
    LENIPO_IMAGE: 'ghcr.io/toolvibes/lenipo:1.0.0',
    READY_TIMEOUT_SECONDS: '1',
    // Sleeping is tested where it is meant; elsewhere instances stay awake.
    SLEEP_AFTER_DAYS: '0',
    OPS_EMAIL: 'betrieb@lenipo.test',
    OPS_METRICS_TOKEN: 'metrics-token-0123456789abcdefghijklmnop',
    WORKER: 'false',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_PRICES: JSON.stringify({
      'team:month': 'price_team_month',
      'team:year': 'price_team_year',
      'business:month': 'price_business_month',
      'business:year': 'price_business_year',
    }),
    LOG_LEVEL: 'fatal',
    // Rollouts are tested apart from the weekly window; the window has its own test.
    MAINTENANCE_WINDOW: 'always',
    ...overrides,
  });
  const database = createDatabase(config.DATABASE_URL);
  await migrateDatabase(database);
  let platform: MemoryPlatform | null = null;
  const instances = await fakeInstances((slug) => platform?.state.get(slug)?.image ?? null);
  platform = new MemoryPlatform(instances.url);
  const mailer = new MemoryMailer();
  const dns = { cname: new Map<string, string[]>(), a: new Map<string, string[]>() };
  const resolver: Resolver = {
    cname: async (host) => dns.cname.get(host) ?? [],
    a: async (host) => dns.a.get(host) ?? [],
  };
  const clock = { now: new Date('2026-11-03T10:00:00Z') };
  const payments = new MemoryPayments(() => clock.now);
  const cloud = new Cloud(config, database, platform, mailer, payments, resolver, () => clock.now);
  const app = await createServer(config, cloud, false);
  return {
    /** The plain content of an encrypted backup or export (E-157). */
    async readPlain(file: string): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of await openFile(file, fileKey(config.SECRET_KEY)))
        chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf8');
    },
    config,
    database,
    cloud,
    platform,
    mailer,
    dns,
    clock,
    setupCalls: instances.calls,
    limits: instances.limits,
    notices: instances.notices,
    usage: instances.usage,
    down: instances.down,
    broken: instances.broken,
    backupDir,
    payments,
    app,
    async close() {
      await app.close();
      instances.server.close();
      await database.sql.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
      await rm(exports, { recursive: true, force: true });
      await rm(backupDir, { recursive: true, force: true });
    },
  };
}
