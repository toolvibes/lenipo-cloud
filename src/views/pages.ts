import type { tenants } from '../db/schema.js';
import type { DocumentKey, LegalVersion } from '../legal.js';
import { PLAN_KEYS, PLANS, type PlanKey } from '../plans.js';
import { type VatMode, vatSuffix } from '../vat.js';
import { type Html, html } from './html.js';
import { markdown } from './markdown.js';

type Tenant = typeof tenants.$inferSelect;
const date = (value: Date | null) => (value ? value.toLocaleDateString('de-DE') : '–');

export function signupForm(
  baseDomain: string,
  values: {
    email?: string;
    name?: string;
    slug?: string;
    business?: boolean;
    terms?: boolean;
  } = {},
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
      <label class="check"><input type="checkbox" name="business" value="on" required ${values.business ? html`checked` : ''}>
        <span>Ich nutze Lenipo Cloud für ein Unternehmen, eine Behörde oder einen Verein, nicht als Verbraucher.</span></label>
      <label class="check"><input type="checkbox" name="terms" value="on" required ${values.terms ? html`checked` : ''}>
        <span>Ich stimme den <a href="/agb" target="_blank">AGB</a> mit der <a href="/leistungsbeschreibung" target="_blank">Leistungsbeschreibung</a> und dem <a href="/avv" target="_blank">Vertrag zur Auftragsverarbeitung</a> mit seinen Anlagen (<a href="/tom" target="_blank">technische und organisatorische Maßnahmen</a>, <a href="/unterauftragnehmer" target="_blank">Unterauftragnehmer</a>) zu. Die <a href="/datenschutz" target="_blank">Datenschutzerklärung</a> habe ich zur Kenntnis genommen.</span></label>
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

export interface TenantView {
  tenant: Tenant;
  address: string;
  host: string;
  /** People who take a seat now, from the latest reading. */
  used: number;
  /** This month and the last (TL-106). */
  availability?: AvailabilityView[];
}

export interface ContractView {
  document: DocumentKey;
  title: string;
  current: number;
  accepted?: number;
  upcoming?: { version: number; effective: Date };
}

export function account(
  customer: { name: string; email: string },
  list: TenantView[],
  notice?: { ok?: string; error?: string },
  billing = false,
  contracts: ContractView[] = [],
  deletable = false,
  support?: { url: string | null; email: string },
  vat: VatMode = 'small-business',
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
    ${list.map((view) => tenantCard(view, vat))}
    ${
      billing
        ? html`<form method="post" action="/account/billing"><button class="secondary">Zahlungsdaten und Rechnungen</button></form>`
        : ''
    }
    ${
      support
        ? html`<h2>Hilfe</h2><p class="muted">Fragen und Störungen: ${support.url ? html`<a href="${support.url}">Support-Portal</a> oder ` : ''}<a href="mailto:${support.email}">${support.email}</a>. Den Zustand des Dienstes zeigt die <a href="/status">Statusseite</a>.</p>`
        : ''
    }
    ${contracts.length ? contractList(contracts) : ''}
    ${
      deletable
        ? html`<h2>Kundenkonto löschen</h2>
          <p class="muted">Ohne Umgebung brauchen Sie das Konto nicht mehr. Es wird sonst 90 Tage nach dem Löschen der letzten Umgebung entfernt.</p>
          <form method="post" action="/account/delete" onsubmit="return confirm('Kundenkonto endgültig löschen?')"><button class="danger">Kundenkonto löschen</button></form>`
        : ''
    }
  </div>`;
}

function contractList(contracts: ContractView[]): Html {
  return html`<h2>Ihr Vertrag</h2>
    <ul class="muted" style="padding-left:18px">
      ${contracts.map(
        (entry) =>
          html`<li><a href="/${entry.document}">${entry.title}</a>, gültige Fassung ${entry.current}${
            entry.accepted ? html` (bei der Anmeldung angenommen: Fassung ${entry.accepted})` : ''
          }${
            entry.upcoming
              ? html`. <strong>Neue Fassung ${entry.upcoming.version} ab ${date(entry.upcoming.effective)}</strong>: <a href="/${entry.document}/v/${entry.upcoming.version}">lesen</a>`
              : ''
          }</li>`,
      )}
    </ul>`;
}

const euro = (value: number) =>
  value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

/** Plan, interval and seats to book (trial or after it) or to change. */
function planForm(view: TenantView, action: string, booked: boolean, vat: VatMode): Html {
  const { tenant, used } = view;
  const current = (tenant.plan ?? 'team') as PlanKey;
  const seats = Math.max(tenant.seats ?? used, used);
  return html`<form method="post" action="${action}">
    <fieldset style="border:0;padding:0;margin:0">
      <legend class="muted" style="padding:0">Tarif, je Platz und Monat ${vatSuffix(vat)}</legend>
      ${PLAN_KEYS.map((key) => {
        const plan = PLANS[key];
        return html`<label style="font-weight:400;display:flex;gap:8px;align-items:flex-start">
          <input type="radio" name="plan" value="${key}" ${key === current ? html`checked` : ''} required style="margin-top:4px">
          <span><strong>${plan.name}</strong> · ${euro(plan.price.month)} monatlich, ${euro(plan.price.year)} bei jährlicher Zahlung<br>
          <span class="muted">${plan.features.join(' · ')}</span></span>
        </label>`;
      })}
    </fieldset>
    ${
      booked
        ? ''
        : html`<label for="interval-${tenant.id}">Zahlung</label>
          <select id="interval-${tenant.id}" name="interval" style="height:36px">
            <option value="month">monatlich</option>
            <option value="year">jährlich</option>
          </select>`
    }
    <label for="seats-${tenant.id}">Plätze</label>
    <input type="text" inputmode="numeric" pattern="[0-9]+" id="seats-${tenant.id}" name="seats" value="${seats}" required>
    <p class="muted">Jede aktive Person belegt einen Platz, Gäste und KI-Agenten nicht. Gerade aktiv: ${used}.${booked ? ' Mehr Plätze oder ein größerer Tarif werden sofort anteilig berechnet, weniger gilt ab dem nächsten Zeitraum.' : ''}</p>
    <button>${booked ? 'Ändern' : 'Weiter zur Zahlung'}</button>
  </form>`;
}

function tenantCard(view: TenantView, vat: VatMode): Html {
  const { tenant, address, host } = view;
  const running = tenant.status === 'trial' || tenant.status === 'active';
  const bookable =
    !tenant.subscriptionId &&
    (tenant.status === 'trial' ||
      (tenant.status === 'suspended' && tenant.suspendReason === 'trial-ended'));
  const plan =
    tenant.plan && (PLAN_KEYS as readonly string[]).includes(tenant.plan)
      ? PLANS[tenant.plan as PlanKey]
      : null;
  return html`<section aria-label="${tenant.name}">
    <h2>${tenant.name}</h2>
    <p>${running ? html`<a href="${address}">${address}</a>` : address} · ${STATUS[tenant.status] ?? tenant.status}</p>
    ${tenant.status === 'trial' ? html`<p class="muted">Testphase bis ${date(tenant.trialEndsAt)}.</p>` : ''}
    ${running && view.availability?.length ? availabilityLine(view.availability) : ''}
    ${
      tenant.status === 'active' && plan
        ? html`<p>Tarif ${plan.name}, ${tenant.seats} Plätze (${view.used} belegt), ${tenant.interval === 'year' ? 'jährlich' : 'monatlich'}. ${
            tenant.cancelAt
              ? html`<strong>Gekündigt zum ${date(tenant.cancelAt)}.</strong>`
              : html`Nächste Abrechnung am ${date(tenant.periodEnd)}.`
          }</p>
          ${tenant.paymentState === 'past_due' ? html`<p class="error">Die letzte Zahlung ist fehlgeschlagen. Bitte die Zahlungsdaten prüfen.</p>` : ''}`
        : ''
    }
    ${
      tenant.status === 'suspended'
        ? html`<p class="muted">Angehalten am ${date(tenant.suspendedAt)}${tenant.suspendReason === 'cancelled' ? ' (gekündigt)' : ' (Testphase beendet)'}. Daten und Export werden am ${date(tenant.deleteAfter)} gelöscht.</p>
          ${
            tenant.exportReadyAt
              ? html`<p><a href="/account/tenants/${tenant.id}/export">Export herunterladen</a> <span class="muted">(ZIP, lässt sich in jede Lenipo-Instanz zurückspielen)</span></p>`
              : html`<p class="muted">Der Export wird erstellt; Sie bekommen eine Mail.</p>`
          }
          <form method="post" action="/account/tenants/${tenant.id}/delete" onsubmit="return confirm('Umgebung mit allen Daten, Sicherungen und dem Export jetzt endgültig löschen?')">
            <button class="danger">Jetzt endgültig löschen</button>
          </form>`
        : ''
    }
    ${
      bookable
        ? html`<h2>${tenant.status === 'trial' ? 'Tarif buchen' : 'Buchen und weiterarbeiten'}</h2>${planForm(view, `/account/tenants/${tenant.id}/checkout`, false, vat)}`
        : ''
    }
    ${
      tenant.status === 'active' && plan && !tenant.cancelAt
        ? html`<details><summary>Tarif oder Plätze ändern</summary>${planForm(view, `/account/tenants/${tenant.id}/plan`, true, vat)}</details>`
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
          ${
            tenant.cancelAt
              ? html`<form method="post" action="/account/tenants/${tenant.id}/keep"><button class="secondary">Kündigung zurücknehmen</button></form>`
              : html`<form method="post" action="/account/tenants/${tenant.id}/cancel" onsubmit="return confirm('${
                  tenant.subscriptionId
                    ? 'Wirklich kündigen? Die Umgebung läuft bis zum Ende des bezahlten Zeitraums; danach bleiben Ihre Daten als Export 30 Tage abrufbar.'
                    : 'Wirklich kündigen? Die Umgebung wird sofort angehalten; Ihre Daten bleiben als Export 30 Tage abrufbar.'
                }')">
                  <button class="danger">Kündigen</button>
                </form>`
          }`
        : ''
    }
  </section>`;
}

/** A sleeping instance while it starts (E-156); the page reloads itself. */
export function waking(): Html {
  return message(
    'Einen Moment',
    'Diese Lenipo-Umgebung wurde eine Weile nicht genutzt und startet gerade. Die Seite lädt sich von selbst neu, sobald sie bereit ist; das dauert meist unter einer Minute.',
  );
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

const longDate = (value: Date) => value.toLocaleDateString('de-DE', { timeZone: 'UTC' });

/** One version of a legal document; older and newer ones are linked below it (E-157). */
export function legalDocument(
  entry: LegalVersion,
  current: LegalVersion,
  all: LegalVersion[],
  upcoming?: LegalVersion,
): Html {
  const others = all.filter((other) => other.version !== entry.version);
  const state =
    entry.version === current.version
      ? 'gültig'
      : entry.version < current.version
        ? 'nicht mehr gültig'
        : 'noch nicht gültig';
  return html`<div class="card doc">
    <h1>${entry.title}</h1>
    <p class="muted">Fassung ${entry.version} vom ${longDate(entry.effective)}, ${state}${
      entry.version !== current.version
        ? html`. Gültig ist <a href="/${entry.document}">Fassung ${current.version}</a>.`
        : ''
    }</p>
    ${
      upcoming && entry.version === current.version
        ? html`<p class="ok">Ab ${longDate(upcoming.effective)} gilt <a href="/${entry.document}/v/${upcoming.version}">Fassung ${upcoming.version}</a>.</p>`
        : ''
    }
    ${markdown(entry.body)}
    ${
      others.length
        ? html`<h2>Andere Fassungen</h2><ul>${others.map(
            (other) =>
              html`<li><a href="/${entry.document}/v/${other.version}">Fassung ${other.version} vom ${longDate(other.effective)}</a></li>`,
          )}</ul>`
        : ''
    }
  </div>`;
}

/** All legal documents with their versions in force. */
export function legalIndex(entries: { current: LegalVersion; count: number }[]): Html {
  return html`<div class="card doc">
    <h1>Rechtliches</h1>
    <p>Lenipo Cloud richtet sich an Unternehmen, Behörden und Vereine. Die Daten liegen ausschließlich in Rechenzentren in Deutschland.</p>
    <ul>${entries.map(
      ({ current, count }) =>
        html`<li><a href="/${current.document}">${current.title}</a> <span class="muted">Fassung ${current.version} vom ${longDate(current.effective)}${count > 1 ? `, ${count} Fassungen` : ''}</span></li>`,
    )}</ul>
  </div>`;
}

type Overview = Awaited<ReturnType<import('../status.js').StatusBoard['overview']>>;
type Incident = Overview['active'][number];

const STATE_TEXT: Record<Overview['state'], string> = {
  operational: 'Alle Systeme betriebsbereit',
  degraded: 'Einzelne Umgebungen eingeschränkt',
  maintenance: 'Wartung läuft',
  outage: 'Störung',
};
const berlin = (iso: string) =>
  new Date(iso).toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const percent = (value: number) =>
  `${(value * 100).toLocaleString('de-DE', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} %`;

function incidentBlock(row: Incident, kind: 'open' | 'planned' | 'done'): Html {
  return html`<div class="incident ${kind}">
    <p><strong>${row.title}</strong><br><span class="muted">${row.kind === 'maintenance' ? 'Wartung' : 'Störung'} · ${berlin(row.startsAt)}${row.endsAt ? ` bis ${berlin(row.endsAt)}` : ''}${row.resolvedAt ? ` · behoben ${berlin(row.resolvedAt)}` : ''}</span></p>
    ${row.updates.map((update) => html`<p class="muted">${berlin(update.at)}: ${update.text}</p>`)}
  </div>`;
}

/** The public status page (TL-106, E-158); the same data is at /status.json. */
export function statusPage(o: Overview, support: { url: string | null; email: string }): Html {
  const { running, ready } = o.components.instances;
  return html`<div class="card doc">
    <h1>Status von Lenipo Cloud</h1>
    <div class="state s-${o.state}" role="status"><span class="dot" aria-hidden="true"></span>${STATE_TEXT[o.state]}</div>
    <ul>
      <li>Anmeldung und Kundenkonto: betriebsbereit</li>
      <li>Umgebungen: ${running === 0 ? 'keine in Betrieb' : `${ready} von ${running} bereit`}</li>
    </ul>
    ${o.active.length ? html`<h2>Aktuell</h2>${o.active.map((row) => incidentBlock(row, row.kind === 'maintenance' ? 'planned' : 'open'))}` : ''}
    ${o.upcoming.length ? html`<h2>Geplante Wartungen</h2>${o.upcoming.map((row) => incidentBlock(row, 'planned'))}` : ''}
    <h2>Verfügbarkeit der letzten 90 Tage</h2>
    <div class="bars" role="img" aria-label="Verfügbarkeit je Tag, die Tabelle darunter nennt die Tage mit Ausfällen">
      ${o.history.map((day) => {
        const level =
          day.availability === null
            ? 'none'
            : day.availability >= 0.995
              ? 'good'
              : day.availability >= 0.98
                ? 'fair'
                : 'poor';
        const label = `${new Date(`${day.day}T12:00:00Z`).toLocaleDateString('de-DE')}: ${
          day.availability === null ? 'keine Messung' : percent(day.availability)
        }${day.incidents.length ? ` · ${day.incidents.join(', ')}` : ''}`;
        return html`<span class="bar ${level}" title="${label}"></span>`;
      })}
    </div>
    <div class="legend"><span><i class="bar good"></i>ab 99,5 %</span><span><i class="bar fair"></i>98 bis 99,5 %</span><span><i class="bar poor"></i>unter 98 %</span><span><i class="bar none"></i>keine Messung</span></div>
    ${(() => {
      const bad = o.history.filter((day) => day.availability !== null && day.availability < 0.995);
      return bad.length
        ? html`<div class="table" style="margin-top:12px"><table><thead><tr><th>Tag</th><th>Verfügbarkeit</th><th>Störungen</th></tr></thead><tbody>${bad.map(
            (day) =>
              html`<tr><td>${new Date(`${day.day}T12:00:00Z`).toLocaleDateString('de-DE')}</td><td>${percent(day.availability ?? 0)}</td><td>${day.incidents.join(', ') || '–'}</td></tr>`,
          )}</tbody></table></div>`
        : html`<p class="muted" style="margin-top:8px">Kein Tag unter 99,5 %.</p>`;
    })()}
    ${o.recent.length ? html`<h2>Vergangene Störungen und Wartungen</h2>${o.recent.map((row) => incidentBlock(row, 'done'))}` : ''}
    <h2>Wartung und Support</h2>
    <p>Updates mit kurzer Unterbrechung laufen im festen Wartungsfenster ${o.maintenanceWindow}. Andere Wartungen kündigen wir mindestens drei Tage vorher hier und in den Umgebungen an. Zugesagt sind 99,5 % Verfügbarkeit je Monat, siehe <a href="/leistungsbeschreibung">Leistungsbeschreibung</a>.</p>
    <p>Support: ${support.url ? html`<a href="${support.url}">Support-Portal</a> oder ` : ''}<a href="mailto:${support.email}">${support.email}</a></p>
    <p class="muted">Stand ${berlin(o.generatedAt)} · <a href="/status.json">als JSON</a></p>
  </div>`;
}

export interface AvailabilityView {
  month: string;
  ratio: number | null;
  breached: boolean;
}

/** Availability of an instance in the account: this month and the last (E-158). */
export function availabilityLine(list: AvailabilityView[]): Html {
  const month = (value: string) =>
    new Date(`${value}-15T12:00:00Z`).toLocaleDateString('de-DE', {
      month: 'long',
      year: 'numeric',
    });
  return html`<p class="muted">Verfügbarkeit: ${list.map(
    (entry, index) =>
      html`${index > 0 ? ', ' : ''}${month(entry.month)} ${entry.ratio === null ? 'keine Messung' : percent(entry.ratio)}${entry.breached ? ' (unter 99,5 %: Gutschrift auf Antrag)' : ''}`,
  )}</p>`;
}
