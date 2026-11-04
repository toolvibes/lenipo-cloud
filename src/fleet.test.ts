import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backups, jobs, tenants } from './db/schema.js';
import { runOps } from './operator.js';
import { startTestCloud, type TestCloud } from './test/harness.js';

const DAY = 86_400_000;
const OPS = 'betrieb@lenipo.test';

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const tokenOf = (link: string) => new URL(link).searchParams.get('token') ?? '';

function helpers(t: () => TestCloud) {
  const post = (url: string, fields: Record<string, string> = {}) =>
    t().app.inject({
      method: 'POST',
      url,
      payload: form(fields),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  const tenantBySlug = async (slug: string) => {
    const [row] = await t().database.db.select().from(tenants).where(eq(tenants.slug, slug));
    if (!row) throw new Error(`No tenant ${slug}`);
    return row;
  };
  const signUp = async (slug: string) => {
    const email = `admin@${slug}.example`;
    const answer = await post('/signup', { email, name: `Firma ${slug}`, slug });
    if (answer.statusCode !== 200) return answer;
    await post('/signup/confirm', { token: tokenOf(t().mailer.linkTo(email)) });
    await t().cloud.runJobs();
    return answer;
  };
  /** A day passes: everyone who should stay awake was active, then the minute and the jobs. */
  const day = async (awake: string[] = []) => {
    t().clock.now = new Date(t().clock.now.getTime() + DAY);
    for (const slug of awake) {
      t().usage.set(slug, {
        persons: 2,
        agents: 0,
        storageMb: 5,
        lastActiveAt: t().clock.now.toISOString(),
      });
    }
    await t().cloud.tick();
    await t().cloud.runJobs();
  };
  const step = async () => {
    await t().cloud.tick();
    await t().cloud.runJobs();
  };
  const opsMails = () => t().mailer.sent.filter((mail) => mail.to === OPS);
  const ops = (...args: string[]) => runOps(t().cloud.fleet, args);
  return { post, tenantBySlug, signUp, day, step, opsMails, ops };
}

describe('running many instances (TL-104)', () => {
  let t: TestCloud;
  const { tenantBySlug, signUp, day, step, opsMails, ops } = helpers(() => t);

  beforeAll(async () => {
    // A long trial: the story here spans several weeks.
    t = await startTestCloud({ SLEEP_AFTER_DAYS: '7', TRIAL_DAYS: '90' });
  });

  afterAll(async () => {
    await t?.close();
  });

  it('starts new instances with the current version and backs them up every night', async () => {
    await signUp('alpha');
    const alpha = await tenantBySlug('alpha');
    expect(alpha).toMatchObject({ status: 'trial', version: '1.0.0' });
    expect(t.platform.state.get('alpha')?.image).toBe('ghcr.io/toolvibes/lenipo:1.0.0');
    // 10:00 UTC is after BACKUP_HOUR: the first nightly backup is due at once, once a day.
    await step();
    await step();
    let rows = await t.cloud.fleet.backupsOf(alpha.id);
    expect(rows.map((row) => [row.kind, row.version])).toEqual([['nightly', '1.0.0']]);
    // Three and a half weeks: 7 days kept, beyond them one a week.
    for (let index = 0; index < 24; index += 1) await day(['alpha']);
    rows = await t.cloud.fleet.backupsOf(alpha.id);
    const ages = rows.map((row) => (t.clock.now.getTime() - row.createdAt.getTime()) / DAY);
    expect(ages.filter((age) => age <= 7)).toHaveLength(8);
    expect(ages.filter((age) => age > 7).length).toBeGreaterThanOrEqual(2);
    expect(ages.filter((age) => age > 7).length).toBeLessThanOrEqual(4);
    expect(Math.max(...ages)).toBeLessThanOrEqual(28);
    // The files are the rows: pruned backups are gone from the disk.
    const [folder] = await readdir(t.backupDir);
    expect((await readdir(join(t.backupDir, folder ?? ''))).sort()).toEqual(
      rows.map((row) => row.file.split('/').at(-1)).sort(),
    );
    // Nobody stays asleep who works: alpha is active every day.
    expect((await tenantBySlug('alpha')).sleepingAt).toBeNull();
  });

  it('restores a backup on request, after securing the state of now', async () => {
    const alpha = await tenantBySlug('alpha');
    const [, older] = await t.cloud.fleet.backupsOf(alpha.id);
    if (!older) throw new Error('No older backup');
    await expect(ops('restore', 'alpha', older.id.slice(0, 8))).rejects.toThrow('--yes');
    expect(await ops('restore', 'alpha', older.id.slice(0, 8), '--yes')).toContain(
      'ist eingeplant',
    );
    await t.cloud.runJobs();
    const state = t.platform.state.get('alpha');
    expect(state?.restored.at(-1)).toBe(await readFile(older.file, 'utf8'));
    expect(state).toMatchObject({ container: 'running', hosts: ['alpha.lenipo.test'] });
    const kinds = (await t.cloud.fleet.backupsOf(alpha.id)).map((row) => row.kind);
    expect(kinds).toContain('pre-restore');
    expect((await t.cloud.fleet.details('alpha')).events.map((event) => event.kind)).toContain(
      'restored',
    );
    expect(opsMails().at(-1)?.subject).toBe('[Lenipo Cloud] alpha wiederhergestellt');
  });

  it('rolls a version out in waves and pauses when an instance does not get ready', async () => {
    await signUp('beta');
    await signUp('gamma');
    await signUp('delta');
    await ops('canary', 'gamma', 'on');
    await t.cloud.fleet.startRollout('1.1.0', 1);
    await expect(t.cloud.fleet.startRollout('1.2.0')).rejects.toThrow('running');
    // First wave: the canaries only.
    await step();
    expect((await tenantBySlug('gamma')).version).toBe('1.1.0');
    expect((await tenantBySlug('alpha')).version).toBe('1.0.0');
    const gamma = await tenantBySlug('gamma');
    expect((await t.cloud.fleet.backupsOf(gamma.id)).map((row) => row.kind)).toContain(
      'pre-update',
    );
    // Then one at a time, oldest first.
    await step();
    expect((await tenantBySlug('alpha')).version).toBe('1.1.0');
    expect(t.platform.state.get('alpha')?.image).toBe('ghcr.io/toolvibes/lenipo:1.1.0');

    // beta does not get ready with 1.1.0: back to 1.0.0, the rollout pauses, the operator hears.
    t.broken.add('1.1.0');
    await step();
    const beta = await tenantBySlug('beta');
    expect(beta.version).toBe('1.0.0');
    expect(t.platform.state.get('beta')?.image).toBe('ghcr.io/toolvibes/lenipo:1.0.0');
    expect((await t.cloud.fleet.rolloutStatus())?.rollout).toMatchObject({
      status: 'paused',
      pauseReason: expect.stringContaining('beta: Not ready'),
    });
    expect(opsMails().at(-1)?.subject).toBe(
      '[Lenipo Cloud] Update von beta auf 1.1.0 fehlgeschlagen',
    );
    // Paused: nothing moves.
    await step();
    expect((await tenantBySlug('delta')).version).toBe('1.0.0');
    expect(await ops('status')).toContain('Rollout auf 1.1.0: paused');

    // Fixed: resume, and the rest follows.
    t.broken.delete('1.1.0');
    await ops('rollout', 'resume');
    expect(opsMails().at(-1)?.subject).toContain('Erledigt: Update von beta');
    await step();
    await step();
    await step();
    expect((await tenantBySlug('beta')).version).toBe('1.1.0');
    expect((await tenantBySlug('delta')).version).toBe('1.1.0');
    expect(await t.cloud.fleet.currentVersion()).toBe('1.1.0');
    expect(opsMails().at(-1)?.subject).toBe('[Lenipo Cloud] Rollout auf 1.1.0 fertig');
    // New instances start with it.
    await signUp('epsilon');
    expect((await tenantBySlug('epsilon')).version).toBe('1.1.0');
  });

  it('goes back to the backup when the old version does not start on the migrated database', async () => {
    await t.cloud.fleet.startRollout('1.2.0', 10);
    await ops('canary', 'gamma', 'off');
    t.broken.add('1.2.0');
    // The old version does not come up either, until the backup before the update is back.
    t.broken.add('1.1.0');
    const restore = t.platform.restoreInstance.bind(t.platform);
    t.platform.restoreInstance = async (slug, file) => {
      t.broken.delete('1.1.0');
      return restore(slug, file);
    };
    await step();
    const alpha = await tenantBySlug('alpha');
    const preUpdate = (await t.cloud.fleet.backupsOf(alpha.id)).find(
      (row) => row.kind === 'pre-update' && row.version === '1.1.0',
    );
    expect(t.platform.state.get('alpha')).toMatchObject({
      image: 'ghcr.io/toolvibes/lenipo:1.1.0',
      container: 'running',
    });
    expect(t.platform.state.get('alpha')?.restored.at(-1)).toBe(
      await readFile(preUpdate?.file ?? '', 'utf8'),
    );
    const events = (await t.cloud.fleet.details('alpha')).events.map((event) => event.kind);
    expect(events).toEqual(expect.arrayContaining(['update-failed', 'rollback-from-backup']));
    await ops('rollout', 'cancel');
    t.broken.delete('1.2.0');
    expect(await t.cloud.fleet.currentVersion()).toBe('1.1.0');
  });

  it('raises an alert when an instance stops answering, and clears it', async () => {
    // A check where everyone answers clears the failures counted before.
    await t.cloud.tick();
    const before = opsMails().length;
    t.down.add('delta');
    await t.cloud.tick();
    await t.cloud.tick();
    expect(opsMails()).toHaveLength(before);
    await t.cloud.tick();
    await t.cloud.tick();
    expect(
      opsMails()
        .slice(before)
        .map((mail) => mail.subject),
    ).toEqual(['[Lenipo Cloud] delta antwortet nicht']);
    expect(await ops('tenants')).toMatch(/delta\s+trial\s+1\.1\.0\s+AUSGEFALLEN/);
    t.down.delete('delta');
    await t.cloud.tick();
    expect(opsMails().at(-1)?.subject).toBe('[Lenipo Cloud] Erledigt: delta antwortet nicht');
    expect((await tenantBySlug('delta')).downSince).toBeNull();
  });

  it('lets a trial nobody uses sleep and wakes it on the first request', async () => {
    // A week without anyone in epsilon; the others work.
    for (let index = 0; index < 7; index += 1) await day(['alpha', 'beta', 'gamma', 'delta']);
    const epsilon = await tenantBySlug('epsilon');
    expect(epsilon.sleepingAt).not.toBeNull();
    expect(t.platform.state.get('epsilon')).toMatchObject({ container: 'stopped', hosts: [] });
    expect((await t.cloud.fleet.backupsOf(epsilon.id)).map((row) => row.kind)).toContain(
      'pre-sleep',
    );
    // Asleep through a rollout: it follows when it wakes.
    await t.cloud.fleet.startRollout('1.3.0', 10);
    // No canaries any more: three first, then the rest, then done.
    await step();
    await step();
    await step();
    expect(await t.cloud.fleet.currentVersion()).toBe('1.3.0');
    expect((await tenantBySlug('epsilon')).version).toBe('1.1.0');

    const visit = () =>
      t.app.inject({ method: 'GET', url: '/projects', headers: { host: 'epsilon.lenipo.test' } });
    const first = await visit();
    expect(first.statusCode).toBe(503);
    expect(first.headers['retry-after']).toBe('5');
    expect(first.body).toContain('http-equiv="refresh"');
    expect(first.body).toContain('startet gerade');
    await visit();
    const waking = await t.database.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, epsilon.id), eq(jobs.kind, 'wake')));
    expect(waking).toHaveLength(1);
    await t.cloud.runJobs();
    const awake = await tenantBySlug('epsilon');
    expect(awake).toMatchObject({ sleepingAt: null, version: '1.3.0' });
    expect(t.platform.state.get('epsilon')).toMatchObject({
      container: 'running',
      hosts: ['epsilon.lenipo.test'],
      image: 'ghcr.io/toolvibes/lenipo:1.3.0',
    });
  });

  it('never runs two jobs of one instance at once and reports jobs that gave up', async () => {
    const alpha = await tenantBySlug('alpha');
    const db = t.database.db;
    await db.insert(jobs).values([
      { id: crypto.randomUUID(), tenantId: alpha.id, kind: 'usage', status: 'running' },
      { id: crypto.randomUUID(), tenantId: alpha.id, kind: 'backup', payload: { kind: 'manual' } },
    ]);
    expect(await t.cloud.runJobs()).toBe(0);
    await db
      .update(jobs)
      .set({ status: 'done' })
      .where(and(eq(jobs.tenantId, alpha.id), eq(jobs.status, 'running')));
    // The last of ten attempts fails.
    await db
      .update(jobs)
      .set({ attempts: 9 })
      .where(and(eq(jobs.tenantId, alpha.id), eq(jobs.kind, 'backup'), eq(jobs.status, 'queued')));
    t.platform.failOnce.add('exportInstance');
    expect(await t.cloud.runJobs()).toBe(1);
    expect(opsMails().at(-1)?.subject).toBe('[Lenipo Cloud] Job backup für alpha aufgegeben');
    expect(await ops('status')).toContain('Aufgegebene Jobs: 1');
    expect(await ops('retry', 'alpha')).toBe('1 Jobs von alpha laufen erneut.');
    expect(opsMails().at(-1)?.subject).toContain('Erledigt: Job backup für alpha');
    await t.cloud.runJobs();
    const manual = await db
      .select()
      .from(backups)
      .where(and(eq(backups.tenantId, alpha.id), eq(backups.kind, 'manual')));
    expect(manual).toHaveLength(1);
  });

  it('shows the operator status, costs and metrics', async () => {
    await t.database.db
      .update(tenants)
      .set({ status: 'active', plan: 'team', interval: 'month', seats: 5 })
      .where(eq(tenants.slug, 'alpha'));
    const status = await ops('status');
    expect(status).toContain('Version für neue Instanzen: 1.3.0');
    expect(status).toContain('Umsatz: 30.00 € im Monat aus 1 Tarifen');
    expect(status).toMatch(/Kapazität: 5 laufend, 5120 von 49152 MB/);
    expect(await ops('tenant', 'alpha')).toContain('Sicherungen:');
    expect(await ops('help')).toContain('rollout start <version>');

    const without = await t.app.inject({ method: 'GET', url: '/ops/metrics' });
    expect(without.statusCode).toBe(401);
    const metrics = await t.app.inject({
      method: 'GET',
      url: '/ops/metrics',
      headers: { authorization: `Bearer ${t.config.OPS_METRICS_TOKEN}` },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain('lenipo_tenant_up{tenant="alpha"} 1');
    expect(metrics.body).toContain('lenipo_cloud_revenue_monthly_euros 30');
    expect(metrics.body).toMatch(
      /lenipo_tenant_last_backup_timestamp_seconds\{tenant="alpha"\} \d+/,
    );
    expect(metrics.body).toContain(
      'lenipo_tenant_info{tenant="epsilon",version="1.3.0",status="trial"} 1',
    );
  });
});

describe('capacity of the server (TL-104)', () => {
  let t: TestCloud;
  const { signUp, opsMails } = helpers(() => t);

  beforeAll(async () => {
    t = await startTestCloud({ SERVER_MEMORY_MB: '4096', INSTANCE_MEMORY_MB: '1024' });
  });

  afterAll(async () => {
    await t?.close();
  });

  it('warns from 80 % and pauses sign-ups when the server is full', async () => {
    for (const slug of ['eins', 'zwei', 'drei']) await signUp(slug);
    await t.cloud.tick();
    expect(opsMails()).toHaveLength(0);
    await signUp('vier');
    await t.cloud.tick();
    expect(opsMails().map((mail) => mail.subject)).toEqual([
      '[Lenipo Cloud] Server zu 100 % belegt',
    ]);
    const full = await signUp('fuenf');
    expect(full.statusCode).toBe(503);
    expect(full.body).toContain('ausgebucht');
  });
});
