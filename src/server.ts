import { createReadStream, existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { type Cloud, CloudError } from './cloud.js';
import type { Config } from './config.js';
import { page } from './views/html.js';
import * as views from './views/pages.js';

const SESSION = 'lc_session';

/** The web pages of Lenipo Cloud: sign-up, sign-in by link, the customer account. */
export async function createServer(config: Config, cloud: Cloud, logger = true) {
  const app = Fastify({ logger: logger ? { level: config.LOG_LEVEL } : false, trustProxy: true });
  await app.register(formbody);
  await app.register(cookie);
  const origin = new URL(config.CLOUD_URL);
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
    await send(reply, 'Lenipo', views.stopped(tenant), tenant ? 503 : 404);
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof CloudError) {
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

  app.get('/', async (_request, reply) => reply.redirect('/signup'));

  app.get('/signup', async (_request, reply) =>
    send(reply, 'Anmelden', views.signupForm(config.BASE_DOMAIN)),
  );

  app.post<{ Body: { email?: string; name?: string; slug?: string } }>(
    '/signup',
    async (request, reply) => {
      const values = {
        email: String(request.body?.email ?? ''),
        name: String(request.body?.name ?? ''),
        slug: String(request.body?.slug ?? ''),
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
    },
  );

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
    cancelled: 'Gekündigt. Die Umgebung ist angehalten; der Export folgt per Mail.',
  };
  const ERRORS: Record<string, string> = {
    dns: 'Der DNS-Eintrag zeigt noch nicht auf Ihre Lenipo-Adresse. Änderungen brauchen manchmal etwas Zeit.',
  };

  app.get<{ Querystring: { ok?: string; error?: string } }>('/account', async (request, reply) => {
    const me = await customer(request);
    if (!me) return reply.redirect('/login');
    const list = (await cloud.tenantsOf(me.id)).map((tenant) => ({
      tenant,
      address: cloud.address(tenant),
      host: cloud.host(tenant),
    }));
    return send(
      reply,
      'Kundenkonto',
      views.account(me, list, {
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
        return reply.redirect(`/account?${result}`, 303);
      } catch (error) {
        if (!(error instanceof CloudError)) throw error;
        const list = (await cloud.tenantsOf(me.id)).map((tenant) => ({
          tenant,
          address: cloud.address(tenant),
          host: cloud.host(tenant),
        }));
        return send(
          reply,
          'Kundenkonto',
          views.account(me, list, { error: error.message }),
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
      .send(createReadStream(tenant.exportFile));
  });

  /** Caddy asks before it fetches a certificate on demand. */
  app.get<{ Querystring: { domain?: string } }>('/tls/ask', async (request, reply) =>
    reply.code((await cloud.tlsAllowed(String(request.query.domain ?? ''))) ? 200 : 404).send(),
  );

  return app;
}
