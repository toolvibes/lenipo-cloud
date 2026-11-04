import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobs, tenants } from './db/schema.js';
import { startTestCloud, type TestCloud } from './test/harness.js';

let t: TestCloud;
let cookie = '';
const DAY = 86_400_000;

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  t.app.inject({
    method: 'POST',
    url,
    payload: form(fields),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...headers },
  });
const get = (url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, headers: { cookie, ...headers } });
const tokenOf = (link: string) => new URL(link).searchParams.get('token') ?? '';
const tenantBySlug = async (slug: string) => {
  const [row] = await t.database.db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!row) throw new Error(`No tenant ${slug}`);
  return row;
};
const lastMailTo = (address: string) => t.mailer.sent.findLast((mail) => mail.to === address);
const advance = (days: number) => {
  t.clock.now = new Date(t.clock.now.getTime() + days * DAY);
};

beforeAll(async () => {
  t = await startTestCloud();
});

afterAll(async () => {
  await t?.close();
});

describe('sign-up and provisioning', () => {
  it('checks the address before it sends a confirmation link', async () => {
    const reserved = await post('/signup', {
      email: 'a@acme.example',
      name: 'Acme',
      slug: 'admin',
    });
    expect(reserved.statusCode).toBe(400);
    expect(reserved.body).toContain('reserviert');
    const invalid = await post('/signup', { email: 'a@acme.example', name: 'Acme', slug: 'A!' });
    expect(invalid.body).toContain('3 bis 30 Zeichen');
    // What people type comes back escaped.
    const markup = await post('/signup', {
      email: 'a@acme.example',
      name: '<script>alert(1)</script>',
      slug: 'admin',
    });
    expect(markup.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup.body).not.toContain('<script>alert');

    const ok = await post('/signup', {
      email: 'Clara@Acme.example',
      name: 'Acme GmbH',
      slug: 'acme',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('clara@acme.example');
    expect(t.mailer.sent.at(-1)?.subject).toBe('Lenipo: Bitte bestätigen Sie Ihre Anmeldung');
    // The name waits for the confirmation and is not given twice.
    const twice = await post('/signup', { email: 'b@other.example', name: 'Other', slug: 'acme' });
    expect(twice.body).toContain('schon vergeben');
  });

  it('creates the instance once confirmed and mails the invitation of its administrator', async () => {
    const token = tokenOf(t.mailer.linkTo('clara@acme.example'));
    // Following the link only shows a button: mail scanners do not use it up.
    expect((await get(`/signup/confirm?token=${token}`)).body).toContain('acme.lenipo.test');
    const confirmed = await post('/signup/confirm', { token });
    expect(confirmed.statusCode).toBe(303);
    expect(confirmed.headers.location).toBe('/account?ok=signup');
    cookie = String(confirmed.headers['set-cookie']).split(';')[0] ?? '';
    expect((await post('/signup/confirm', { token })).statusCode).toBe(410);
    expect((await tenantBySlug('acme')).status).toBe('provisioning');

    await t.cloud.runJobs();
    const tenant = await tenantBySlug('acme');
    expect(tenant.status).toBe('trial');
    expect(tenant.trialEndsAt?.toISOString()).toBe('2026-12-03T10:00:00.000Z');
    const state = t.platform.state.get('acme');
    expect(state).toMatchObject({
      database: true,
      container: 'running',
      hosts: ['acme.lenipo.test'],
    });
    expect(state?.env).toMatchObject({
      PUBLIC_URL: 'https://acme.lenipo.test',
      STORAGE_DRIVER: 'local',
    });
    expect(state?.env.DATABASE_URL).toMatch(/^postgres:\/\/t_acme:.+@postgres:5432\/t_acme$/);
    expect(t.setupCalls).toEqual([
      {
        slug: 'acme',
        body: { instanceName: 'Acme GmbH', admin: { email: 'clara@acme.example' } },
        token: state?.env.SETUP_TOKEN,
      },
    ]);
    const welcome = t.mailer.sent.at(-1);
    expect(welcome?.subject).toBe('Lenipo: Ihre Umgebung ist bereit');
    expect(welcome?.text).toContain('https://acme.lenipo.test/invite?token=einladung-acme');

    const account = await get('/account');
    expect(account.body).toContain('https://acme.lenipo.test');
    expect(account.body).toContain('Testphase bis 3.12.2026');
  });

  it('retries a failed step later', async () => {
    await post('/signup', { email: 'bob@bau.example', name: 'Bau', slug: 'bau' });
    const other = await post('/signup/confirm', {
      token: tokenOf(t.mailer.linkTo('bob@bau.example')),
    });
    expect(other.statusCode).toBe(303);
    t.platform.failOnce.add('ensureInstance');
    await t.cloud.runJobs();
    const [job] = await t.database.db
      .select()
      .from(jobs)
      .where(eq(jobs.tenantId, (await tenantBySlug('bau')).id));
    expect(job).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastError: 'ensureInstance failed (test)',
    });
    expect((await tenantBySlug('bau')).status).toBe('provisioning');
    advance(0.01);
    await t.cloud.runJobs();
    expect((await tenantBySlug('bau')).status).toBe('trial');
  });
});

describe('sign-in by link', () => {
  it('sends a link only to customers and signs in once', async () => {
    const before = t.mailer.sent.length;
    const unknown = await post('/login', { email: 'niemand@example.org' });
    expect(unknown.body).toContain('Anmeldelink unterwegs');
    expect(t.mailer.sent.length).toBe(before);

    await post('/login', { email: 'clara@acme.example' });
    const token = tokenOf(t.mailer.linkTo('clara@acme.example'));
    const signedIn = await t.app.inject({
      method: 'POST',
      url: '/login/confirm',
      payload: form({ token }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(signedIn.headers.location).toBe('/account');
    expect((await post('/login/confirm', { token })).statusCode).toBe(410);
  });

  it('refuses forms from other sites', async () => {
    const response = await post('/logout', {}, { origin: 'https://evil.example' });
    expect(response.statusCode).toBe(403);
  });
});

describe('own domain', () => {
  it('routes the domain once DNS points to the instance', async () => {
    const acme = await tenantBySlug('acme');
    await post(`/account/tenants/${acme.id}/domain`, { domain: 'projekte.acme.example' });
    expect(await t.cloud.tlsAllowed('projekte.acme.example')).toBe(false);
    const early = await post(`/account/tenants/${acme.id}/domain/verify`, {});
    expect(early.headers.location).toBe('/account?error=dns');

    t.dns.cname.set('projekte.acme.example', ['acme.lenipo.test.']);
    const verified = await post(`/account/tenants/${acme.id}/domain/verify`, {});
    expect(verified.headers.location).toBe('/account?ok=verified');
    await t.cloud.runJobs();
    expect(t.platform.state.get('acme')).toMatchObject({
      hosts: ['projekte.acme.example', 'acme.lenipo.test'],
      env: { PUBLIC_URL: 'https://projekte.acme.example' },
    });
    expect(await t.cloud.tlsAllowed('projekte.acme.example')).toBe(true);
    expect(await t.cloud.tlsAllowed('fremd.example')).toBe(false);
    // Another customer cannot take the same domain.
    const bau = await tenantBySlug('bau');
    await expect(
      t.cloud.setDomain(bau.customerId, bau.id, 'projekte.acme.example'),
    ).rejects.toThrow('schon eingetragen');
  });
});

describe('cancellation', () => {
  it('stops at once when cancelled in the trial', async () => {
    const bau = await tenantBySlug('bau');
    await t.cloud.cancel(bau.customerId, bau.id);
    expect(await tenantBySlug('bau')).toMatchObject({
      status: 'suspended',
      suspendReason: 'cancelled',
    });
    await t.cloud.runJobs();
    expect((await tenantBySlug('bau')).exportReadyAt).not.toBeNull();
    await expect(t.cloud.cancel(bau.customerId, bau.id)).rejects.toThrow('läuft nicht');
  });
});

describe('trial, export and deletion', () => {
  it('reminds, stops after the trial and offers the export', async () => {
    advance(23);
    await t.cloud.tick();
    expect(lastMailTo('clara@acme.example')?.subject).toBe(
      'Lenipo: Ihre Testphase endet in 7 Tagen',
    );
    advance(6.2);
    await t.cloud.tick();
    expect(lastMailTo('clara@acme.example')?.subject).toBe('Lenipo: Ihre Testphase endet morgen');
    advance(1);
    await t.cloud.tick();
    const acme = await tenantBySlug('acme');
    expect(acme).toMatchObject({ status: 'suspended', suspendReason: 'trial-ended' });
    // The address shows that the instance is stopped.
    const visit = await t.app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'acme.lenipo.test' },
    });
    expect(visit.statusCode).toBe(503);
    expect(visit.body).toContain('angehalten');

    await t.cloud.runJobs();
    expect(t.platform.state.get('acme')).toMatchObject({ container: 'stopped', hosts: [] });
    const exported = await tenantBySlug('acme');
    expect(exported.exportFile).toMatch(/acme-.+\.zip$/);
    expect(await readFile(exported.exportFile ?? '', 'utf8')).toMatch(/^PK export of acme #\d+$/);
    expect(lastMailTo('clara@acme.example')?.subject).toBe('Lenipo: Ihr Export steht bereit');
    // Sessions last 14 days; sign in again by link.
    expect((await get('/account')).headers.location).toBe('/login');
    await post('/login', { email: 'clara@acme.example' });
    const login = await post('/login/confirm', {
      token: tokenOf(t.mailer.linkTo('clara@acme.example')),
    });
    cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    const download = await get(`/account/tenants/${acme.id}/export`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toBe('attachment; filename="lenipo-acme.zip"');
  });

  it('deletes everything after the retention and frees the name', async () => {
    advance(29.5);
    await t.cloud.tick();
    expect(lastMailTo('clara@acme.example')?.subject).toBe(
      'Lenipo: Ihre Daten werden morgen gelöscht',
    );
    advance(1);
    await t.cloud.tick();
    expect((await tenantBySlug('acme')).status).toBe('deleting');
    await t.cloud.runJobs();
    const acme = await tenantBySlug('acme');
    expect(acme).toMatchObject({ status: 'deleted', exportFile: null, customDomain: null });
    expect(t.platform.state.get('acme')).toMatchObject({ database: false, container: null });
    expect(lastMailTo('clara@acme.example')?.subject).toBe('Lenipo: Ihre Daten sind gelöscht');
    expect(await t.cloud.slugProblem('acme')).toBeNull();
  });
});
