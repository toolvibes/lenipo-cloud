import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Compliance } from './compliance.js';
import { acceptances, customers, signups, tenants } from './db/schema.js';
import { fileKey, openFile, sealFile } from './files.js';
import { DEFAULT_LEGAL_DIR, DOCUMENT_KEYS, DOCUMENTS, Legal } from './legal.js';
import { startTestCloud, type TestCloud } from './test/harness.js';
import { markdown } from './views/markdown.js';

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
const advance = (days: number) => {
  t.clock.now = new Date(t.clock.now.getTime() + days * DAY);
};
const lastMailTo = (address: string) => t.mailer.sent.findLast((mail) => mail.to === address);
const tenantBySlug = async (slug: string) => {
  const [row] = await t.database.db.select().from(tenants).where(eq(tenants.slug, slug));
  if (!row) throw new Error(`No tenant ${slug}`);
  return row;
};
const customerByEmail = async (email: string) => {
  const [row] = await t.database.db.select().from(customers).where(eq(customers.email, email));
  return row ?? null;
};

/** Signs up, confirms and provisions; returns the session cookie. */
async function signUp(email: string, slug: string): Promise<string> {
  const answer = await post('/signup', {
    email,
    name: `Firma ${slug}`,
    slug,
    business: 'on',
    terms: 'on',
  });
  expect(answer.statusCode).toBe(200);
  const confirmed = await post('/signup/confirm', { token: tokenOf(t.mailer.linkTo(email)) });
  await t.cloud.runJobs();
  return String(confirmed.headers['set-cookie']).split(';')[0] ?? '';
}

beforeAll(async () => {
  t = await startTestCloud();
});

afterAll(async () => {
  await t?.close();
});

describe('legal documents (TL-105)', () => {
  it('serves every document, its versions and an index, all linked from each page', async () => {
    for (const document of DOCUMENT_KEYS) {
      const answer = await get(`/${document}`);
      expect(answer.statusCode).toBe(200);
      expect(answer.body).toContain(`<h1>${DOCUMENTS[document].title}</h1>`);
      expect(answer.body).toContain('Fassung 1 vom');
      expect(answer.body).toContain('<a href="/impressum">Impressum</a>');
    }
    expect((await get('/avv/v/1')).body).toContain('Art. 28');
    expect((await get('/agb/v/9')).statusCode).toBe(404);
    const index = await get('/rechtliches');
    for (const document of DOCUMENT_KEYS) {
      expect(index.body).toContain(`href="/${document}"`);
    }
    // The sub-processors are a table; Germany as the place of the data.
    const list = (await get('/unterauftragnehmer')).body;
    expect(list).toContain('<td>Hetzner Online GmbH');
    expect(list).toContain('ausschließlich in Rechenzentren in Deutschland');
  });

  it('names the places someone still has to fill in before the start', () => {
    expect(t.cloud.compliance.openItems()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^unterauftragnehmer-1\.md: \[offen: /)]),
    );
  });

  it('turns only its own Markdown into markup', () => {
    const out = markdown(
      '## Titel\n\n<script>x</script> **fett** [ok](/agb) [böse](javascript:alert(1))\n\n- a\n- b',
    ).value;
    expect(out).toContain('<h3 id="titel">Titel</h3>');
    expect(out).toContain(
      '&lt;script&gt;x&lt;/script&gt; <strong>fett</strong> <a href="/agb">ok</a>',
    );
    expect(out).toContain('[böse](javascript:alert(1))');
    expect(out).toContain('<ul><li>a</li><li>b</li></ul>');
  });
});

describe('sign-up for businesses with stored acceptance (TL-105)', () => {
  it('needs the business confirmation and the terms', async () => {
    const fields = { email: 'eva@elektro.example', name: 'Elektro Eva', slug: 'elektro' };
    const consumer = await post('/signup', { ...fields, terms: 'on' });
    expect(consumer.statusCode).toBe(400);
    expect(consumer.body).toContain('nicht als Verbraucher');
    // What was ticked stays ticked.
    expect(consumer.body).toMatch(/name="terms" value="on" required checked/);
    const terms = await post('/signup', { ...fields, business: 'on' });
    expect(terms.body).toContain('Bitte stimmen Sie den AGB');
    expect(t.mailer.sent.filter((mail) => mail.to === fields.email)).toHaveLength(0);
  });

  it('stores which versions were accepted, when and from where', async () => {
    const cookie = await signUp('eva@elektro.example', 'elektro');
    const eva = await customerByEmail('eva@elektro.example');
    const rows = await t.database.db
      .select()
      .from(acceptances)
      .where(eq(acceptances.customerId, eva?.id ?? ''));
    expect(rows.map((row) => `${row.document}:${row.version}`).sort()).toEqual([
      'agb:1',
      'avv:1',
      'tom:1',
      'unterauftragnehmer:1',
    ]);
    expect(rows[0]?.ip).toBe('127.0.0.1');
    expect(rows[0]?.acceptedAt.toISOString()).toBe(t.clock.now.toISOString());
    const account = await get('/account', cookie);
    expect(account.body).toContain('Ihr Vertrag');
    expect(account.body).toContain('bei der Anmeldung angenommen: Fassung 1');
    // While an instance exists, the account stays.
    expect(account.body).not.toContain('/account/delete');
    expect((await post('/account/delete', {}, cookie)).statusCode).toBe(409);
  });
});

describe('new versions of the contract (TL-105)', () => {
  let dir = '';
  const withVersion2 = async (effectiveInDays: number) => {
    const effective = new Date(t.clock.now.getTime() + effectiveInDays * DAY)
      .toISOString()
      .slice(0, 10);
    await writeFile(
      join(dir, 'agb-2.md'),
      `---\ntitle: Allgemeine Geschäftsbedingungen\neffective: ${effective}\n---\nNeu.\n`,
    );
    return new Compliance({
      config: t.config,
      database: t.database,
      mailer: t.mailer,
      now: () => t.clock.now,
      legal: new Legal(dir),
    });
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lenipo-legal-'));
    await cp(DEFAULT_LEGAL_DIR, dir, { recursive: true });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('needs six weeks of notice and mails each customer once', async () => {
    await expect((await withVersion2(30)).announce('agb', 2)).rejects.toThrow('42 days of notice');
    const compliance = await withVersion2(50);
    // Not announced: the new version does not count, even once its date has passed.
    expect((await compliance.current('agb')).version).toBe(1);
    expect(await compliance.upcoming('agb')).toBeUndefined();
    await compliance.announce('agb', 2);
    await expect(compliance.announce('agb', 2)).rejects.toThrow('announced already');
    expect((await compliance.upcoming('agb'))?.version).toBe(2);

    await compliance.tick();
    const notice = lastMailTo('eva@elektro.example');
    expect(notice?.subject).toMatch(
      /^Lenipo Cloud: Neue Fassung „Allgemeine Geschäftsbedingungen“ ab /,
    );
    expect(notice?.text).toContain('https://cloud.lenipo.test/agb/v/2');
    expect(notice?.text).toContain('widersprechen');
    const sent = t.mailer.sent.length;
    await compliance.tick();
    expect(t.mailer.sent.length).toBe(sent);

    advance(51);
    expect((await compliance.current('agb')).version).toBe(2);
    advance(-51);
  });
});

describe('deletion concept (TL-105)', () => {
  it('deletes a stopped instance on request before its date', async () => {
    const cookie = await signUp('fritz@fliesen.example', 'fliesen');
    const fliesen = await tenantBySlug('fliesen');
    // Running instances are cancelled first.
    expect((await post(`/account/tenants/${fliesen.id}/delete`, {}, cookie)).statusCode).toBe(409);
    await post(`/account/tenants/${fliesen.id}/cancel`, {}, cookie);
    await t.cloud.runJobs();
    expect((await get('/account', cookie)).body).toContain('Jetzt endgültig löschen');
    const deleting = await post(`/account/tenants/${fliesen.id}/delete`, {}, cookie);
    expect(deleting.headers.location).toBe('/account?ok=deleting');
    await t.cloud.runJobs();
    expect((await tenantBySlug('fliesen')).status).toBe('deleted');
    expect(lastMailTo('fritz@fliesen.example')?.subject).toBe('Lenipo: Ihre Daten sind gelöscht');

    // With nothing left, the customer deletes the account.
    const account = await get('/account', cookie);
    expect(account.body).toContain('Kundenkonto löschen');
    const deleted = await post('/account/delete', {}, cookie);
    expect(deleted.statusCode).toBe(200);
    expect(await customerByEmail('fritz@fliesen.example')).toBeNull();
    expect(lastMailTo('fritz@fliesen.example')?.subject).toBe(
      'Lenipo Cloud: Ihr Kundenkonto ist gelöscht',
    );
    expect((await get('/account', cookie)).headers.location).toBe('/login');
  });

  it('removes sign-ups after a week and accounts 90 days after their last instance', async () => {
    await post('/signup', {
      email: 'gina@garten.example',
      name: 'Garten Gina',
      slug: 'garten',
      business: 'on',
      terms: 'on',
    });
    expect(await t.database.db.select().from(signups)).not.toHaveLength(0);
    const cookie = await signUp('hans@holz.example', 'holz');
    const holz = await tenantBySlug('holz');
    await post(`/account/tenants/${holz.id}/cancel`, {}, cookie);
    await t.cloud.runJobs();

    advance(8);
    await t.cloud.tick();
    expect(await t.database.db.select().from(signups)).toHaveLength(0);
    // Deleted 30 days after the stop; the account follows 90 days later.
    advance(23);
    await t.cloud.tick();
    await t.cloud.runJobs();
    expect((await tenantBySlug('holz')).status).toBe('deleted');
    advance(89);
    await t.cloud.tick();
    expect(await customerByEmail('hans@holz.example')).not.toBeNull();
    advance(2);
    await t.cloud.tick();
    expect(await customerByEmail('hans@holz.example')).toBeNull();
    const [left] = await t.database.db.select().from(tenants).where(eq(tenants.slug, 'holz'));
    expect(left).toBeUndefined();
    // Eva still has her instance: her account stays.
    expect(await customerByEmail('eva@elektro.example')).not.toBeNull();
  });
});

describe('backups and exports at rest (TL-105)', () => {
  it('encrypts, decrypts, notices tampering and reads older plain files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lenipo-files-'));
    const key = fileKey('a-secret-that-is-long-enough-for-tests-0123');
    const read = async (file: string) => {
      const chunks: Buffer[] = [];
      for await (const chunk of await openFile(file, key)) chunks.push(chunk);
      return Buffer.concat(chunks).toString();
    };
    try {
      await writeFile(join(dir, 'plain'), 'PK geheime Daten');
      await sealFile(join(dir, 'plain'), join(dir, 'sealed'), key);
      await expect(readFile(join(dir, 'plain'))).rejects.toThrow();
      const sealed = await readFile(join(dir, 'sealed'));
      expect(sealed.includes('geheime')).toBe(false);
      expect(await read(join(dir, 'sealed'))).toBe('PK geheime Daten');

      sealed[20] = (sealed[20] ?? 0) ^ 1;
      await writeFile(join(dir, 'tampered'), sealed);
      await expect(read(join(dir, 'tampered'))).rejects.toThrow();

      await writeFile(join(dir, 'old'), 'PK von früher');
      expect(await read(join(dir, 'old'))).toBe('PK von früher');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps nightly backups encrypted', async () => {
    const elektro = await tenantBySlug('elektro');
    const backup = await t.cloud.fleet.backup(elektro, 'manual');
    expect(backup.file).toMatch(/\.zip\.enc$/);
    expect((await readFile(backup.file)).subarray(0, 4).toString()).toBe('LCF1');
    expect(await t.readPlain(backup.file)).toMatch(/^PK export of elektro #\d+$/);
  });
});
