# Lenipo Cloud

Der private Steuerungsdienst für Lenipo als SaaS (Entscheidungen E-152, E-153 im internen Repository): Anmeldung, Bereitstellung, Testphase, Kündigung, Export und Löschung der Lenipo-Instanzen der Kunden. Das Produkt selbst liegt öffentlich in `toolvibes/lenipo`; hier liegt nur, was den gehosteten Betrieb ausmacht.

## Modell

- **Eine Instanz je Kunde:** ein Container aus dem Produkt-Image (`lenipo-<name>`), eine Datenbank mit eigener Rolle (`t_<name>`) im PostgreSQL-Cluster des Servers, ein Docker-Volume für Dateien (`lenipo-<name>-files`), eine Route in Caddy für `<name>.lenipo.de` und optional eine eigene Domain.
- **Ersteinrichtung ohne Passwörter im Dienst:** Jede Instanz bekommt ein zufälliges `SETUP_TOKEN`. Damit legt der Dienst über `POST /api/v1/setup/provision` den Namen und eine Einladung für die erste Admin-Person an; deren Link geht in der Willkommens-Mail an den Kunden.
- **Kundenkonto** unter `/account`, Anmeldung per Link per E-Mail. Dort: Adresse, Testphase, eigene Domain (CNAME auf `<name>.lenipo.de`, dann „DNS prüfen“), Kündigung, Export.

## Ablauf

| Schritt | Was passiert |
| --- | --- |
| Anmeldung (`/signup`) | E-Mail, Organisation, Name prüfen (3–30 Zeichen, nicht reserviert, frei), Bestätigungslink (48 h) |
| Bestätigung | Kunde und Instanz anlegen (Status `provisioning`), Job `provision` |
| `provision` | Datenbank und Rolle, Container, Route; warten bis `/api/v1/health/live`; Einrichtung per `SETUP_TOKEN`; Willkommens-Mail; Status `trial` (30 Tage) |
| Erinnerungen | 7 Tage und 1 Tag vor Ende der Testphase |
| Ende der Testphase oder Kündigung | Status `suspended`, Route weg, Container angehalten; Job `export` schreibt eine Sicherung im Format des Produkts (`backup-cli` im Container) nach `EXPORT_DIR`; Mail |
| Aufbewahrung | 30 Tage nach dem Anhalten; Erinnerungen 7 Tage und 1 Tag vorher |
| Löschung | Route, Container, Volume, Datenbank, Rolle und Export weg; Status `deleted`; Name wieder frei; Mail |

Jobs laufen in einem Hintergrund-Loop im selben Prozess, jeder Schritt ist wiederholbar. Ein Fehler setzt den Job mit wachsender Pause (bis 60 Minuten) zurück in die Warteschlange; nach zehn Versuchen bleibt er `failed` stehen (bei der Bereitstellung auch die Instanz). Was mit einer Instanz geschah, steht in `tenant_events`.

## Tarife und Zahlung (E-154)

- **Tarife** in `src/plans.ts`: `Team` und `Business` mit Preis je Platz und Monat (monatlich oder jährlich), Grenzen für Agenten, Speicher (Grundmenge plus je Platz), Service Desk und Module. Die angezeigten Beträge müssen zu den Preisen in Stripe passen; abgerechnet wird, was in Stripe steht (`STRIPE_PRICES` ordnet `plan:interval` einer Preis-ID zu).
- **Plätze** werden im Voraus gebucht, mindestens so viele, wie Personen aktiv sind (Gäste und KI-Agenten zählen nicht). Die Instanz bekommt den Rahmen über `PUT /api/v1/provider/limits` mit ihrem `SETUP_TOKEN` und setzt ihn sofort durch; in der Testphase gilt `TRIAL_LIMITS`.
- **Buchen** über Stripe Checkout (Adresse, USt.-ID, Stripe Tax). Stripe meldet das Abo über den Webhook `/stripe/webhook` (Ereignisse `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed`; Signatur mit `STRIPE_WEBHOOK_SECRET`). Eine angehaltene Instanz nach der Testphase kommt mit ihren Daten zurück.
- **Ändern** im Kundenkonto: mehr Plätze oder der größere Tarif werden sofort anteilig berechnet (`always_invoice`), weniger ohne Gutschrift ab dem nächsten Zeitraum. Zahlart, Rechnungsadresse und Rechnungen im Stripe-Kundenportal.
- **Kündigen** wirkt zum Ende des bezahlten Zeitraums (in der Testphase sofort) und lässt sich bis dahin zurücknehmen. Endet das Abo bei Stripe (auch nach erfolglosen Zahlungsversuchen), wird die Instanz angehalten wie nach einer Kündigung.
- **Nutzung**: einmal am Tag liest der Dienst `GET /api/v1/provider/usage` jeder laufenden Instanz und speichert Personen, Agenten und Speicher in `usage_samples`.

In Stripe einzurichten: zwei Produkte mit je einem Monats- und einem Jahrespreis je Platz (Menge = Plätze), Stripe Tax, das Kundenportal (Zahlart, Rechnungen, Adresse; Kündigung und Tarifwechsel laufen über Lenipo Cloud) und ein Webhook auf `https://cloud.lenipo.de/stripe/webhook` mit den Ereignissen oben.

## Konfiguration

Alle Werte stehen mit Beschreibung in `src/config.ts`; die wichtigsten:

| Variable | Bedeutung |
| --- | --- |
| `DATABASE_URL` | Datenbank des Dienstes |
| `CLOUD_URL`, `BASE_DOMAIN` | Adresse des Dienstes, Domain der Instanzen |
| `SECRET_KEY` | verschlüsselt Datenbank-Passwörter und Setup-Tokens der Instanzen; nie ändern |
| `SMTP_URL`, `MAIL_FROM` | Mails an Kunden; ohne `SMTP_URL` nur ins Log |
| `PLATFORM` | `docker` oder `memory` (Tests) |
| `LENIPO_IMAGE` | Produkt-Image der Instanzen |
| `TENANT_DATABASE_ADMIN_URL`, `TENANT_DATABASE_HOST` | Superuser-Zugang zum Cluster, Adresse aus Sicht der Instanzen |
| `CADDY_ADMIN_URL`, `CADDY_SERVER` | Admin-API von Caddy |
| `TENANT_SMTP_URL`, `TENANT_MAIL_FROM` | Mails der Instanzen selbst |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe; ohne Schlüssel laufen Zahlungen nur im Speicher (Entwicklung) |
| `STRIPE_PRICES` | JSON, z. B. `{"team:month":"price_…","team:year":"price_…","business:month":"price_…","business:year":"price_…"}` |
| `STRIPE_AUTOMATIC_TAX` | Stripe Tax für die Umsatzsteuer (Standard an) |
| `TRIAL_DAYS`, `RETENTION_DAYS` | Standard 30 und 30 |

## Entwicklung

```bash
pnpm install
pnpm typecheck && pnpm lint
DATABASE_URL=postgres://…/postgres pnpm test
```

Die Tests legen je Lauf eine eigene Datenbank auf dem Server aus `DATABASE_URL` an, nutzen die Plattform `memory` und eine nachgebaute Instanz-API, und steuern die Uhr selbst.

## Betrieb

`deploy/` enthält ein Beispiel für einen Server: der Dienst, PostgreSQL 17 mit pgvector für die Instanzen und Caddy mit Wildcard-Zertifikat für `*.lenipo.de` (DNS-Challenge bei Hetzner, Caddy mit dem Modul `caddy-dns/hetzner` bauen) und On-Demand-TLS für eigene Domains (`/tls/ask` erlaubt nur bestätigte Domains). Neue Routen fügt der Dienst vor der Sammelroute ein, die angehaltene Adressen auf eine Hinweisseite des Dienstes lenkt.

## Offen

- Stripe-Konto, Preise und Webhook einrichten; die Preise in `src/plans.ts` sind Vorschläge.
- Betrieb vieler Instanzen: Replikat und WAL-Archiv des Clusters, nächtliche Sicherungen je Kunde, rollierende Updates, Monitoring, Schlafen und Aufwecken.
- Der Docker-Treiber ist per Smoke-Test (`node dist/smoke.js`) gegen Docker Desktop mit PostgreSQL, Caddy und dem Produkt-Image erprobt, noch nicht auf einem Server.
