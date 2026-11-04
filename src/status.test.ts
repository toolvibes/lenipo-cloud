import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { availabilityDays, jobs, tenants } from './db/schema.js';
import { parseBerlin, runOps } from './operator.js';
import { describeWindow, inWindow } from './status.js';
import { startTestCloud, type TestCloud } from './test/harness.js';

let t: TestCloud;
const DAY = 86_400_000;
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const post = (url: string, fields: Record<string, string> = {}, cookie = '') =>
  t.app.inject({
    method: 'POST',
    url,
    payload: form(fields),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  });
const get = (url: string, cookie = '') => t.app.inject({ method: 'GET', url, headers: { cookie } });
const tokenOf = (link: string) => new URL(link).searchParams.get('token') ?? '';
const ops = (...args: string[]) => runOps(t.cloud.fleet, args, t.cloud.compliance, t.cloud.status);
const minute = async () => {
  t.clock.now = new Date(t.clock.now.getTime() + 60_000);
  await t.cloud.tick();
  await t.cloud.runJobs();
};
const tenantBySlug = async (slug: string) => {
  const [row] = await t.database.db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!row) throw new Error(`No tenant ${slug}`);
  return row;
};
let cookie = '';

async function signUp(email: string, slug: string) {
  await post('/signup', { email, name: `Firma ${slug}`, slug, business: 'on', terms: 'on' });
  const confirmed = await post('/signup/confirm', { token: tokenOf(t.mailer.linkTo(email)) });
  await t.cloud.runJobs();
  return String(confirmed.headers['set-cookie']).split(';')[0] ?? '';
}

beforeAll(async () => {
  // Tuesday 2026-11-03 10:00 UTC is 11:00 in Germany: after the window.
  t = await startTestCloud({
    MAINTENANCE_WINDOW: 'tue 06:00-08:00',
    SUPPORT_URL: 'https://support.lenipo.test/portal',
  });
  cookie = await signUp('mia@mess.example', 'mess');
});

afterAll(async () => {
  await t?.close();
});

describe('maintenance window (TL-106)', () => {
  it('reads the window in German time, summer and winter', () => {
    // 2026-11-10 is a Tuesday in winter time (UTC+1).
    expect(inWindow('tue 06:00-08:00', new Date('2026-11-10T05:00:00Z'))).toBe(true);
    expect(inWindow('tue 06:00-08:00', new Date('2026-11-10T06:59:00Z'))).toBe(true);
    expect(inWindow('tue 06:00-08:00', new Date('2026-11-10T07:00:00Z'))).toBe(false);
    expect(inWindow('tue 06:00-08:00', new Date('2026-11-11T05:30:00Z'))).toBe(false);
    // 2026-07-07 is a Tuesday in summer time (UTC+2).
    expect(inWindow('tue 06:00-08:00', new Date('2026-07-07T04:30:00Z'))).toBe(true);
    expect(describeWindow('tue 06:00-08:00')).toBe('dienstags 06:00–08:00 Uhr (deutsche Zeit)');
    expect(parseBerlin('2026-11-10 06:00').toISOString()).toBe('2026-11-10T05:00:00.000Z');
    expect(parseBerlin('2026-07-07 06:00').toISOString()).toBe('2026-07-07T04:00:00.000Z');
  });

  it('starts rollout waves only within the window, unless --now', async () => {
    expect(await ops('rollout', 'start', '1.1.0')).toContain('im Wartungsfenster');
    await minute();
    const queued = () =>
      t.database.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.kind, 'update')));
    expect(await queued()).toHaveLength(0);
    // Next Tuesday 06:30 German time.
    const before = t.clock.now;
    t.clock.now = new Date('2026-11-10T05:29:00Z');
    await minute();
    expect((await queued()).length).toBeGreaterThan(0);
    await ops('rollout', 'cancel');
    t.clock.now = before;
  });
});

describe('availability (TL-106)', () => {
  it('counts checked and failed minutes and shows the month in the account', async () => {
    const mess = await tenantBySlug('mess');
    await t.database.db.delete(availabilityDays);
    for (let index = 0; index < 4; index += 1) await minute();
    t.down.add('mess');
    await minute();
    await minute();
    t.down.delete('mess');
    await minute();
    const month = t.clock.now.toISOString().slice(0, 7);
    const availability = await t.cloud.status.availability(mess.id, month);
    expect(availability).toMatchObject({ checked: 7, failed: 2, maintenance: 0, breached: true });
    expect(availability.ratio).toBeCloseTo(5 / 7);
    const account = (await get('/account', cookie)).body;
    expect(account).toContain(
      'Verfügbarkeit: November 2026 71,43 % (unter 99,5 %: Gutschrift auf Antrag)',
    );
    expect(account).toContain('https://support.lenipo.test/portal');
    expect(await ops('availability', 'mess', month)).toContain('Gutschrift auf Antrag');
  });

  it('does not count failures within announced maintenance', async () => {
    const mess = await tenantBySlug('mess');
    await t.database.db.delete(availabilityDays);
    const start = new Date(t.clock.now.getTime() + 4 * DAY);
    await t.cloud.status.planMaintenance(start, 30, 'Umzug der Datenbank');
    t.clock.now = new Date(start.getTime() + 5 * 60_000);
    t.down.add('mess');
    await minute();
    await minute();
    t.down.delete('mess');
    const availability = await t.cloud.status.availability(
      mess.id,
      t.clock.now.toISOString().slice(0, 7),
    );
    expect(availability).toMatchObject({ checked: 2, failed: 0, maintenance: 2, ratio: 1 });
    t.clock.now = new Date(start.getTime() + 60 * 60_000);
    await minute();
  });
});

describe('incidents, maintenance and the status page (TL-106)', () => {
  it('opens an incident by itself when instances fail and closes it when they answer', async () => {
    t.down.add('mess');
    for (let index = 0; index < 3; index += 1) await minute();
    const json = await get('/status.json');
    expect(json.headers['access-control-allow-origin']).toBe('*');
    const status = JSON.parse(json.body);
    expect(status.state).toBe('outage');
    expect(status.active[0]).toMatchObject({
      title: 'Umgebungen nicht erreichbar',
      kind: 'incident',
    });
    expect(status.components.instances).toEqual({ running: 1, ready: 0 });
    t.down.delete('mess');
    await minute();
    const after = JSON.parse((await get('/status.json')).body);
    expect(after.state).toBe('operational');
    expect(after.recent[0].updates.at(-1).text).toBe('Alle Umgebungen antworten wieder.');
  });

  it('lets the operator report incidents with updates', async () => {
    const opened = await ops(
      'incident',
      'open',
      'Langsame Suche',
      'Wir sehen lange Antwortzeiten.',
    );
    const id = /#(\d+)/.exec(opened)?.[1] ?? '';
    await ops('incident', 'update', id, 'Ursache gefunden.');
    const page = (await get('/status')).body;
    expect(page).toContain('Störung</div>');
    expect(page).toContain('Langsame Suche');
    expect(page).toContain('Ursache gefunden.');
    expect(await ops('incidents')).toContain('Langsame Suche');
    await ops('incident', 'resolve', id);
    expect((await get('/status')).body).toContain('Alle Systeme betriebsbereit');
  });

  it('announces maintenance three days ahead, also in the instances', async () => {
    const soon = new Date(t.clock.now.getTime() + DAY);
    await expect(t.cloud.status.planMaintenance(soon, 60, 'Zu kurzfristig')).rejects.toThrow(
      '3 days ahead',
    );
    const start = new Date(t.clock.now.getTime() + 5 * DAY);
    const planned = await t.cloud.status.planMaintenance(start, 60, 'Neuer Server');
    expect((await get('/status')).body).toContain('Geplante Wartungen');
    await minute();
    // Five days ahead: not yet in the instances.
    expect(t.notices.get('mess')?.text ?? '').toBe('');
    t.clock.now = new Date(start.getTime() - 2 * DAY);
    await minute();
    expect(t.notices.get('mess')).toMatchObject({ level: 'info' });
    expect(t.notices.get('mess')?.text).toContain('**Geplante Wartung**');
    expect(t.notices.get('mess')?.text).toContain('Neuer Server');
    t.clock.now = new Date(start.getTime() + 10 * 60_000);
    await minute();
    expect(t.notices.get('mess')?.level).toBe('warning');
    expect(JSON.parse((await get('/status.json')).body).state).toBe('maintenance');
    await ops('maintenance', 'cancel', String(planned.id));
    await minute();
    expect(t.notices.get('mess')?.text).toBe('');
  });
});

describe('support (TL-106)', () => {
  it('gives every instance the support link and keeps internal instances out of the trial', async () => {
    expect(t.limits.get('mess')).toMatchObject({
      supportUrl: 'https://support.lenipo.test/portal',
    });
    await signUp('team@servicedesk.example', 'servicedesk');
    expect(await ops('internal', 'servicedesk', 'on')).toContain('intern');
    await t.cloud.runJobs();
    expect(t.limits.get('servicedesk')).toEqual({
      plan: 'Intern',
      supportUrl: 'https://support.lenipo.test/portal',
    });
    t.clock.now = new Date(t.clock.now.getTime() + 40 * DAY);
    await t.cloud.tick();
    expect((await tenantBySlug('servicedesk')).status).toBe('trial');
    expect((await tenantBySlug('mess')).status).toBe('suspended');
  });
});
