# Lenipo Cloud

Der private Steuerungsdienst für Lenipo als SaaS (Entscheidungen E-152 bis E-154 und E-156 bis E-158 im internen Repository): Anmeldung, Bereitstellung, Testphase, Tarife, Kündigung, Export und Löschung der Lenipo-Instanzen der Kunden, dazu ihr Betrieb: Updates in Wellen, Sicherungen, Schlafen, Überwachung, Kapazität und Kosten. Das Produkt selbst liegt öffentlich in `toolvibes/lenipo`; hier liegt nur, was den gehosteten Betrieb ausmacht.

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
- **Buchen** über Stripe Checkout (Adresse; mit `VAT_MODE=standard` auch USt.-ID und Stripe Tax). Stripe meldet das Abo über den Webhook `/stripe/webhook` (Ereignisse `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed`; Signatur mit `STRIPE_WEBHOOK_SECRET`). Eine angehaltene Instanz nach der Testphase kommt mit ihren Daten zurück.
- **Ändern** im Kundenkonto: mehr Plätze oder der größere Tarif werden sofort anteilig berechnet (`always_invoice`), weniger ohne Gutschrift ab dem nächsten Zeitraum. Zahlart, Rechnungsadresse und Rechnungen im Stripe-Kundenportal.
- **Kündigen** wirkt zum Ende des bezahlten Zeitraums (in der Testphase sofort) und lässt sich bis dahin zurücknehmen. Endet das Abo bei Stripe (auch nach erfolglosen Zahlungsversuchen), wird die Instanz angehalten wie nach einer Kündigung.
- **Nutzung**: einmal am Tag liest der Dienst `GET /api/v1/provider/usage` jeder laufenden Instanz und speichert Personen, Agenten und Speicher in `usage_samples`.

In Stripe einzurichten: zwei Produkte mit je einem Monats- und einem Jahrespreis je Platz (Menge = Plätze), als Kleinunternehmer in den Rechnungseinstellungen die Standard-Fußzeile „Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.“ (sonst Stripe Tax), das Kundenportal (Zahlart, Rechnungen, Adresse; Kündigung und Tarifwechsel laufen über Lenipo Cloud) und ein Webhook auf `https://cloud.lenipo.de/stripe/webhook` mit den Ereignissen oben.

## Betrieb vieler Instanzen (E-156)

Betreiber arbeiten mit der Kommandozeile im Container des Dienstes; sie liest und plant Arbeit ein, die der laufende Dienst erledigt:

```bash
docker compose exec cloud node dist/ops.js status
```

| Befehl | Wirkung |
| --- | --- |
| `status` | Instanzen je Status, Kapazität, Umsatz und Kosten, Rollout, ausgefallene Instanzen, offene Alarme |
| `tenants` | jede Instanz mit Version, Zustand, Personen und letzter Sicherung (`*` = Kanarienvogel) |
| `tenant <name>` | eine Instanz: Sicherungen, letzte Jobs, Ereignisse |
| `canary <name> on\|off` | kommt in die erste Welle eines Rollouts (eigene und Test-Instanzen) |
| `rollout start <version> [--wave <n>] [--now]`, `rollout status\|resume\|cancel` | eine neue Version ausrollen; Wellen nur im Wartungsfenster, `--now` für Sicherheitsupdates |
| `backup <name>`, `restore <name> <sicherung> --yes` | Sicherung jetzt; Wiederherstellung (vorher wird der jetzige Stand gesichert) |
| `import <name> <datei.zip> --yes` | Umzug in die Cloud: eine Sicherung aus der eigenen Lenipo-Installation des Kunden (gleiche Version) ersetzt die Daten der Instanz |
| `sleep <name>`, `wake <name>` | Schlafen von Hand |
| `retry <name>` | aufgegebene Jobs der Instanz neu starten |
| `alerts` | offene Alarme mit Text |
| `incidents` | offene Störungen und geplante Wartungen |
| `incident open <titel> <text>`, `incident update <id> <text>`, `incident resolve <id> [<text>]` | Störung auf der Statusseite |
| `maintenance plan <start> <minuten> <titel> [--urgent]`, `maintenance cancel <id>` | Wartung ankündigen (Start „JJJJ-MM-TT HH:MM“ deutsche Zeit, mindestens 3 Tage vorher) |
| `availability <name> [JJJJ-MM]` | Verfügbarkeit einer Instanz im Monat, gegen 99,5 % |
| `internal <name> on\|off` | Instanz des Betreibers (Support): ohne Testphasen-Ende, Schlaf und Grenzen |
| `legal status` | gültige und angekündigte Fassungen der Rechtstexte, noch auszufüllende Stellen |
| `legal announce <dokument> <n>` | gibt Fassung n aus `legal/` für ihr Datum frei und schreibt den Kunden |
| `legal accepted <e-mail>` | was ein Kunde wann und von wo angenommen hat |

- **Versionen und Rollouts:** Jede Instanz läuft mit ihrer eigenen Version (Tag des Images aus `LENIPO_IMAGE`). Ein Rollout geht in Wellen: zuerst die Kanarienvögel (ohne sie drei Instanzen), danach Gruppen von `--wave` (Standard 10), die nächste Welle erst, wenn die vorige durch ist. Vor jedem Update eine Sicherung, danach muss `/api/v1/health/ready` antworten (`READY_TIMEOUT_SECONDS`). Wird eine Instanz nicht bereit, geht sie auf ihre Version zurück; startet die alte Version auf der migrierten Datenbank nicht, kommt die Sicherung von vor dem Update zurück. Der Rollout hält dann an und der Betreiber bekommt einen Alarm. Neue Instanzen starten mit der Version des letzten fertigen Rollouts; schlafende folgen beim Aufwachen.
- **Sicherungen:** Ab `BACKUP_HOUR` (UTC) eine Sicherung je laufender Instanz am Tag im Format des Produkts (`backup-cli`) nach `BACKUP_DIR/<name>-<id>/`. Es bleiben die der letzten 7 Tage, eine je Woche für 4 Wochen, die übrigen Arten 14 Tage und von jeder Art die neueste. Die Wiederherstellung leert Instanz, Dateien und Datenbank, startet die Version, die die Sicherung schrieb, und spielt sie mit `restore-cli` ein. Sicherungen und Exporte liegen mit AES-256-GCM verschlüsselt (`*.zip.enc`, Schlüssel aus `SECRET_KEY` abgeleitet); entschlüsselt wird nur für eine Wiederherstellung und beim Herunterladen des Exports. Mit der Instanz werden auch ihre Sicherungen gelöscht. `BACKUP_DIR` gehört zusätzlich an einen zweiten Standort gespiegelt (z. B. per `rclone` in eine Storage Box).
- **Schlafen:** Eine Instanz in der Testphase, die `SLEEP_AFTER_DAYS` Tage niemand genutzt hat (Anmeldung, Browser, Token), wird nach einer Sicherung angehalten. Der erste Aufruf ihrer Adresse landet beim Dienst, zeigt eine Seite, die sich selbst neu lädt, und weckt sie. Bezahlte Instanzen schlafen nie; wer in der Schlafzeit bucht, weckt sie.
- **Überwachung:** Jede Minute die Bereitschaft jeder laufenden Instanz; nach drei Fehlschlägen in Folge ein Alarm, beim nächsten Erfolg die Entwarnung. Alarme gibt es außerdem für aufgegebene Jobs, angehaltene Rollouts und Kapazität ab 80 %. Sie gehen per Mail an `OPS_EMAIL` und stehen in `ops.js status`; jeder Alarm einmal, bis er erledigt ist.
- **Kennzahlen** für Prometheus unter `/ops/metrics` mit `Authorization: Bearer <OPS_METRICS_TOKEN>`: Instanzen je Status, schlafende, Kapazität, Umsatz, aufgegebene Jobs, offene Alarme und je Instanz Bereitschaft, Personen, Speicher, letzte Sicherung, Version.
- **Kapazität und Kosten:** Laufende Instanzen × `INSTANCE_MEMORY_MB` gegen `SERVER_MEMORY_MB`; ab 80 % ein Alarm, ist kein Platz für eine weitere Instanz, nimmt die Anmeldung keine neuen Kunden an („ausgebucht“). `status` zeigt den Monatsumsatz der gebuchten Tarife, `SERVER_COST_EUR` und die Kosten je laufender Instanz. Mehrere Server kommen, wenn einer nicht mehr reicht.
- **Anfragegrenzen:** Jeder Tarif setzt über die Grenzen der Instanz Obergrenzen für deren Rate-Limits (Anfragen je Minute je Person, je Token, ohne Anmeldung); Admins der Instanz können sie nur senken.
- **Jobs** laufen in `JOB_WORKERS` Schleifen, nie zwei einer Instanz zugleich; Fristen, Prüfungen und Rollouts laufen jede Minute daneben.

## Status, Support und Verfügbarkeit (E-158)

- **Statusseite** unter `/status` (lädt sich jede Minute neu) und als JSON unter `/status.json` (CORS offen): Gesamtzustand, bereite Umgebungen, laufende Störungen und Wartungen, geplante Wartungen, Verfügbarkeit der letzten 90 Tage, vergangene Störungen. Die Landingpage hat unter `status.html` eine eigene Statusseite auf ihrem Server, die das JSON lädt und „Status nicht erreichbar“ zeigt, wenn die Cloud nicht antwortet.
- **Störungen** trägt der Betreiber mit `ops.js incident` ein. Fallen viele Instanzen zugleich aus (mindestens drei bzw. 20 %, bei weniger Instanzen alle), öffnet der Dienst selbst eine Störung und schließt sie, wenn alle wieder antworten.
- **Wartung:** festes Fenster `MAINTENANCE_WINDOW` (Standard dienstags 06:00–08:00 deutscher Zeit); Rollout-Wellen starten nur darin, außer mit `--now`. Andere Wartungen mit `ops.js maintenance plan` mindestens 3 Tage vorher; die Instanzen zeigen ab 3 Tagen vorher einen „Hinweis des Anbieters“ (Produkt: `PUT /provider/notice`).
- **Verfügbarkeit:** Die minütliche Prüfung zählt je Instanz und Tag geprüfte und fehlgeschlagene Minuten; Minuten im Wartungsfenster und in mindestens 3 Tage vorher angekündigten Wartungen zählen nicht, schlafende Instanzen werden nicht geprüft. Das Kundenkonto zeigt den laufenden und letzten Monat; unter 99,5 % gibt es auf Antrag eine Gutschrift (`ops.js availability`, Gutschrift von Hand in Stripe). Zusagen und Antwortzeiten stehen in `legal/leistungsbeschreibung-1.md`.
- **Support:** eine eigene Lenipo-Instanz mit Service Desk (Portal und E-Mail-Eingang an `SUPPORT_EMAIL`). Einrichten: wie ein Kunde anmelden (z. B. Adresse `servicedesk`), `ops.js internal servicedesk on` und `ops.js canary servicedesk on`, im Service Desk den E-Mail-Eingang für support@lenipo.de einrichten und `SUPPORT_URL` auf das Portal setzen. Jede Instanz bekommt den Link mit ihren Grenzen und zeigt ihn als „Support kontaktieren“; das Kundenkonto und die Statusseite nennen ihn ebenfalls.

## Recht und Datenschutz (E-157)

- **Nur für Unternehmen:** Die Anmeldung verlangt die Bestätigung, für ein Unternehmen, eine Behörde oder einen Verein zu handeln, und die Zustimmung zu AGB und Auftragsverarbeitungsvertrag mit Anlagen. Gespeichert werden Dokument, Fassung, Zeitpunkt und IP-Adresse (`acceptances`); das Kundenkonto zeigt die gültigen Fassungen.
- **Rechtstexte** liegen als Markdown in `legal/<dokument>-<fassung>.md` mit Titel und Datum: `agb`, `leistungsbeschreibung`, `avv`, `tom`, `unterauftragnehmer` (Vertrag und Anlagen), `datenschutz`, `impressum`. Der Dienst zeigt sie unter `/<dokument>`, jede Fassung unter `/<dokument>/v/<n>` und alle unter `/rechtliches`; jede Seite verlinkt Impressum, Datenschutz und AGB.
- **Neue Fassung:** Datei `legal/agb-2.md` mit dem Datum des Inkrafttretens anlegen, ausliefern, dann `ops.js legal announce agb 2`. Vertragstexte brauchen mindestens 42 Tage Vorlauf und gelten erst nach der Ankündigung; jeder Kunde mit einer Umgebung bekommt einmal eine Mail mit Datum und Widerspruchsrecht, auch wer sich bis dahin neu anmeldet. Datenschutzerklärung und Impressum gelten ab ihrem Datum.
- **Löschkonzept:** unbestätigte Anmeldungen samt IP nach 7 Tagen, abgelaufene Anmeldelinks und Sitzungen 30 Tage nach Ablauf, Nutzungszahlen nach 13 Monaten, das Kundenkonto 90 Tage nach Löschung der letzten Umgebung (vorher auf Wunsch im Kundenkonto). Eine angehaltene Umgebung kann der Kunde vor ihrem Termin löschen. Rechnungen bleiben bei Stripe.
- **Protokolle** ohne IP-Adressen und Abfrageparameter; Container rotieren ihre Protokolle bei 3 × 10 MB.
- **Vor dem Start:** die Texte anwaltlich prüfen lassen; den E-Mail-Anbieter (Sitz und Verarbeitung in der EU, mit AVV) in `unterauftragnehmer-1.md` und `datenschutz-1.md` eintragen (der Dienst warnt beim Start, solange `[offen: …]` steht); auf dem Server SSH nur mit Schlüssel und eine Firewall, die nur 22, 80 und 443 durchlässt, wie die TOM es beschreiben.

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
| `VAT_MODE` | `small-business` (Standard): Kleinunternehmer nach § 19 UStG, keine Umsatzsteuer, Hinweis an Preisen und im Checkout; `standard`: zzgl. Umsatzsteuer über Stripe Tax mit Abfrage der USt.-ID |
| `TRIAL_DAYS`, `RETENTION_DAYS` | Standard 30 und 30 |
| `MAINTENANCE_WINDOW` | wöchentliches Wartungsfenster, Standard `tue 06:00-08:00` (deutsche Zeit); `always` nur für Entwicklung |
| `SUPPORT_URL`, `SUPPORT_EMAIL` | Portal der Support-Instanz und Adresse (Standard support@lenipo.de) |
| `OPS_EMAIL`, `OPS_METRICS_TOKEN` | Alarme per Mail; Token für `/ops/metrics` (ohne ihn gibt es den Endpunkt nicht) |
| `BACKUP_DIR`, `BACKUP_HOUR` | Sicherungen der Instanzen, ab welcher Stunde (UTC) |
| `SLEEP_AFTER_DAYS` | Testphase ohne Nutzung bis zum Schlafen, Standard 7; 0 = nie |
| `SERVER_MEMORY_MB`, `INSTANCE_MEMORY_MB`, `SERVER_COST_EUR` | Kapazität und Kosten des Servers |
| `READY_TIMEOUT_SECONDS`, `JOB_WORKERS` | Wartezeit auf Bereitschaft nach Update oder Wiederherstellung (300); parallele Jobs (2) |

## Entwicklung

```bash
pnpm install
pnpm typecheck && pnpm lint
DATABASE_URL=postgres://…/postgres pnpm test
```

Die Tests legen je Lauf eine eigene Datenbank auf dem Server aus `DATABASE_URL` an, nutzen die Plattform `memory` und eine nachgebaute Instanz-API, und steuern die Uhr selbst.

## Betrieb

`deploy/` enthält ein Beispiel für einen Server: der Dienst, PostgreSQL 17 mit pgvector für die Instanzen und Caddy mit Wildcard-Zertifikat für `*.lenipo.de` (DNS-Challenge bei Hetzner, Caddy mit dem Modul `caddy-dns/hetzner` bauen) und On-Demand-TLS für eigene Domains (`/tls/ask` erlaubt nur bestätigte Domains). Neue Routen fügt der Dienst vor der Sammelroute ein, die angehaltene Adressen auf eine Hinweisseite des Dienstes lenkt.

**TLS im Nginx Proxy Manager statt in Caddy:** `docker compose -f docker-compose.yml -f docker-compose.npm.yml up -d`. Caddy (Standard-Image, ohne DNS-Modul) hört dann nur auf HTTP (`CADDY_HTTP_PORT`, Standard 8088) mit `deploy/caddy-npm.json` und verteilt weiter nach Host an Dienst und Instanzen; `X-Forwarded-Proto` aus privaten Netzen wird durchgereicht, `HETZNER_DNS_TOKEN` entfällt. Im NPM:

- Proxy Host `cloud.lenipo.de` und Proxy Host `*.lenipo.de` auf `http://<server>:8088`, jeweils **Websockets Support** an (gemeinsames Bearbeiten im Wiki).
- Zertifikat per Let's Encrypt; für `*.lenipo.de` mit **DNS Challenge** (Wildcard geht nur so). Eigene Proxy Hosts wie `lenipo.de` und `www.lenipo.de` haben Vorrang vor dem Wildcard-Host.
- **Eigene Domains der Kunden** bekommen hier kein Zertifikat von selbst: Nach „DNS prüfen“ im Kundenkonto je Domain einen Proxy Host im NPM mit Let's-Encrypt-Zertifikat auf dasselbe Ziel anlegen.

## Offen

- Stripe-Konto, Preise und Webhook einrichten; die Preise in `src/plans.ts` sind Vorschläge.
- E-Mail-Anbieter wählen und in die Rechtstexte eintragen; die Rechtstexte anwaltlich prüfen lassen.
- Replikat und WAL-Archiv des PostgreSQL-Clusters, Spiegelung von `BACKUP_DIR` an einen zweiten Standort.
- Mehrere Server (Tabelle der Server, Verteilung neuer Instanzen), wenn einer nicht mehr reicht.
- Der Docker-Treiber ist per Smoke-Test (`node dist/smoke.js`) gegen Docker Desktop mit PostgreSQL, Caddy und dem Produkt-Image erprobt, noch nicht auf einem Server.
