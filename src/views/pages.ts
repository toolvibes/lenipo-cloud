import type { tenants } from '../db/schema.js';
import { type Html, html } from './html.js';

type Tenant = typeof tenants.$inferSelect;
const date = (value: Date | null) => (value ? value.toLocaleDateString('de-DE') : '–');

export function signupForm(
  baseDomain: string,
  values: { email?: string; name?: string; slug?: string } = {},
  error?: string,
): Html {
  return html`<div class="card">
    <h1>Lenipo testen</h1>
    <p class="muted">30 Tage kostenlos, ohne Zahlungsdaten. Ihre eigene Umgebung in Deutschland, in wenigen Minuten bereit.</p>
    ${error ? html`<p class="error" role="alert">${error}</p>` : ''}
    <form method="post" action="/signup">
      <label for="email">E-Mail-Adresse</label>
      <input type="email" id="email" name="email" required maxlength="254" autocomplete="email" value="${values.email ?? ''}">
      <label for="name">Name der Organisation</label>
      <input type="text" id="name" name="name" required minlength="2" maxlength="80" autocomplete="organization" value="${values.name ?? ''}">
      <label for="slug">Adresse</label>
      <div class="row">
        <input type="text" id="slug" name="slug" required pattern="[a-z][a-z0-9-]{1,28}[a-z0-9]" maxlength="30" value="${values.slug ?? ''}" style="flex:1" aria-describedby="slug-help">
        <span class="suffix">.${baseDomain}</span>
      </div>
      <p class="muted" id="slug-help">3 bis 30 Zeichen: Kleinbuchstaben, Ziffern, Bindestriche. Eine eigene Domain können Sie später eintragen.</p>
      <button type="submit">Anmelden</button>
    </form>
    <p class="muted" style="margin-top:16px">Schon angemeldet? <a href="/login">Zum Kundenkonto</a></p>
  </div>`;
}

export function message(title: string, text: string, extra: Html | string = ''): Html {
  return html`<div class="card"><h1>${title}</h1><p>${text}</p>${extra}</div>`;
}

/** A button that confirms by POST, so link scanners in mail systems do not use up the link. */
export function confirmForm(title: string, text: string, action: string, token: string): Html {
  return html`<div class="card">
    <h1>${title}</h1>
    <p>${text}</p>
    <form method="post" action="${action}">
      <input type="hidden" name="token" value="${token}">
      <button type="submit">Bestätigen</button>
    </form>
  </div>`;
}

export function loginForm(sent = false): Html {
  return html`<div class="card">
    <h1>Kundenkonto</h1>
    ${
      sent
        ? html`<p class="ok" role="status">Wenn die Adresse zu einem Konto gehört, ist ein Anmeldelink unterwegs.</p>`
        : html`<p class="muted">Wir schicken Ihnen einen Anmeldelink, ein Passwort brauchen Sie nicht.</p>`
    }
    <form method="post" action="/login">
      <label for="email">E-Mail-Adresse</label>
      <input type="email" id="email" name="email" required maxlength="254" autocomplete="email">
      <button type="submit">Link schicken</button>
    </form>
    <p class="muted" style="margin-top:16px">Noch kein Konto? <a href="/signup">Lenipo testen</a></p>
  </div>`;
}

const STATUS: Record<string, string> = {
  provisioning: 'wird eingerichtet',
  trial: 'Testphase',
  active: 'aktiv',
  suspended: 'angehalten',
  deleting: 'wird gelöscht',
  failed: 'Einrichtung fehlgeschlagen, wir kümmern uns darum',
};

export function account(
  customer: { name: string; email: string },
  list: Array<{ tenant: Tenant; address: string; host: string }>,
  notice?: { ok?: string; error?: string },
): Html {
  return html`<div class="card">
    <div class="row" style="justify-content:space-between">
      <h1>${customer.name}</h1>
      <form method="post" action="/logout" style="margin:0"><button class="secondary" style="margin:0">Abmelden</button></form>
    </div>
    <p class="muted">${customer.email}</p>
    ${notice?.ok ? html`<p class="ok" role="status">${notice.ok}</p>` : ''}
    ${notice?.error ? html`<p class="error" role="alert">${notice.error}</p>` : ''}
    ${list.length === 0 ? html`<p>Keine Umgebungen.</p>` : ''}
    ${list.map(({ tenant, address, host }) => tenantCard(tenant, address, host))}
  </div>`;
}

function tenantCard(tenant: Tenant, address: string, host: string): Html {
  const running = tenant.status === 'trial' || tenant.status === 'active';
  return html`<section aria-label="${tenant.name}">
    <h2>${tenant.name}</h2>
    <p>${running ? html`<a href="${address}">${address}</a>` : address} · ${STATUS[tenant.status] ?? tenant.status}</p>
    ${tenant.status === 'trial' ? html`<p class="muted">Testphase bis ${date(tenant.trialEndsAt)}.</p>` : ''}
    ${
      tenant.status === 'suspended'
        ? html`<p class="muted">Angehalten am ${date(tenant.suspendedAt)}${tenant.suspendReason === 'cancelled' ? ' (gekündigt)' : ' (Testphase beendet)'}. Daten und Export werden am ${date(tenant.deleteAfter)} gelöscht.</p>
          ${
            tenant.exportReadyAt
              ? html`<p><a href="/account/tenants/${tenant.id}/export">Export herunterladen</a> <span class="muted">(ZIP, lässt sich in jede Lenipo-Instanz zurückspielen)</span></p>`
              : html`<p class="muted">Der Export wird erstellt; Sie bekommen eine Mail.</p>`
          }`
        : ''
    }
    ${
      running
        ? html`<form method="post" action="/account/tenants/${tenant.id}/domain">
            <label for="domain-${tenant.id}">Eigene Domain (optional)</label>
            <input type="text" id="domain-${tenant.id}" name="domain" value="${tenant.customDomain ?? ''}" placeholder="projekte.beispiel.de">
            <p class="muted">Beim DNS-Anbieter einen CNAME-Eintrag auf <code>${host}</code> anlegen, dann prüfen. Leer lassen und speichern entfernt die Domain.</p>
            <div class="row"><button class="secondary">Speichern</button></div>
          </form>
          ${
            tenant.customDomain
              ? tenant.customDomainVerifiedAt
                ? html`<p class="ok">${tenant.customDomain} ist eingerichtet.</p>`
                : html`<form method="post" action="/account/tenants/${tenant.id}/domain/verify"><button class="secondary">DNS prüfen</button></form>`
              : ''
          }
          <form method="post" action="/account/tenants/${tenant.id}/cancel" onsubmit="return confirm('Wirklich kündigen? Die Umgebung wird angehalten; Ihre Daten bleiben als Export 30 Tage abrufbar.')">
            <button class="danger">Kündigen</button>
          </form>`
        : ''
    }
  </section>`;
}

/** What a visitor sees at the address of an instance that does not run. */
export function stopped(tenant: Tenant | null): Html {
  if (!tenant) {
    return message('Nicht gefunden', 'Unter dieser Adresse gibt es keine Lenipo-Umgebung.');
  }
  if (tenant.status === 'provisioning') {
    return message(
      'Gleich bereit',
      'Diese Umgebung wird gerade eingerichtet. Bitte in einer Minute erneut laden.',
    );
  }
  return message(
    'Angehalten',
    'Diese Lenipo-Umgebung ist angehalten. Wer sie betreut, findet Export und Optionen im Kundenkonto.',
  );
}
