import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import { availabilityDays, type IncidentKind, incidents, tenants } from './db/schema.js';

const DAY = 86_400_000;
const ZONE = 'Europe/Berlin';
/** Planned maintenance is announced at least this long before (E-158). */
export const MAINTENANCE_NOTICE_DAYS = 3;
/** What the availability promise covers, per instance and month (E-158). */
export const PROMISED = 0.995;

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const WEEKDAY_NAMES = [
  'sonntags',
  'montags',
  'dienstags',
  'mittwochs',
  'donnerstags',
  'freitags',
  'samstags',
];

export class StatusError extends Error {}

type IncidentRow = typeof incidents.$inferSelect;

interface Window {
  day: number;
  from: number;
  to: number;
}

function parseWindow(spec: string): Window | 'always' {
  if (spec === 'always') return 'always';
  const match = /^(\w{3}) (\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(spec);
  const day = WEEKDAYS.indexOf((match?.[1] ?? '') as (typeof WEEKDAYS)[number]);
  if (!match || day < 0) throw new Error(`MAINTENANCE_WINDOW: ${spec}`);
  return {
    day,
    from: Number(match[2]) * 60 + Number(match[3]),
    to: Number(match[4]) * 60 + Number(match[5]),
  };
}

/** Weekday (0 = Sunday) and minute of the day in Europe/Berlin. */
function berlin(now: Date): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return {
    day: WEEKDAYS.indexOf(part('weekday').toLowerCase().slice(0, 3) as (typeof WEEKDAYS)[number]),
    minute: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

/** Whether `now` lies in the weekly maintenance window. */
export function inWindow(spec: string, now: Date): boolean {
  const window = parseWindow(spec);
  if (window === 'always') return true;
  const { day, minute } = berlin(now);
  return day === window.day && minute >= window.from && minute < window.to;
}

/** "dienstags 06:00–08:00 Uhr" */
export function describeWindow(spec: string): string {
  const window = parseWindow(spec);
  if (window === 'always') return 'jederzeit';
  const time = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return `${WEEKDAY_NAMES[window.day]} ${time(window.from)}–${time(window.to)} Uhr (deutsche Zeit)`;
}

export const berlinDateTime = (value: Date) =>
  value.toLocaleString('de-DE', {
    timeZone: ZONE,
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const berlinTime = (value: Date) =>
  value.toLocaleTimeString('de-DE', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' });

export interface Notice {
  text: string;
  level: 'info' | 'warning';
  startsAt: string | null;
  endsAt: string | null;
}

export interface StatusContext {
  config: Config;
  database: Database;
  now: () => Date;
}

export type OverallState = 'operational' | 'degraded' | 'maintenance' | 'outage';

/**
 * Status, availability and maintenance of Lenipo Cloud (TL-106, E-158): minutes checked and
 * failed per instance and day, incidents and planned maintenance for the status page, and the
 * provider notice the instances show before maintenance.
 */
export class StatusBoard {
  constructor(private readonly ctx: StatusContext) {}

  private get db() {
    return this.ctx.database.db;
  }

  // ---------------------------------------------------------------- measuring

  /**
   * Whether failures now count as maintenance: the weekly window, or maintenance announced at
   * least three days ahead. Urgent maintenance counts as downtime (E-158).
   */
  async maintenanceNow(): Promise<boolean> {
    const now = this.ctx.now();
    if (inWindow(this.ctx.config.MAINTENANCE_WINDOW, now)) return true;
    return (await this.activeMaintenance()).some(
      (row) => row.startsAt.getTime() - row.createdAt.getTime() >= MAINTENANCE_NOTICE_DAYS * DAY,
    );
  }

  /** One check of one instance, counted on its day (UTC). */
  async record(tenantId: string, ok: boolean, maintenance: boolean) {
    const day = this.ctx.now().toISOString().slice(0, 10);
    const failed = ok ? 0 : maintenance ? 0 : 1;
    const inMaintenance = !ok && maintenance ? 1 : 0;
    await this.db
      .insert(availabilityDays)
      .values({ tenantId, day, checked: 1, failed, maintenance: inMaintenance })
      .onConflictDoUpdate({
        target: [availabilityDays.tenantId, availabilityDays.day],
        set: {
          checked: sql`${availabilityDays.checked} + 1`,
          failed: sql`${availabilityDays.failed} + ${failed}`,
          maintenance: sql`${availabilityDays.maintenance} + ${inMaintenance}`,
        },
      });
  }

  /** Availability of one instance in a month ("2026-11"): checked minutes that did not fail. */
  async availability(tenantId: string, month: string) {
    const [row] = await this.db
      .select({
        checked: sql<number>`coalesce(sum(${availabilityDays.checked}), 0)::int`,
        failed: sql<number>`coalesce(sum(${availabilityDays.failed}), 0)::int`,
        maintenance: sql<number>`coalesce(sum(${availabilityDays.maintenance}), 0)::int`,
      })
      .from(availabilityDays)
      .where(
        and(
          eq(availabilityDays.tenantId, tenantId),
          sql`to_char(${availabilityDays.day}, 'YYYY-MM') = ${month}`,
        ),
      );
    const checked = row?.checked ?? 0;
    const failed = row?.failed ?? 0;
    return {
      month,
      checked,
      failed,
      maintenance: row?.maintenance ?? 0,
      ratio: checked > 0 ? (checked - failed) / checked : null,
      /** Below the promise of the paid plans. */
      breached: checked > 0 && (checked - failed) / checked < PROMISED,
    };
  }

  // ---------------------------------------------------------------- incidents

  async openIncident(title: string, text: string, automatic = false): Promise<IncidentRow> {
    const now = this.ctx.now();
    const [row] = await this.db
      .insert(incidents)
      .values({
        kind: 'incident',
        title,
        updates: text ? [{ at: now.toISOString(), text }] : [],
        startsAt: now,
        automatic,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error('Incident row missing');
    return row;
  }

  async updateIncident(id: number, text: string): Promise<IncidentRow> {
    const row = await this.incident(id);
    const updates = [...row.updates, { at: this.ctx.now().toISOString(), text }];
    await this.db.update(incidents).set({ updates }).where(eq(incidents.id, id));
    return { ...row, updates };
  }

  async resolveIncident(id: number, text = 'Behoben.'): Promise<IncidentRow> {
    const row = await this.incident(id);
    if (row.resolvedAt) throw new StatusError(`#${id} is resolved already`);
    const now = this.ctx.now();
    const updates = [...row.updates, { at: now.toISOString(), text }];
    await this.db
      .update(incidents)
      .set({
        updates,
        resolvedAt: now,
        ...(row.kind === 'maintenance' && row.endsAt && row.endsAt > now ? { endsAt: now } : {}),
      })
      .where(eq(incidents.id, id));
    return { ...row, updates, resolvedAt: now };
  }

  /** Planned maintenance; at least three days ahead unless `urgent` (security fixes). */
  async planMaintenance(
    startsAt: Date,
    minutes: number,
    title: string,
    urgent = false,
  ): Promise<IncidentRow> {
    const now = this.ctx.now();
    if (Number.isNaN(startsAt.getTime())) throw new StatusError('Start is no date');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
      throw new StatusError('Duration between 1 and 1440 minutes');
    }
    if (!urgent && startsAt.getTime() < now.getTime() + MAINTENANCE_NOTICE_DAYS * DAY) {
      throw new StatusError(
        `Maintenance is announced ${MAINTENANCE_NOTICE_DAYS} days ahead; --urgent only for security fixes`,
      );
    }
    const [row] = await this.db
      .insert(incidents)
      .values({
        kind: 'maintenance',
        title,
        updates: [],
        startsAt,
        endsAt: new Date(startsAt.getTime() + minutes * 60_000),
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error('Maintenance row missing');
    return row;
  }

  async cancelMaintenance(id: number): Promise<IncidentRow> {
    const row = await this.incident(id);
    if (row.kind !== 'maintenance') throw new StatusError(`#${id} is no maintenance`);
    return this.resolveIncident(id, 'Abgesagt.');
  }

  private async incident(id: number): Promise<IncidentRow> {
    const [row] = await this.db.select().from(incidents).where(eq(incidents.id, id));
    if (!row) throw new StatusError(`No incident #${id}`);
    return row;
  }

  async openIncidents(kind?: IncidentKind) {
    return this.db
      .select()
      .from(incidents)
      .where(and(isNull(incidents.resolvedAt), kind ? eq(incidents.kind, kind) : undefined))
      .orderBy(asc(incidents.startsAt));
  }

  private async activeMaintenance() {
    const now = this.ctx.now();
    return this.db
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.kind, 'maintenance'),
          isNull(incidents.resolvedAt),
          lte(incidents.startsAt, now),
          gte(incidents.endsAt, now),
        ),
      );
  }

  /**
   * Many instances failing at once is an incident of the service: opened by itself, resolved by
   * itself once all answer again (E-158). Single instances only alert the operator.
   */
  async checkOutage(): Promise<'opened' | 'resolved' | null> {
    const [row] = await this.db
      .select({
        running: sql<number>`count(*) filter (where ${tenants.sleepingAt} is null)::int`,
        down: sql<number>`count(*) filter (where ${tenants.sleepingAt} is null and ${tenants.downSince} is not null)::int`,
      })
      .from(tenants)
      .where(inArray(tenants.status, ['trial', 'active']));
    const running = row?.running ?? 0;
    const down = row?.down ?? 0;
    const [open] = await this.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.automatic, true), isNull(incidents.resolvedAt)));
    if (await this.maintenanceNow()) return null;
    if ((await this.activeMaintenance()).length > 0) return null;
    const threshold = Math.max(Math.min(3, running), Math.ceil(running * 0.2), 1);
    if (!open && down >= threshold) {
      await this.openIncident(
        'Umgebungen nicht erreichbar',
        `${down} von ${running} Umgebungen antworten nicht. Wir sind informiert und arbeiten daran.`,
        true,
      );
      return 'opened';
    }
    if (open && down === 0) {
      await this.resolveIncident(open.id, 'Alle Umgebungen antworten wieder.');
      return 'resolved';
    }
    return null;
  }

  // ---------------------------------------------------------------- notice in the instances

  /** The banner the instances show: maintenance from three days before until its end. */
  async desiredNotice(): Promise<{ notice: Notice; version: string }> {
    const now = this.ctx.now();
    const [next] = await this.db
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.kind, 'maintenance'),
          isNull(incidents.resolvedAt),
          gte(incidents.endsAt, now),
          lte(incidents.startsAt, new Date(now.getTime() + MAINTENANCE_NOTICE_DAYS * DAY)),
        ),
      )
      .orderBy(asc(incidents.startsAt))
      .limit(1);
    const notice: Notice = next?.endsAt
      ? {
          text: `**Geplante Wartung** am ${berlinDateTime(next.startsAt)} bis ${berlinTime(next.endsAt)} Uhr: ${next.title}. Lenipo ist in dieser Zeit möglicherweise nicht erreichbar. Mehr unter ${this.ctx.config.CLOUD_URL.replace(/\/+$/, '')}/status`,
          level: next.startsAt <= now ? 'warning' : 'info',
          startsAt: null,
          endsAt: next.endsAt.toISOString(),
        }
      : { text: '', level: 'info', startsAt: null, endsAt: null };
    const version = createHash('sha256').update(JSON.stringify(notice)).digest('hex').slice(0, 16);
    return { notice, version };
  }

  // ---------------------------------------------------------------- the status page

  async overview() {
    const now = this.ctx.now();
    const [counts] = await this.db
      .select({
        running: sql<number>`count(*) filter (where ${tenants.sleepingAt} is null)::int`,
        down: sql<number>`count(*) filter (where ${tenants.sleepingAt} is null and ${tenants.downSince} is not null)::int`,
      })
      .from(tenants)
      .where(inArray(tenants.status, ['trial', 'active']));
    const open = await this.openIncidents();
    const active = open.filter(
      (row) => row.kind === 'incident' || (row.startsAt <= now && (row.endsAt ?? now) >= now),
    );
    const upcoming = open.filter((row) => row.kind === 'maintenance' && row.startsAt > now);
    const since = new Date(now.getTime() - 89 * DAY);
    const recent = await this.db
      .select()
      .from(incidents)
      .where(
        and(
          isNotNull(incidents.resolvedAt),
          gte(incidents.startsAt, since),
          or(eq(incidents.kind, 'incident'), eq(incidents.kind, 'maintenance')),
        ),
      )
      .orderBy(desc(incidents.startsAt))
      .limit(20);
    const days = await this.db
      .select({
        day: availabilityDays.day,
        checked: sql<number>`sum(${availabilityDays.checked})::int`,
        failed: sql<number>`sum(${availabilityDays.failed})::int`,
      })
      .from(availabilityDays)
      .where(gte(availabilityDays.day, since.toISOString().slice(0, 10)))
      .groupBy(availabilityDays.day);
    const byDay = new Map(days.map((row) => [row.day, row]));
    const history = Array.from({ length: 90 }, (_, index) => {
      const day = new Date(since.getTime() + index * DAY).toISOString().slice(0, 10);
      const row = byDay.get(day);
      return {
        day,
        availability: row && row.checked > 0 ? (row.checked - row.failed) / row.checked : null,
        incidents: [...recent, ...open]
          .filter(
            (item) => item.kind === 'incident' && item.startsAt.toISOString().slice(0, 10) === day,
          )
          .map((item) => item.title),
      };
    });
    const running = counts?.running ?? 0;
    const down = counts?.down ?? 0;
    const state: OverallState = active.some((row) => row.kind === 'incident')
      ? 'outage'
      : active.length > 0
        ? 'maintenance'
        : down > 0
          ? 'degraded'
          : 'operational';
    const item = (row: IncidentRow) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt?.toISOString() ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      updates: row.updates,
    });
    return {
      state,
      generatedAt: now.toISOString(),
      components: {
        service: 'operational' as const,
        instances: { running, ready: running - down },
      },
      maintenanceWindow: describeWindow(this.ctx.config.MAINTENANCE_WINDOW),
      active: active.map(item),
      upcoming: upcoming.map(item),
      recent: recent.map(item),
      history,
    };
  }
}
