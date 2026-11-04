import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { type Cloud, CloudError } from './cloud.js';
import { ComplianceError } from './compliance.js';
import type { Config } from './config.js';
import { fileKey, openFile } from './files.js';
import { ACCEPTED, DOCUMENT_KEYS, DOCUMENTS } from './legal.js';
import { constantTimeEquals } from './secrets.js';
import { page } from './views/html.js';
import * as views from './views/pages.js';

const SESSION = 'lc_session';

/** This month and the one before, as "YYYY-MM", by the service's clock. */
const lastMonths = (cloud: Cloud) => {
  const now = cloud.clock();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  return [now.toISOString().slice(0, 7), previous.toISOString().slice(0, 7)];
};

/** The web pages of Lenipo Cloud: sign-up, sign-in by link, the customer account. */
export async function createServer(config: Config, cloud: Cloud, logger = true) {
  // Logs without IP addresses and query strings, which carry the sign-in links (E-157).
  const app = Fastify({
    logger: logger
      ? {
          level: config.LOG_LEVEL,
          serializers: {
            req: (request) => ({ method: request.method, url: request.url.split('?')[0] }),
          },
        }
      : false,
    trustProxy: true,
  });
  await app.register(formbody);
  await app.register(cookie);
  // JSON arrives only from Stripe, whose signature covers the raw text.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) =>
    done(null, body),
  );
  const origin = new URL(config.CLOUD_URL);
  const exportKey = fileKey(config.SECRET_KEY);
  const secure = origin.protocol === 'https:';

  const send = (reply: FastifyReply, title: string, body: Parameters<typeof page>[1], code = 200) =>
    reply.code(code).type('text/html; charset=utf-8').send(page(title, body));

  // Forms only from our own pages: a foreign Origin is a cross-site request.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST') return;
    const from = request.headers.origin;
    if (from && from !== origin.origin) {
      await reply.code(403).send('Cross-site request rejected');
    }
  });

  // Addresses of instances that do not run end up here (Caddy's fallback for *.BASE_DOMAIN).
  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
    if (!host || host === origin.hostname || request.url.startsWith('/tls/')) return;
    if (host === 'localhost' || host === '127.0.0.1') return;
    const tenant = await cloud.tenantByHost(host);
    if (tenant?.sleepingAt && (tenant.status === 'trial' || tenant.status === 'active')) {
      // A sleeping instance wakes on its first request (E-156).
      await cloud.fleet.wake(tenant);
      await reply
        .code(503)
        .header('retry-after', '5')
        .type('text/html; charset=utf-8')
        .send(page('Lenipo', views.waking(), 5));
      return;
    }
    await send(reply, 'Lenipo', views.stopped(tenant), tenant ? 503 : 404);
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof CloudError || error instanceof ComplianceError) {
      return send(
        reply,
        'Fehler',
        views.message('Das hat nicht geklappt', error.message),
        error.status,
      );
    }
    request.log.error(error);
    return send(
      reply,
      'Fehler',
      views.message('Fehler', 'Etwas ist schiefgegangen. Bitte später erneut versuchen.'),
      500,
    );
  });

  const customer = async (request: FastifyRequest) =>
    cloud.customerOfSession(request.cookies[SESSION]);

  const signIn = async (reply: FastifyReply, customerId: string) => {
    const session = await cloud.createSession(customerId);
    reply.setCookie(SESSION, session.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      expires: session.expiresAt,
    });
  };

  app.get('/health', async () => ({ ok: true }));

  // For Prometheus (E-156), with OPS_METRICS_TOKEN; without it the endpoint does not exist.
  app.get('/ops/metrics', async (request, reply) => {
    const token = config.OPS_METRICS_TOKEN;
    const given = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return reply.code(404).send();
    if (!constantTimeEquals(given, token)) return reply.code(401).send();
    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(await cloud.fleet.metrics());
  });

  app.get('/', async (_request, reply) => reply.redirect('/signup'));

  // The legal documents (E-157): the version in force, every version under /<document>/v/<n>.
  const legalPage = async (
    reply: FastifyReply,
    document: (typeof DOCUMENT_KEYS)[number],
    version?: number,
  ) => {
    const { compliance } = cloud;
    const current = await compliance.current(document);
    const upcoming = await compliance.upcoming(document);
    const announced = await compliance.announced();
    const all = compliance.legal
      .all(document)
      .filter(
        (entry) =>
          entry.version <= current.version ||
          entry.version === upcoming?.version ||
          announced.has(`${document}:${entry.version}`) ||
          !DOCUMENTS[document].contract,
      );
    const entry = version === undefined ? current : all.find((item) => item.version === version);
    if (!entry) throw new CloudError('Diese Fassung gibt es nicht.', 404);
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(page(entry.title, views.legalDocument(entry, current, all, upcoming), undefined, true));
  };
  for (const document of DOCUMENT_KEYS) {
    app.get(`/${document}`, async (_request, reply) => legalPage(reply, document));
    app.get<{ Params: { version: string } }>(`/${document}/v/:version`, async (request, reply) =>
      legalPage(reply, document, Number(request.params.version)),
    );
  }
  // The status page (TL-106, E-158); the landing page reads the JSON from another server.
  app.get('/status.json', async (_request, reply) =>
    reply
      .header('access-control-allow-origin', '*')
      .header('cache-control', 'public, max-age=30')
      .send(await cloud.status.overview()),
  );
  app.get('/status', async (_request, reply) =>
    reply
      .header('cache-control', 'public, max-age=30')
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Status',
          views.statusPage(await cloud.status.overview(), {
            url: config.SUPPORT_URL ?? null,
            email: config.SUPPORT_EMAIL,
          }),
          60,
          true,
        ),
      ),
  );

  app.get('/rechtliches', async (_request, reply) => {
    const entries = await Promise.all(
      DOCUMENT_KEYS.map(async (document) => ({
        current: await cloud.compliance.current(document),
        count: cloud.compliance.legal.all(document).length,
      })),
    );
    return reply
      .type('text/html; charset=utf-8')
      .send(page('Rechtliches', views.legalIndex(entries), undefined, true));
  });

  app.get('/signup', async (_request, reply) =>
    send(reply, 'Anmelden', views.signupForm(config.BASE_DOMAIN)),
  );

  app.post<{
    Body: { email?: string; name?: string; slug?: string; business?: string; terms?: string };
  }>('/signup', async (request, reply) => {
    const values = {
      email: String(request.body?.email ?? ''),
      name: String(request.body?.name ?? ''),
      slug: String(request.body?.slug ?? ''),
      business: request.body?.business === 'on',
      terms: request.body?.terms === 'on',
    };
    try {
      await cloud.signup({ ...values, ip: request.ip });
    } catch (error) {
      if (!(error instanceof CloudError)) throw error;
      return send(
        reply,
        'Anmelden',
        views.signupForm(config.BASE_DOMAIN, values, error.message),
        error.status,
      );
    }
    return send(
      reply,
      'Postfach prüfen',
      views.message(
        'Bitte bestätigen',
        `Wir haben einen Link an ${values.email.trim().toLowerCase()} geschickt. Mit ihm bestätigen Sie die Anmeldung; danach richten wir Ihre Umgebung ein.`,
      ),
    );
  });

  app.get<{ Querystring: { token?: string } }>('/signup/confirm', async (request, reply) => {
    const token = String(request.query.token ?? '');
    const signup = await cloud.pendingSignup(token);
    return send(
      reply,
      'Bestätigen',
      views.confirmForm(
        'Anmeldung bestätigen',
        `Lenipo für „${signup.name}“ unter ${signup.slug}.${config.BASE_DOMAIN} einrichten.`,
        '/signup/confirm',
        token,
      ),
    );
  });

  app.post<{ Body: { token?: string } }>('/signup/confirm', async (request, reply) => {
    const customerId = await cloud.confirmSignup(String(request.body?.token ?? ''));
    await signIn(reply, customerId);
    return reply.redirect('/account?ok=signup', 303);
  });

  app.get('/login', async (_request, reply) => send(reply, 'Kundenkonto', views.loginForm()));

  app.post<{ Body: { email?: string } }>('/login', async (request, reply) => {
    await cloud.requestLogin(String(request.body?.email ?? ''));
    return send(reply, 'Kundenkonto', views.loginForm(true));
  });

  app.get<{ Querystring: { token?: string } }>('/login/confirm', async (request, reply) =>
    send(
      reply,
      'Anmelden',
      views.confirmForm(
        'Anmelden',
        'Bei Lenipo Cloud anmelden.',
        '/login/confirm',
        String(request.query.token ?? ''),
      ),
    ),
  );

  app.post<{ Body: { token?: string } }>('/login/confirm', async (request, reply) => {
    const customerId = await cloud.consumeLogin(String(request.body?.token ?? ''));
    await signIn(reply, customerId);
    return reply.redirect('/account', 303);
  });

  app.post('/logout', async (request, reply) => {
    await cloud.endSession(request.cookies[SESSION]);
    reply.clearCookie(SESSION, { path: '/' });
    return reply.redirect('/login', 303);
  });

  const OK: Record<string, string> = {
    signup:
      'Anmeldung bestätigt. Wir richten Ihre Umgebung ein und schicken Ihnen eine Mail, sobald sie bereit ist.',
    domain: 'Gespeichert.',
    verified: 'Die Domain ist bestätigt; Ihre Umgebung ist in Kürze darüber erreichbar.',
    cancelled: 'Gekündigt.',
    kept: 'Die Kündigung ist zurückgenommen.',
    checkout:
      'Danke! Sobald die Zahlung bestätigt ist, läuft Ihre Umgebung mit dem gebuchten Tarif weiter.',
    plan: 'Der Tarif ist geändert.',
    deleting: 'Die Umgebung wird gelöscht; Sie bekommen eine Bestätigung per Mail.',
  };

  /** The account page with each instance and the seats it uses. */
  const accountPage = async (
    me: { id: string; name: string; email: string; stripeCustomerId: string | null },
    notice: { ok?: string; error?: string },
  ) => {
    const list = await Promise.all(
      (await cloud.tenantsOf(me.id)).map(async (tenant) => ({
        tenant,
        address: cloud.address(tenant),
        host: cloud.host(tenant),
        used: await cloud.seatsInUse(tenant.id),
        availability: await Promise.all(
          lastMonths(cloud).map((month) => cloud.status.availability(tenant.id, month)),
        ),
      })),
    );
    const accepted = await cloud.compliance.acceptedBy(me.id);
    const contracts = await Promise.all(
      ACCEPTED.map(async (document) => {
        const upcoming = await cloud.compliance.upcoming(document);
        return {
          document,
          title: DOCUMENTS[document].title,
          current: (await cloud.compliance.current(document)).version,
          accepted: accepted[document],
          upcoming: upcoming && { version: upcoming.version, effective: upcoming.effective },
        };
      }),
    );
    return views.account(
      me,
      list,
      notice,
      !!me.stripeCustomerId,
      contracts,
      await cloud.compliance.canDelete(me.id),
      { url: config.SUPPORT_URL ?? null, email: config.SUPPORT_EMAIL },
      config.VAT_MODE,
    );
  };
  const ERRORS: Record<string, string> = {
    dns: 'Der DNS-Eintrag zeigt noch nicht auf Ihre Lenipo-Adresse. Änderungen brauchen manchmal etwas Zeit.',
  };

  app.get<{ Querystring: { ok?: string; error?: string } }>('/account', async (request, reply) => {
    const me = await customer(request);
    if (!me) return reply.redirect('/login');
    return send(
      reply,
      'Kundenkonto',
      await accountPage(me, {
        ok: OK[request.query.ok ?? ''],
        error: ERRORS[request.query.error ?? ''],
      }),
    );
  });

  const action =
    (
      work: (customerId: string, tenantId: string, body: Record<string, string>) => Promise<string>,
    ) =>
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: Record<string, string> }>,
      reply: FastifyReply,
    ) => {
      const me = await customer(request);
      if (!me) return reply.redirect('/login', 303);
      try {
        const result = await work(me.id, request.params.id, request.body ?? {});
        // Stripe's pages are absolute addresses, our own answers query strings.
        return reply.redirect(result.startsWith('https://') ? result : `/account?${result}`, 303);
      } catch (error) {
        if (!(error instanceof CloudError)) throw error;
        return send(
          reply,
          'Kundenkonto',
          await accountPage(me, { error: error.message }),
          error.status,
        );
      }
    };

  app.post(
    '/account/tenants/:id/cancel',
    action(async (customerId, tenantId) => {
      await cloud.cancel(customerId, tenantId);
      return 'ok=cancelled';
    }),
  );

  app.post(
    '/account/tenants/:id/delete',
    action(async (customerId, tenantId) => {
      await cloud.deleteNow(customerId, tenantId);
      return 'ok=deleting';
    }),
  );

  app.post('/account/delete', async (request, reply) => {
    const me = await customer(request);
    if (!me) return reply.redirect('/login', 303);
    await cloud.compliance.deleteAccount(me.id);
    await cloud.endSession(request.cookies[SESSION]);
    reply.clearCookie(SESSION, { path: '/' });
    return send(
      reply,
      'Kundenkonto gelöscht',
      views.message(
        'Kundenkonto gelöscht',
        'Ihr Kundenkonto ist gelöscht. Eine Bestätigung ist per Mail unterwegs.',
      ),
    );
  });

  app.post(
    '/account/tenants/:id/keep',
    action(async (customerId, tenantId) => {
      await cloud.keep(customerId, tenantId);
      return 'ok=kept';
    }),
  );

  const seatsOf = (body: Record<string, string>) => Number(String(body.seats ?? '').trim());

  app.post(
    '/account/tenants/:id/checkout',
    action((customerId, tenantId, body) =>
      cloud.checkout(customerId, tenantId, {
        plan: String(body.plan ?? ''),
        interval: String(body.interval ?? 'month'),
        seats: seatsOf(body),
      }),
    ),
  );

  app.post(
    '/account/tenants/:id/plan',
    action(async (customerId, tenantId, body) => {
      await cloud.changePlan(customerId, tenantId, {
        plan: String(body.plan ?? ''),
        seats: seatsOf(body),
      });
      return 'ok=plan';
    }),
  );

  app.post('/account/billing', async (request, reply) => {
    const me = await customer(request);
    if (!me) return reply.redirect('/login', 303);
    return reply.redirect(await cloud.portal(me.id), 303);
  });

  // Stripe signs the exact bytes of the body.
  app.post('/stripe/webhook', async (request, reply) => {
    const ok = await cloud.stripeWebhook(
      String(request.body ?? ''),
      request.headers['stripe-signature'] as string | undefined,
    );
    return reply.code(ok ? 200 : 400).send(ok ? { received: true } : { error: 'signature' });
  });

  app.post(
    '/account/tenants/:id/domain',
    action(async (customerId, tenantId, body) => {
      await cloud.setDomain(customerId, tenantId, String(body.domain ?? ''));
      return 'ok=domain';
    }),
  );

  app.post(
    '/account/tenants/:id/domain/verify',
    action(async (customerId, tenantId) =>
      (await cloud.verifyDomain(customerId, tenantId)) ? 'ok=verified' : 'error=dns',
    ),
  );

  app.get<{ Params: { id: string } }>('/account/tenants/:id/export', async (request, reply) => {
    const me = await customer(request);
    if (!me) return reply.redirect('/login');
    const tenant = await cloud.tenantOf(me.id, request.params.id);
    if (!tenant.exportFile || !existsSync(tenant.exportFile)) {
      throw new CloudError('Der Export ist noch nicht bereit.', 404);
    }
    return reply
      .type('application/zip')
      .header('content-disposition', `attachment; filename="lenipo-${tenant.slug}.zip"`)
      .send(await openFile(tenant.exportFile, exportKey));
  });

  /** Caddy asks before it fetches a certificate on demand. */
  app.get<{ Querystring: { domain?: string } }>('/tls/ask', async (request, reply) =>
    reply.code((await cloud.tlsAllowed(String(request.query.domain ?? ''))) ? 200 : 404).send(),
  );

  return app;
}
