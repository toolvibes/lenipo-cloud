---
title: Technische und organisatorische Maßnahmen
effective: 2026-11-04
---
Anlage 1 zum [Vertrag zur Auftragsverarbeitung](/avv). Sie beschreibt die Maßnahmen nach Art. 32 DSGVO, mit denen Lenipo Cloud die Daten der Umgebungen schützt.

## 1. Trennung der Kunden

- Jeder Kunde bekommt eine eigene Umgebung: einen eigenen Container der Anwendung, eine eigene Datenbank mit einer eigenen Datenbankrolle, die nur auf diese Datenbank zugreifen darf, und einen eigenen Dateispeicher.
- Export, Wiederherstellung und Löschung betreffen immer genau die Datenbank und den Dateispeicher einer Umgebung.
- Die Anwendung kennt keine Daten anderer Kunden; es gibt keine gemeinsamen Tabellen für Inhalte.

## 2. Vertraulichkeit

**Zutritt:** Die Server stehen in Rechenzentren der Hetzner Online GmbH in Deutschland, die nach ISO/IEC 27001 zertifiziert sind, mit Zutrittskontrolle, Videoüberwachung und Sicherheitspersonal.

**Zugang:**

- Anmeldung an den Servern nur per SSH mit persönlichem Schlüssel, ohne Passwort; nur der Betreiber hat Zugang.
- Eine Firewall lässt von außen nur HTTPS, HTTP (zur Weiterleitung auf HTTPS) und SSH zu. Datenbanken, die interne Steuerung und die Container der Umgebungen sind nur im internen Netz des Servers erreichbar.
- Das Kundenkonto von Lenipo Cloud nutzt Anmeldelinks per E-Mail, die einmal und 30 Minuten gelten; Sitzungen laufen nach 14 Tagen ab. Links und Sitzungen werden nur als Hash gespeichert.

**Zugriff:**

- In den Umgebungen steuern Rollen, Gruppen, Berechtigungsschemata und Sicherheitsstufen, wer was sieht. Passwörter liegen nur als Argon2id-Hash vor; Zwei-Faktor-Anmeldung und eigene Anmeldedienste (SAML, OpenID Connect) sind möglich.
- Zugangsdaten der Umgebungen (Datenbankpasswort, Einrichtungsschlüssel) speichert Lenipo Cloud mit AES-256-GCM verschlüsselt.
- Der Betreiber sieht Inhalte einer Umgebung nur ein, soweit es für den Betrieb, die Behebung einer Störung oder eine Anfrage des Kunden nötig ist.

**Verschlüsselung:**

- Alle Verbindungen von außen laufen über TLS (HTTPS) mit Zertifikaten von Let's Encrypt.
- Sicherungen und Exporte werden mit AES-256-GCM verschlüsselt gespeichert; der Schlüssel liegt nicht bei den Dateien. Entschlüsselt werden sie nur für eine Wiederherstellung und beim Herunterladen durch den Kunden.

## 3. Integrität

- Änderungen an Inhalten stehen im Verlauf der Vorgänge und Seiten; Änderungen an Rechten und Einstellungen im Audit-Protokoll der Umgebung.
- Lenipo Cloud protokolliert je Umgebung, was mit ihr geschah (Einrichtung, Sicherungen, Updates, Wiederherstellung, Löschung).
- Die Anwendung prüft alle Eingaben gegen feste Schemata und schützt Formulare gegen fremde Seiten (Herkunftsprüfung, SameSite-Cookies).

## 4. Verfügbarkeit und Belastbarkeit

- Tägliche Sicherung jeder Umgebung; aufbewahrt werden die der letzten sieben Tage und je eine wöchentliche der letzten vier Wochen. Vor jedem Update und jeder Wiederherstellung entsteht eine weitere Sicherung.
- Die Wiederherstellung ist ein festgelegter, automatisch getesteter Ablauf.
- Updates laufen in Wellen, zuerst für Test-Umgebungen. Wird eine Umgebung danach nicht bereit, geht sie auf die vorige Version oder die Sicherung von vor dem Update zurück.
- Jede Umgebung wird jede Minute auf Bereitschaft geprüft; Ausfälle melden sich per E-Mail beim Betreiber.
- Speicher und Anfragen sind je Umgebung begrenzt, damit eine Umgebung andere nicht beeinträchtigt. Ist ein Server ausgelastet, nimmt er keine neuen Umgebungen an.
- Die Rechenzentren haben eine unterbrechungsfreie Stromversorgung, Notstromaggregate, Klimatisierung und Brandschutz.

## 5. Datenminimierung und Löschung

- Lenipo Cloud speichert über Kunden nur, was für Vertrag und Betrieb nötig ist (siehe [Datenschutzerklärung](/datenschutz)). Die Protokolle des Dienstes enthalten keine IP-Adressen und keine Anmeldelinks; sie und die Protokolle der Umgebungen werden fortlaufend überschrieben (höchstens 30 MB je Container).
- Feste Fristen:

| Was | Wann gelöscht |
| --- | --- |
| Umgebung mit Datenbank, Dateien, Sicherungen und Export | 30 Tage nach Ende von Testphase oder Vertrag, auf Wunsch früher |
| Sicherungen im laufenden Betrieb | tägliche nach 7 Tagen, wöchentliche nach 4 Wochen, sonstige nach 14 Tagen |
| unbestätigte Anmeldungen samt IP-Adresse | nach 7 Tagen |
| abgelaufene Anmeldelinks und Sitzungen | 30 Tage nach Ablauf |
| tägliche Nutzungszahlen je Umgebung | nach 13 Monaten |
| Kundenkonto (E-Mail, Name, Zustimmungen, Verlauf) | 90 Tage nach Löschung der letzten Umgebung, auf Wunsch sofort |
| Rechnungen | bei Stripe, nach den gesetzlichen Fristen (bis zu 10 Jahre) |

## 6. Organisation

- Neue Versionen durchlaufen automatische Tests, eine Prüfung der Abhängigkeiten auf bekannte Schwachstellen und eine Sicherheitsprüfung der geänderten Teile.
- Sicherheitsupdates des Betriebssystems und der Software werden zeitnah eingespielt.
- Verletzungen des Schutzes personenbezogener Daten meldet der Betreiber nach § 9 des Vertrags zur Auftragsverarbeitung; er dokumentiert jeden Vorfall mit Ursache und Maßnahmen.
- Unterauftragnehmer werden nur mit Vertrag nach Art. 28 DSGVO eingesetzt und vorher geprüft.
- Diese Maßnahmen werden mindestens einmal im Jahr und nach jeder wesentlichen Änderung des Betriebs überprüft.
