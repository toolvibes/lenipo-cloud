import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import {
  type BackupKind,
  backups,
  type JobKind,
  jobs,
  opsAlerts,
  rollouts,
  type TenantStatus,
  tenantEvents,
  tenants,
  usageSamples,
} from './db/schema.js';
import type { Mailer } from './mail.js';
import { type Interval, isInterval, isPlanKey, PLANS } from './plans.js';
import type { Instance, Platform } from './platform/platform.js';

const DAY = 86_400_000;
/** Failed readiness checks in a row before an instance counts as down. */
const DOWN_AFTER = 3;
/** Instances in the first wave of a rollout without canaries. */
const FIRST_WAVE = 3;
/** Checks at once; each waits at most PROBE_MS. */
const PROBE_BATCH = 10;
const PROBE_MS = 5_000;
/** Backups other than the nightly ones stay this long (and the newest of each kind always). */
const KEEP_OTHER_DAYS = 14;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 1970-01-05 was a Monday: weeks for the weekly backups start on Mondays (UTC). */
const MONDAY = Date.UTC(1970, 0, 5);

type TenantRow = typeof tenants.$inferSelect;
type BackupRow = typeof backups.$inferSelect;
type RolloutRow = typeof rollouts.$inferSelect;
export interface Job {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
}

/** What the fleet borrows from Cloud. */
export interface FleetContext {
  config: Config;
  database: Database;
  platform: Platform;
  mailer: Mailer;
  now: () => Date;
  event(tenantId: string, kind: string, details?: Record<string, unknown>): Promise<void>;
  enqueue(tenantId: string, kind: JobKind, payload?: Record<string, unknown>): Promise<void>;
  instance(tenant: TenantRow, version?: string): Instance;
  waitUntilLive(base: string): Promise<void>;
}

const LIVE: TenantStatus[] = ['trial', 'active'];
const isLive = (tenant: TenantRow) => LIVE.includes(tenant.status);

/**
 * Running many instances (E-156): versions and rollouts in waves, nightly backups and restores,
 * sleeping trials, readiness checks with alerts, capacity of the server and what it all costs
 * and earns. The operator works with it through `ops.js` and `/ops/metrics`.
 */
export class Fleet {
  constructor(private readonly ctx: FleetContext) {}

  private get db() {
    return this.ctx.database.db;
  }

  private get config() {
    return this.ctx.config;
  }

  // ---------------------------------------------------------------- versions

  /** The image without its tag, e.g. ghcr.io/toolvibes/lenipo. */
  private repository(): string {
    const image = this.config.LENIPO_IMAGE;
    const colon = image.lastIndexOf(':');
    return colon > image.lastIndexOf('/') ? image.slice(0, colon) : image;
  }

  /** The tag of LENIPO_IMAGE: the version before the first rollout. */
  defaultVersion(): string {
    const image = this.config.LENIPO_IMAGE;
    const colon = image.lastIndexOf(':');
    return colon > image.lastIndexOf('/') ? image.slice(colon + 1) : 'latest';
  }

  imageOf(version: string): string {
    return `${this.repository()}:${version}`;
  }

  versionOf(tenant: Pick<TenantRow, 'version'>): string {
    return tenant.version ?? this.defaultVersion();
  }

  /** New instances start with the version of the last finished rollout. */
  async currentVersion(): Promise<string> {
    const [done] = await this.db
      .select({ version: rollouts.version })
      .from(rollouts)
      .where(eq(rollouts.status, 'done'))
      .orderBy(desc(rollouts.finishedAt))
      .limit(1);
    return done?.version ?? this.defaultVersion();
  }

  /** Until the instance answers its readiness check (database reachable, migrated). */
  private async ready(slug: string): Promise<void> {
    const timeout = this.config.READY_TIMEOUT_SECONDS * 1000;
    const until = Date.now() + timeout;
    const pause = Math.min(2_000, Math.max(100, timeout / 10));
    let last = 'no answer';
    for (;;) {
      try {
        const response = await fetch(`${this.ctx.platform.instanceUrl(slug)}/api/v1/health/ready`, {
          signal: AbortSignal.timeout(PROBE_MS),
        });
        if (response.ok) return;
        last = `${response.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() > until) {
        throw new Error(`Not ready within ${timeout / 1000} seconds (${last})`);
      }
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }

  private async probe(slug: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.ctx.platform.instanceUrl(slug)}/api/v1/health/ready`, {
        signal: AbortSignal.timeout(PROBE_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- alerts

  /** Opens an alert and mails the operator, once until it is resolved. */
  async alert(key: string, subject: string, text: string) {
    const [opened] = await this.db
      .insert(opsAlerts)
      .values({ key, subject, text, openedAt: this.ctx.now() })
      .onConflictDoNothing()
      .returning();
    if (opened) await this.mailOperator(subject, text);
  }

  async resolve(key: string, text = '') {
    const [closed] = await this.db
      .update(opsAlerts)
      .set({ closedAt: this.ctx.now() })
      .where(and(eq(opsAlerts.key, key), isNull(opsAlerts.closedAt)))
      .returning();
    if (closed) await this.mailOperator(`Erledigt: ${closed.subject}`, text || closed.text);
  }

  private async mailOperator(subject: string, text: string) {
    if (!this.config.OPS_EMAIL) return;
    await this.ctx.mailer.send({
      to: this.config.OPS_EMAIL,
      subject: `[Lenipo Cloud] ${subject}`,
      text,
    });
  }

  async openAlerts() {
    return this.db
      .select()
      .from(opsAlerts)
      .where(isNull(opsAlerts.closedAt))
      .orderBy(asc(opsAlerts.openedAt));
  }

  // ---------------------------------------------------------------- backups

  private backupDir(tenant: Pick<TenantRow, 'slug' | 'id'>) {
    return join(this.config.BACKUP_DIR, `${tenant.slug}-${tenant.id.slice(0, 8)}`);
  }

  /** A backup in the product's format; then older ones beyond their time go. */
  async backup(tenant: TenantRow, kind: BackupKind): Promise<BackupRow> {
    const dir = this.backupDir(tenant);
    await mkdir(dir, { recursive: true });
    const at = this.ctx.now();
    const file = join(dir, `${at.toISOString().replace(/[:.]/g, '-')}-${kind}.zip`);
    await this.ctx.platform.exportInstance(tenant.slug, file);
    const { size } = await stat(file);
    const [row] = await this.db
      .insert(backups)
      .values({
        id: randomUUID(),
        tenantId: tenant.id,
        kind,
        file,
        sizeBytes: size,
        version: this.versionOf(tenant),
        createdAt: at,
      })
      .returning();
    if (!row) throw new Error('Backup row missing');
    await this.ctx.event(tenant.id, 'backup', { kind, bytes: size });
    await this.prune(tenant, row.id);
    return row;
  }

  /**
   * Keeps the nightly backups of the last 7 days (one a day) and one a week for 4 weeks; the
   * others 14 days and the newest of each kind always.
   */
  async prune(tenant: TenantRow, keep?: string) {
    const rows = await this.backupsOf(tenant.id);
    const now = this.ctx.now().getTime();
    const kept = new Set<string>(keep ? [keep] : []);
    const days = new Set<string>();
    const weeks = new Set<number>();
    const newest = new Set<string>();
    for (const row of rows) {
      const age = now - row.createdAt.getTime();
      if (row.kind === 'nightly') {
        const day = row.createdAt.toISOString().slice(0, 10);
        const week = Math.floor((row.createdAt.getTime() - MONDAY) / (7 * DAY));
        if (age <= 7 * DAY && !days.has(day)) {
          days.add(day);
          kept.add(row.id);
        }
        if (age <= 28 * DAY && !weeks.has(week)) {
          weeks.add(week);
          kept.add(row.id);
        }
      } else if (age <= KEEP_OTHER_DAYS * DAY) {
        kept.add(row.id);
      }
      if (!newest.has(row.kind)) {
        newest.add(row.kind);
        kept.add(row.id);
      }
    }
    for (const row of rows) {
      if (kept.has(row.id)) continue;
      await rm(row.file, { force: true });
      await this.db.delete(backups).where(eq(backups.id, row.id));
    }
  }

  async backupsOf(tenantId: string) {
    return this.db
      .select()
      .from(backups)
      .where(eq(backups.tenantId, tenantId))
      .orderBy(desc(backups.createdAt));
  }

  /** With the instance itself: every backup and its folder (DSGVO). */
  async removeBackups(tenant: TenantRow) {
    await rm(this.backupDir(tenant), { recursive: true, force: true });
    await this.db.delete(backups).where(eq(backups.tenantId, tenant.id));
  }

  /**
   * Empties the instance and plays the backup in with the version that wrote it: route, container,
   * files and database go, then a fresh instance takes the backup.
   */
  private async restoreFrom(tenant: TenantRow, backup: BackupRow) {
    const { platform } = this.ctx;
    await platform.removeRoute(tenant.slug);
    await platform.removeInstance(tenant.slug);
    await platform.dropDatabase(tenant.slug);
    await this.db
      .update(tenants)
      .set({ version: backup.version, sleepingAt: null })
      .where(eq(tenants.id, tenant.id));
    const restored = { ...tenant, version: backup.version, sleepingAt: null };
    const instance = this.ctx.instance(restored);
    await platform.ensureDatabase(instance);
    await platform.ensureInstance(instance);
    await this.ctx.waitUntilLive(platform.instanceUrl(tenant.slug));
    await platform.restoreInstance(tenant.slug, backup.file);
    await this.ready(tenant.slug);
    await platform.ensureRoute(instance);
    // The frame of the plan as it is now, not as it was in the backup.
    await this.ctx.enqueue(tenant.id, 'limits');
    await this.ctx.event(tenant.id, 'restored', {
      backupId: backup.id,
      version: backup.version,
      from: backup.createdAt.toISOString(),
    });
  }

  // ---------------------------------------------------------------- jobs

  async runJob(job: Job, tenant: TenantRow) {
    switch (job.kind) {
      case 'backup':
        if (!isLive(tenant) || tenant.sleepingAt) return;
        await this.backup(tenant, (job.payload.kind as BackupKind | undefined) ?? 'manual');
        return;
      case 'restore':
        return this.restoreJob(job, tenant);
      case 'update':
        return this.update(job, tenant);
      case 'sleep':
        return this.sleep(tenant);
      case 'wake':
        return this.wakeUp(tenant);
    }
  }

  private async restoreJob(job: Job, tenant: TenantRow) {
    if (!isLive(tenant)) return;
    const [backup] = await this.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, String(job.payload.backupId)), eq(backups.tenantId, tenant.id)));
    if (!backup) throw new Error(`Backup ${String(job.payload.backupId)} missing`);
    // Once per job, before anything changes: the state right now, in case it is wanted back.
    if (!job.payload.safetyBackupId && !tenant.sleepingAt) {
      const safety = await this.backup(tenant, 'pre-restore');
      await this.db
        .update(jobs)
        .set({ payload: { ...job.payload, safetyBackupId: safety.id } })
        .where(eq(jobs.id, job.id));
    }
    await this.restoreFrom(tenant, backup);
    await this.mailOperator(
      `${tenant.slug} wiederhergestellt`,
      `${tenant.slug} läuft wieder mit dem Stand vom ${backup.createdAt.toISOString()} (Version ${backup.version}).`,
    );
  }

  /**
   * One instance to another version: a backup first, then the new image and its readiness. If it
   * does not get ready, the instance goes back to its version (or to the backup, if the old
   * version no longer starts on the migrated database) and the rollout pauses.
   */
  private async update(job: Job, tenant: TenantRow) {
    if (!isLive(tenant) || tenant.sleepingAt) return;
    const target = String(job.payload.version);
    const rolloutId = typeof job.payload.rolloutId === 'string' ? job.payload.rolloutId : null;
    const [rollout] = rolloutId
      ? await this.db.select().from(rollouts).where(eq(rollouts.id, rolloutId))
      : [];
    const from = this.versionOf(tenant);
    if (rollout && rollout.status !== 'running') {
      // Paused or cancelled meanwhile, or a retry after a failure: the version it is recorded with.
      await this.settle(tenant);
      return;
    }
    if (from === target) return;
    await this.backup(tenant, 'pre-update');
    try {
      await this.ctx.platform.ensureInstance(this.ctx.instance(tenant, target));
      await this.ready(tenant.slug);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.ctx.event(tenant.id, 'update-failed', { from, to: target, message });
      if (rollout) {
        await this.db
          .update(rollouts)
          .set({ status: 'paused', pauseReason: `${tenant.slug}: ${message}` })
          .where(and(eq(rollouts.id, rollout.id), eq(rollouts.status, 'running')));
      }
      await this.alert(
        rollout ? `rollout:${rollout.id}` : `update:${tenant.slug}`,
        `Update von ${tenant.slug} auf ${target} fehlgeschlagen`,
        `${tenant.slug} wurde mit ${target} nicht bereit: ${message}

Die Instanz geht zurück auf ${from}.${
          rollout
            ? ' Der Rollout ist angehalten. Fortsetzen: ops.js rollout resume; abbrechen: ops.js rollout cancel.'
            : ''
        }`,
      );
      await this.settle(tenant);
      return;
    }
    await this.db.update(tenants).set({ version: target }).where(eq(tenants.id, tenant.id));
    await this.ctx.event(tenant.id, 'updated', { from, to: target });
  }

  /** Runs the version the instance is recorded with; failing that, the backup before the update. */
  private async settle(tenant: TenantRow) {
    await this.ctx.platform.ensureInstance(this.ctx.instance(tenant));
    try {
      await this.ready(tenant.slug);
    } catch (error) {
      const [backup] = await this.db
        .select()
        .from(backups)
        .where(
          and(
            eq(backups.tenantId, tenant.id),
            eq(backups.kind, 'pre-update'),
            eq(backups.version, this.versionOf(tenant)),
          ),
        )
        .orderBy(desc(backups.createdAt))
        .limit(1);
      if (!backup) throw error;
      await this.ctx.event(tenant.id, 'rollback-from-backup', { backupId: backup.id });
      await this.restoreFrom(tenant, backup);
    }
  }

  /** A trial nobody uses: a backup, then route and container stop until the next request. */
  private async sleep(tenant: TenantRow) {
    if (tenant.status !== 'trial' || tenant.sleepingAt) return;
    await this.backup(tenant, 'pre-sleep');
    await this.ctx.platform.removeRoute(tenant.slug);
    await this.ctx.platform.stopInstance(tenant.slug);
    await this.db
      .update(tenants)
      .set({ sleepingAt: this.ctx.now(), healthFailures: 0, downSince: null })
      .where(eq(tenants.id, tenant.id));
    await this.ctx.event(tenant.id, 'sleeping');
    await this.resolve(`down:${tenant.slug}`);
  }

  /** Starts a sleeping instance; it follows a finished rollout it slept through. */
  async wakeUp(tenant: TenantRow) {
    if (!tenant.sleepingAt || !isLive(tenant)) return;
    const instance = this.ctx.instance(tenant);
    await this.ctx.platform.ensureInstance(instance);
    await this.ctx.waitUntilLive(this.ctx.platform.instanceUrl(tenant.slug));
    await this.ctx.platform.ensureRoute(instance);
    await this.db
      .update(tenants)
      .set({ sleepingAt: null, lastActiveAt: this.ctx.now() })
      .where(eq(tenants.id, tenant.id));
    await this.ctx.event(tenant.id, 'woken');
    const current = await this.currentVersion();
    if (this.versionOf(tenant) !== current && !(await this.activeRollout())) {
      await this.ctx.enqueue(tenant.id, 'update', { version: current });
    }
  }

  /** A request reached a sleeping instance: wake it, once. */
  async wake(tenant: TenantRow) {
    if (!tenant.sleepingAt || !isLive(tenant)) return;
    if ((await this.busy('wake')).has(tenant.id)) return;
    await this.ctx.enqueue(tenant.id, 'wake');
  }

  /** Instances with a waiting or running job of this kind. */
  private async busy(kind: JobKind): Promise<Set<string>> {
    const rows = await this.db
      .select({ tenantId: jobs.tenantId })
      .from(jobs)
      .where(and(eq(jobs.kind, kind), inArray(jobs.status, ['queued', 'running'])));
    return new Set(rows.map((row) => row.tenantId));
  }

  // ---------------------------------------------------------------- every minute

  async tick() {
    const live = await this.db.select().from(tenants).where(inArray(tenants.status, LIVE));
    await this.scheduleBackups(live);
    await this.scheduleSleep(live);
    await this.checkHealth(live);
    await this.checkCapacity();
    await this.advanceRollout();
  }

  private async scheduleBackups(live: TenantRow[]) {
    const now = this.ctx.now();
    if (now.getUTCHours() < this.config.BACKUP_HOUR) return;
    const midnight = new Date(now);
    midnight.setUTCHours(0, 0, 0, 0);
    const done = new Set(
      (
        await this.db
          .select({ tenantId: backups.tenantId })
          .from(backups)
          .where(and(eq(backups.kind, 'nightly'), gte(backups.createdAt, midnight)))
      ).map((row) => row.tenantId),
    );
    const waiting = await this.busy('backup');
    for (const tenant of live) {
      if (tenant.sleepingAt || done.has(tenant.id) || waiting.has(tenant.id)) continue;
      await this.ctx.enqueue(tenant.id, 'backup', { kind: 'nightly' });
    }
  }

  private async scheduleSleep(live: TenantRow[]) {
    const days = this.config.SLEEP_AFTER_DAYS;
    if (days === 0) return;
    const now = this.ctx.now().getTime();
    const waiting = await this.busy('sleep');
    for (const tenant of live) {
      if (tenant.status !== 'trial' || tenant.sleepingAt || waiting.has(tenant.id)) continue;
      const since = (tenant.lastActiveAt ?? tenant.createdAt).getTime();
      if (now - since >= days * DAY) await this.ctx.enqueue(tenant.id, 'sleep');
    }
  }

  /** Readiness of every running instance; three failures in a row raise an alert. */
  private async checkHealth(live: TenantRow[]) {
    const working = new Set(
      (
        await this.db
          .select({ tenantId: jobs.tenantId })
          .from(jobs)
          .where(eq(jobs.status, 'running'))
      ).map((row) => row.tenantId),
    );
    const due = live.filter((tenant) => !tenant.sleepingAt && !working.has(tenant.id));
    for (let start = 0; start < due.length; start += PROBE_BATCH) {
      const batch = due.slice(start, start + PROBE_BATCH);
      const results = await Promise.all(batch.map((tenant) => this.probe(tenant.slug)));
      for (const [index, tenant] of batch.entries()) {
        await this.recordHealth(tenant, results[index] ?? false);
      }
    }
  }

  private async recordHealth(tenant: TenantRow, ok: boolean) {
    const now = this.ctx.now();
    if (ok) {
      await this.db
        .update(tenants)
        .set({ healthFailures: 0, healthyAt: now, downSince: null })
        .where(eq(tenants.id, tenant.id));
      if (tenant.downSince) {
        await this.ctx.event(tenant.id, 'up');
        await this.resolve(
          `down:${tenant.slug}`,
          `${tenant.slug} antwortet wieder (ausgefallen seit ${tenant.downSince.toISOString()}).`,
        );
      }
      return;
    }
    const failures = tenant.healthFailures + 1;
    const down = failures >= DOWN_AFTER && !tenant.downSince;
    await this.db
      .update(tenants)
      .set({ healthFailures: failures, ...(down ? { downSince: now } : {}) })
      .where(eq(tenants.id, tenant.id));
    if (down) {
      await this.ctx.event(tenant.id, 'down');
      await this.alert(
        `down:${tenant.slug}`,
        `${tenant.slug} antwortet nicht`,
        `${tenant.slug} (${tenant.name}) ist seit ${DOWN_AFTER} Prüfungen nicht bereit (/api/v1/health/ready). Zuletzt bereit: ${tenant.healthyAt?.toISOString() ?? 'nie'}.

Nachsehen: ops.js tenant ${tenant.slug}`,
      );
    }
  }

  async capacity() {
    const [row] = await this.db
      .select({
        running: sql<number>`count(*) filter (where ${tenants.sleepingAt} is null)::int`,
        sleeping: sql<number>`count(*) filter (where ${tenants.sleepingAt} is not null)::int`,
      })
      .from(tenants)
      .where(inArray(tenants.status, ['provisioning', 'trial', 'active']));
    const running = row?.running ?? 0;
    const usedMb = running * this.config.INSTANCE_MEMORY_MB;
    const totalMb = this.config.SERVER_MEMORY_MB;
    return {
      running,
      sleeping: row?.sleeping ?? 0,
      usedMb,
      totalMb,
      ratio: usedMb / totalMb,
      /** Room for one more instance. */
      full: usedMb + this.config.INSTANCE_MEMORY_MB > totalMb,
    };
  }

  private async checkCapacity() {
    const capacity = await this.capacity();
    if (capacity.ratio >= 0.8) {
      await this.alert(
        'capacity',
        `Server zu ${Math.round(capacity.ratio * 100)} % belegt`,
        `${capacity.running} laufende Instanzen belegen ${capacity.usedMb} von ${capacity.totalMb} MB. Ab 100 % nimmt Lenipo Cloud keine neuen Anmeldungen an. Zeit für mehr Arbeitsspeicher oder einen zweiten Server.`,
      );
    } else {
      await this.resolve('capacity');
    }
  }

  // ---------------------------------------------------------------- rollouts

  async activeRollout(): Promise<RolloutRow | null> {
    const [row] = await this.db
      .select()
      .from(rollouts)
      .where(inArray(rollouts.status, ['running', 'paused']))
      .limit(1);
    return row ?? null;
  }

  async startRollout(version: string, waveSize = 10): Promise<RolloutRow> {
    if (!VERSION.test(version)) throw new Error(`Not a version: ${version}`);
    if (!Number.isInteger(waveSize) || waveSize < 1) throw new Error('The wave size is at least 1');
    const active = await this.activeRollout();
    if (active) {
      throw new Error(
        `The rollout to ${active.version} is ${active.status}; resume or cancel it first`,
      );
    }
    const [row] = await this.db
      .insert(rollouts)
      .values({
        id: randomUUID(),
        version,
        waveSize,
        status: 'running',
        createdAt: this.ctx.now(),
      })
      .returning();
    if (!row) throw new Error('Rollout row missing');
    return row;
  }

  async resumeRollout(): Promise<RolloutRow> {
    const active = await this.activeRollout();
    if (active?.status !== 'paused') throw new Error('No paused rollout');
    await this.db
      .update(rollouts)
      .set({ status: 'running', pauseReason: null })
      .where(eq(rollouts.id, active.id));
    await this.resolve(`rollout:${active.id}`, `Der Rollout auf ${active.version} läuft weiter.`);
    return { ...active, status: 'running', pauseReason: null };
  }

  /** Stops the rollout; updated instances keep the new version, new ones get the old. */
  async cancelRollout(): Promise<RolloutRow> {
    const active = await this.activeRollout();
    if (!active) throw new Error('No rollout running or paused');
    await this.db
      .update(rollouts)
      .set({ status: 'cancelled', finishedAt: this.ctx.now() })
      .where(eq(rollouts.id, active.id));
    await this.resolve(
      `rollout:${active.id}`,
      `Der Rollout auf ${active.version} ist abgebrochen.`,
    );
    return { ...active, status: 'cancelled' };
  }

  /** The next wave once the last one is through: canaries (or three) first, then waveSize each. */
  private async advanceRollout() {
    const [rollout] = await this.db.select().from(rollouts).where(eq(rollouts.status, 'running'));
    if (!rollout) return;
    const [inFlight] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, 'update'),
          inArray(jobs.status, ['queued', 'running']),
          sql`${jobs.payload}->>'rolloutId' = ${rollout.id}`,
        ),
      );
    if ((inFlight?.count ?? 0) > 0) return;
    const pending = (await this.rolloutPending(rollout.version)).filter(
      (tenant) => !tenant.sleepingAt,
    );
    if (pending.length === 0) {
      await this.db
        .update(rollouts)
        .set({ status: 'done', finishedAt: this.ctx.now() })
        .where(eq(rollouts.id, rollout.id));
      await this.mailOperator(
        `Rollout auf ${rollout.version} fertig`,
        `Alle laufenden Instanzen haben ${rollout.version}. Schlafende folgen beim Aufwachen; neue Instanzen starten mit ${rollout.version}.`,
      );
      return;
    }
    const canaries = pending.filter((tenant) => tenant.canary);
    const wave =
      rollout.waves === 0
        ? canaries.length > 0
          ? canaries
          : pending.slice(0, FIRST_WAVE)
        : pending.slice(0, rollout.waveSize);
    for (const tenant of wave) {
      await this.ctx.enqueue(tenant.id, 'update', {
        version: rollout.version,
        rolloutId: rollout.id,
      });
    }
    await this.db
      .update(rollouts)
      .set({ waves: rollout.waves + 1 })
      .where(eq(rollouts.id, rollout.id));
  }

  /** Running instances not yet on the version, oldest first. */
  private async rolloutPending(version: string) {
    const live = await this.db
      .select()
      .from(tenants)
      .where(inArray(tenants.status, LIVE))
      .orderBy(asc(tenants.createdAt), asc(tenants.slug));
    return live.filter((tenant) => this.versionOf(tenant) !== version);
  }

  async rolloutStatus() {
    const rollout = await this.activeRollout();
    if (!rollout) return null;
    const pending = await this.rolloutPending(rollout.version);
    const live = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(tenants)
      .where(inArray(tenants.status, LIVE));
    return {
      rollout,
      done: (live[0]?.count ?? 0) - pending.length,
      pending: pending.map((tenant) => tenant.slug),
    };
  }

  // ---------------------------------------------------------------- the operator

  async tenantBySlug(slug: string): Promise<TenantRow> {
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(and(eq(tenants.slug, slug), sql`${tenants.status} <> 'deleted'`));
    if (!row) throw new Error(`No instance ${slug}`);
    return row;
  }

  async tenants() {
    const rows = await this.db
      .select()
      .from(tenants)
      .where(sql`${tenants.status} <> 'deleted'`)
      .orderBy(asc(tenants.slug));
    const latest = await this.db
      .select({
        tenantId: backups.tenantId,
        at: sql<Date>`max(${backups.createdAt})`.mapWith((value) => new Date(value)),
      })
      .from(backups)
      .groupBy(backups.tenantId);
    const persons = await this.db
      .selectDistinctOn([usageSamples.tenantId], {
        tenantId: usageSamples.tenantId,
        persons: usageSamples.persons,
        storageMb: usageSamples.storageMb,
      })
      .from(usageSamples)
      .orderBy(usageSamples.tenantId, desc(usageSamples.day));
    return rows.map((tenant) => ({
      tenant,
      version: this.versionOf(tenant),
      lastBackupAt: latest.find((row) => row.tenantId === tenant.id)?.at ?? null,
      persons: persons.find((row) => row.tenantId === tenant.id)?.persons ?? null,
      storageMb: persons.find((row) => row.tenantId === tenant.id)?.storageMb ?? null,
    }));
  }

  async details(slug: string) {
    const tenant = await this.tenantBySlug(slug);
    const events = await this.db
      .select()
      .from(tenantEvents)
      .where(eq(tenantEvents.tenantId, tenant.id))
      .orderBy(desc(tenantEvents.at), desc(tenantEvents.id))
      .limit(20);
    const recentJobs = await this.db
      .select()
      .from(jobs)
      .where(eq(jobs.tenantId, tenant.id))
      .orderBy(desc(jobs.createdAt))
      .limit(10);
    return {
      tenant,
      version: this.versionOf(tenant),
      backups: await this.backupsOf(tenant.id),
      events,
      jobs: recentJobs,
    };
  }

  async setCanary(slug: string, canary: boolean) {
    const tenant = await this.tenantBySlug(slug);
    await this.db.update(tenants).set({ canary }).where(eq(tenants.id, tenant.id));
  }

  async requestBackup(slug: string) {
    const tenant = await this.tenantBySlug(slug);
    if (!isLive(tenant) || tenant.sleepingAt) throw new Error(`${slug} does not run`);
    await this.ctx.enqueue(tenant.id, 'backup', { kind: 'manual' });
  }

  async requestRestore(slug: string, backupId: string) {
    const tenant = await this.tenantBySlug(slug);
    if (!isLive(tenant)) throw new Error(`${slug} is ${tenant.status}; restore runs instances`);
    const known = (await this.backupsOf(tenant.id)).find((row) => row.id.startsWith(backupId));
    if (!known) throw new Error(`No backup ${backupId} of ${slug}`);
    await this.ctx.enqueue(tenant.id, 'restore', { backupId: known.id });
    return known;
  }

  async requestSleep(slug: string) {
    const tenant = await this.tenantBySlug(slug);
    if (tenant.status !== 'trial') throw new Error('Only trial instances sleep');
    await this.ctx.enqueue(tenant.id, 'sleep');
  }

  async requestWake(slug: string) {
    await this.wake(await this.tenantBySlug(slug));
  }

  /** Failed jobs of the instance run again, from the first attempt. */
  async retry(slug: string): Promise<number> {
    const tenant = await this.tenantBySlug(slug);
    const failed = await this.db
      .update(jobs)
      .set({ status: 'queued', attempts: 0, runAfter: this.ctx.now(), finishedAt: null })
      .where(and(eq(jobs.tenantId, tenant.id), eq(jobs.status, 'failed')))
      .returning();
    for (const job of failed) await this.resolve(`job:${job.id}`, `Neuer Versuch für ${slug}.`);
    if (failed.some((job) => job.kind === 'provision') && tenant.status === 'failed') {
      await this.db
        .update(tenants)
        .set({ status: 'provisioning' })
        .where(eq(tenants.id, tenant.id));
    }
    return failed.length;
  }

  // ---------------------------------------------------------------- overview and metrics

  /** Monthly revenue of the booked plans, net (yearly ones at their monthly price). */
  private async revenue(): Promise<{ monthly: number; paying: number }> {
    const rows = await this.db
      .select({ plan: tenants.plan, interval: tenants.interval, seats: tenants.seats })
      .from(tenants)
      .where(eq(tenants.status, 'active'));
    let monthly = 0;
    let paying = 0;
    for (const row of rows) {
      if (!row.plan || !isPlanKey(row.plan) || !row.seats) continue;
      const interval: Interval = isInterval(row.interval ?? '')
        ? (row.interval as Interval)
        : 'month';
      monthly += PLANS[row.plan].price[interval] * row.seats;
      paying += 1;
    }
    return { monthly: Math.round(monthly * 100) / 100, paying };
  }

  async overview() {
    const counts = await this.db
      .select({ status: tenants.status, count: sql<number>`count(*)::int` })
      .from(tenants)
      .groupBy(tenants.status);
    const byStatus = Object.fromEntries(counts.map((row) => [row.status, row.count]));
    const capacity = await this.capacity();
    const revenue = await this.revenue();
    const cost = this.config.SERVER_COST_EUR;
    const [failed] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(eq(jobs.status, 'failed'));
    const down = await this.db
      .select({ slug: tenants.slug, since: tenants.downSince })
      .from(tenants)
      .where(and(inArray(tenants.status, LIVE), sql`${tenants.downSince} is not null`));
    return {
      byStatus,
      capacity,
      version: await this.currentVersion(),
      rollout: await this.rolloutStatus(),
      revenue,
      cost: {
        monthly: cost,
        perInstance: capacity.running > 0 ? Math.round((cost / capacity.running) * 100) / 100 : 0,
        margin: Math.round((revenue.monthly - cost) * 100) / 100,
      },
      failedJobs: failed?.count ?? 0,
      down,
      alerts: await this.openAlerts(),
    };
  }

  /** The Prometheus text format, for /ops/metrics. */
  async metrics(): Promise<string> {
    const overview = await this.overview();
    const list = await this.tenants();
    const label = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const lines: string[] = [];
    const metric = (name: string, help: string, type: 'gauge' | 'counter' = 'gauge') => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };
    metric('lenipo_cloud_tenants', 'Instances by status');
    for (const [status, count] of Object.entries(overview.byStatus)) {
      lines.push(`lenipo_cloud_tenants{status="${label(status)}"} ${count}`);
    }
    metric('lenipo_cloud_tenants_sleeping', 'Trial instances that sleep');
    lines.push(`lenipo_cloud_tenants_sleeping ${overview.capacity.sleeping}`);
    metric('lenipo_cloud_capacity_ratio', 'Memory of the server taken by running instances');
    lines.push(`lenipo_cloud_capacity_ratio ${overview.capacity.ratio.toFixed(4)}`);
    metric('lenipo_cloud_revenue_monthly_euros', 'Monthly revenue of booked plans, net');
    lines.push(`lenipo_cloud_revenue_monthly_euros ${overview.revenue.monthly}`);
    metric('lenipo_cloud_jobs_failed', 'Jobs that gave up');
    lines.push(`lenipo_cloud_jobs_failed ${overview.failedJobs}`);
    metric('lenipo_cloud_alerts_open', 'Open alerts');
    lines.push(`lenipo_cloud_alerts_open ${overview.alerts.length}`);
    const running = list.filter(({ tenant }) => isLive(tenant) && !tenant.sleepingAt);
    metric('lenipo_tenant_up', 'Instance ready at the last check (1) or down (0)');
    for (const { tenant } of running) {
      lines.push(`lenipo_tenant_up{tenant="${label(tenant.slug)}"} ${tenant.downSince ? 0 : 1}`);
    }
    metric('lenipo_tenant_persons', 'People with a seat, from the daily reading');
    for (const { tenant, persons } of list) {
      if (persons !== null) {
        lines.push(`lenipo_tenant_persons{tenant="${label(tenant.slug)}"} ${persons}`);
      }
    }
    metric('lenipo_tenant_storage_megabytes', 'Attachments, from the daily reading');
    for (const { tenant, storageMb } of list) {
      if (storageMb !== null) {
        lines.push(`lenipo_tenant_storage_megabytes{tenant="${label(tenant.slug)}"} ${storageMb}`);
      }
    }
    metric('lenipo_tenant_last_backup_timestamp_seconds', 'Time of the newest backup');
    for (const { tenant, lastBackupAt } of list) {
      if (lastBackupAt) {
        lines.push(
          `lenipo_tenant_last_backup_timestamp_seconds{tenant="${label(tenant.slug)}"} ${Math.floor(lastBackupAt.getTime() / 1000)}`,
        );
      }
    }
    metric('lenipo_tenant_info', 'Version of each instance');
    for (const { tenant, version } of list) {
      lines.push(
        `lenipo_tenant_info{tenant="${label(tenant.slug)}",version="${label(version)}",status="${tenant.status}"} 1`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}
