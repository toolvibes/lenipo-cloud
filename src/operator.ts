import type { Compliance } from './compliance.js';
import type { Fleet } from './fleet.js';
import { DOCUMENT_KEYS } from './legal.js';
import { berlinDateTime, type StatusBoard } from './status.js';

/**
 * The commands of `ops.js` (E-156). They only read and queue work; the running service does it.
 * Returns the text to print; errors go to the caller.
 */
export const USAGE = `ops.js <command>

  status                       instances, capacity, revenue and costs, rollout, alerts
  tenants                      every instance with version, health and last backup
  tenant <name>                one instance: state, backups, jobs, events
  canary <name> on|off         updated in the first wave of a rollout
  rollout start <version> [--wave <n>] [--now]
                               waves start in the maintenance window; --now for security fixes
  rollout status | resume | cancel
  backup <name>                a backup now
  restore <name> <backup> --yes
                               replaces all data with that backup (id or its start)
  sleep <name> | wake <name>
  retry <name>                 failed jobs of the instance run again
  alerts                       open alerts
  incidents                    open incidents and planned maintenance
  incident open <title> <text> a public incident on the status page
  incident update <id> <text> | incident resolve <id> [<text>]
  maintenance plan <start> <minutes> <title> [--urgent]
                               start "YYYY-MM-DD HH:MM" German time, at least 3 days ahead
  maintenance cancel <id>
  availability <name> [YYYY-MM]
                               checked and failed minutes of a month, against 99.5 %
  internal <name> on|off       run by the operator (support desk): no trial end, sleep or limits
  legal status                 documents in force, announced versions, places to fill in
  legal announce <doc> <n>     releases version n from legal/ for its date and mails customers
  legal accepted <e-mail>      what a customer accepted, when and from where`;

const date = (value: Date | null | undefined) =>
  value ? value.toISOString().replace('T', ' ').slice(0, 16) : '–';
const euro = (value: number) => `${value.toFixed(2)} €`;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Columns padded to the widest cell. */
function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** "2026-11-10 06:00" in German time, or an ISO time with offset. */
export function parseBerlin(text: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return new Date(text);
  const [, y, mo, d, h, mi] = match.map(Number) as number[];
  const guess = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
  // The offset of Europe/Berlin at that moment (1 or 2 hours).
  const shown = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const utc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess - (shown.getTime() - utc.getTime()));
}

export async function runOps(
  fleet: Fleet,
  args: string[],
  compliance?: Compliance,
  status?: StatusBoard,
): Promise<string> {
  const board = () => {
    if (!status) throw new Error('This command needs the status part of the service');
    return status;
  };
  const [command, ...rest] = args;
  const flag = (name: string) => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const name = rest[0] ?? '';
  switch (command) {
    case 'status': {
      const o = await fleet.overview();
      const lines = [
        `Version für neue Instanzen: ${o.version}`,
        `Instanzen: ${
          Object.entries(o.byStatus)
            .map(([status, count]) => `${status} ${count}`)
            .join(', ') || 'keine'
        }; davon schlafend ${o.capacity.sleeping}`,
        `Kapazität: ${o.capacity.running} laufend, ${o.capacity.usedMb} von ${o.capacity.totalMb} MB (${Math.round(o.capacity.ratio * 100)} %)${o.capacity.full ? ', voll: keine neuen Anmeldungen' : ''}`,
        `Umsatz: ${euro(o.revenue.monthly)} im Monat aus ${o.revenue.paying} Tarifen; Kosten ${euro(o.cost.monthly)} (${euro(o.cost.perInstance)} je laufende Instanz); bleibt ${euro(o.cost.margin)}`,
      ];
      if (o.rollout) {
        const { rollout, done, pending } = o.rollout;
        lines.push(
          `Rollout auf ${rollout.version}: ${rollout.status}, ${done} fertig, ${pending.length} offen${rollout.pauseReason ? ` (${rollout.pauseReason})` : ''}`,
        );
      }
      if (o.down.length > 0) {
        lines.push(
          `Nicht bereit: ${o.down.map((row) => `${row.slug} seit ${date(row.since)}`).join(', ')}`,
        );
      }
      if (o.failedJobs > 0) lines.push(`Aufgegebene Jobs: ${o.failedJobs}`);
      lines.push(
        o.alerts.length > 0
          ? `Offene Alarme:\n${o.alerts.map((alert) => `  ${date(alert.openedAt)}  ${alert.subject}`).join('\n')}`
          : 'Keine offenen Alarme.',
      );
      return lines.join('\n');
    }
    case 'tenants': {
      const list = await fleet.tenants();
      return table([
        ['NAME', 'STATUS', 'VERSION', 'ZUSTAND', 'PERSONEN', 'SICHERUNG'],
        ...list.map(({ tenant, version, persons, lastBackupAt }) => [
          tenant.slug + (tenant.canary ? ' *' : ''),
          tenant.status,
          version,
          tenant.sleepingAt ? 'schläft' : tenant.downSince ? 'AUSGEFALLEN' : 'ok',
          persons === null ? '–' : String(persons),
          date(lastBackupAt),
        ]),
      ]);
    }
    case 'tenant': {
      const d = await fleet.details(name);
      const t = d.tenant;
      return [
        `${t.slug} (${t.name}): ${t.status}${t.sleepingAt ? `, schläft seit ${date(t.sleepingAt)}` : ''}${t.canary ? ', Kanarienvogel' : ''}`,
        `Version ${d.version}; zuletzt bereit ${date(t.healthyAt)}${t.downSince ? `; AUSGEFALLEN seit ${date(t.downSince)}` : ''}; zuletzt genutzt ${date(t.lastActiveAt)}`,
        t.plan
          ? `Tarif ${t.plan}, ${t.seats} Plätze, ${t.interval}`
          : `Testphase bis ${date(t.trialEndsAt)}`,
        '',
        'Sicherungen:',
        d.backups.length > 0
          ? table(
              d.backups.map((b) => [
                `  ${b.id.slice(0, 8)}`,
                date(b.createdAt),
                b.kind,
                b.version,
                megabytes(b.sizeBytes),
              ]),
            )
          : '  keine',
        '',
        'Jobs:',
        d.jobs.length > 0
          ? table(
              d.jobs.map((j) => [
                `  ${date(j.createdAt)}`,
                j.kind,
                j.status,
                `${j.attempts}×`,
                (j.lastError ?? '').slice(0, 80),
              ]),
            )
          : '  keine',
        '',
        'Ereignisse:',
        ...d.events.map(
          (e) =>
            `  ${date(e.at)}  ${e.kind}${JSON.stringify(e.details) === '{}' ? '' : `  ${JSON.stringify(e.details)}`}`,
        ),
      ].join('\n');
    }
    case 'canary': {
      const on = rest[1] === 'on';
      if (rest[1] !== 'on' && rest[1] !== 'off') throw new Error('canary <name> on|off');
      await fleet.setCanary(name, on);
      return `${name}: ${on ? 'in der ersten Welle' : 'nicht mehr in der ersten Welle'}.`;
    }
    case 'rollout': {
      const action = rest[0];
      if (action === 'start') {
        const version = rest[1] ?? '';
        const wave = flag('--wave');
        const now = rest.includes('--now');
        const rollout = await fleet.startRollout(version, wave ? Number(wave) : undefined, now);
        return `Rollout auf ${rollout.version} gestartet, Wellen zu ${rollout.waveSize}. ${
          now
            ? 'Die erste Welle beginnt innerhalb einer Minute.'
            : 'Die Wellen laufen im Wartungsfenster.'
        }`;
      }
      if (action === 'resume')
        return `Rollout auf ${(await fleet.resumeRollout()).version} läuft weiter.`;
      if (action === 'cancel')
        return `Rollout auf ${(await fleet.cancelRollout()).version} abgebrochen.`;
      if (action === 'status' || action === undefined) {
        const state = await fleet.rolloutStatus();
        if (!state)
          return `Kein Rollout offen. Neue Instanzen starten mit ${await fleet.currentVersion()}.`;
        return `Rollout auf ${state.rollout.version}: ${state.rollout.status}, Welle ${state.rollout.waves}, ${state.done} fertig, offen: ${state.pending.join(', ') || '–'}${state.rollout.pauseReason ? `\nAngehalten: ${state.rollout.pauseReason}` : ''}`;
      }
      throw new Error('rollout start <version> [--wave <n>] | status | resume | cancel');
    }
    case 'backup':
      await fleet.requestBackup(name);
      return `Sicherung von ${name} ist eingeplant; sie erscheint unter: ops.js tenant ${name}`;
    case 'restore': {
      if (!rest.includes('--yes')) {
        throw new Error(
          `Ersetzt alle Daten von ${name} durch die Sicherung (vorher wird der jetzige Stand gesichert). Mit --yes bestätigen.`,
        );
      }
      const backup = await fleet.requestRestore(name, rest[1] ?? '');
      return `Wiederherstellung von ${name} auf den Stand vom ${date(backup.createdAt)} (Version ${backup.version}) ist eingeplant.`;
    }
    case 'sleep':
      await fleet.requestSleep(name);
      return `${name} schläft gleich.`;
    case 'wake':
      await fleet.requestWake(name);
      return `${name} wird geweckt.`;
    case 'retry':
      return `${await fleet.retry(name)} Jobs von ${name} laufen erneut.`;
    case 'alerts': {
      const alerts = await fleet.openAlerts();
      return alerts.length > 0
        ? alerts
            .map(
              (alert) =>
                `${date(alert.openedAt)}  ${alert.subject}\n  ${alert.text.replaceAll('\n', '\n  ')}`,
            )
            .join('\n\n')
        : 'Keine offenen Alarme.';
    }
    case 'incidents': {
      const open = await board().openIncidents();
      return open.length > 0
        ? open
            .map(
              (row) =>
                `#${row.id}  ${row.kind === 'maintenance' ? 'Wartung' : 'Störung'}  ${berlinDateTime(row.startsAt)}${row.endsAt ? ` bis ${berlinDateTime(row.endsAt)}` : ''}  ${row.title}${row.automatic ? ' (automatisch)' : ''}`,
            )
            .join('\n')
        : 'Keine offenen Störungen oder geplanten Wartungen.';
    }
    case 'incident': {
      const [action, first = '', second] = rest;
      if (action === 'open') {
        if (!first || !second) throw new Error('incident open <title> <text>');
        const row = await board().openIncident(first, second);
        return `Störung #${row.id} steht auf der Statusseite.`;
      }
      if (action === 'update') {
        if (!second) throw new Error('incident update <id> <text>');
        await board().updateIncident(Number(first), second);
        return `#${first} ergänzt.`;
      }
      if (action === 'resolve') {
        await board().resolveIncident(Number(first), second);
        return `#${first} ist behoben.`;
      }
      throw new Error('incident open <title> <text> | update <id> <text> | resolve <id> [<text>]');
    }
    case 'maintenance': {
      const [action, first = '', second = '', ...words] = rest;
      if (action === 'plan') {
        const title = words.filter((word) => word !== '--urgent').join(' ');
        if (!title) throw new Error('maintenance plan <start> <minutes> <title> [--urgent]');
        const row = await board().planMaintenance(
          parseBerlin(first),
          Number(second),
          title,
          rest.includes('--urgent'),
        );
        return `Wartung #${row.id} am ${berlinDateTime(row.startsAt)} steht auf der Statusseite; die Instanzen zeigen sie ab drei Tagen vorher.`;
      }
      if (action === 'cancel') {
        await board().cancelMaintenance(Number(first));
        return `Wartung #${first} ist abgesagt.`;
      }
      throw new Error('maintenance plan <start> <minutes> <title> [--urgent] | cancel <id>');
    }
    case 'availability': {
      const tenant = await fleet.tenantBySlug(name);
      const month = rest[1] ?? new Date().toISOString().slice(0, 7);
      const a = await board().availability(tenant.id, month);
      return a.ratio === null
        ? `${name} ${month}: keine Prüfungen.`
        : `${name} ${month}: ${(a.ratio * 100).toFixed(3)} % verfügbar (${a.checked} Minuten geprüft, ${a.failed} ausgefallen, ${a.maintenance} in Wartung)${a.breached ? '; unter 99,5 %: Gutschrift auf Antrag' : ''}.`;
    }
    case 'internal': {
      const on = rest[1] === 'on';
      if (rest[1] !== 'on' && rest[1] !== 'off') throw new Error('internal <name> on|off');
      await fleet.setInternal(name, on);
      return `${name}: ${on ? 'intern, ohne Testphase, Schlaf und Grenzen' : 'wieder wie eine Kundeninstanz'}.`;
    }
    case 'legal': {
      if (!compliance) throw new Error('legal needs the compliance part of the service');
      const [action, document = '', version = ''] = rest;
      if (action === 'announce') {
        const { effective } = await compliance.announce(document, Number(version));
        return `${document} Fassung ${version} gilt ab ${effective.toISOString().slice(0, 10)}. Die Kunden mit einer Umgebung bekommen innerhalb einer Minute eine Mail.`;
      }
      if (action === 'accepted') {
        const rows = await compliance.acceptancesByEmail(document);
        if (rows === null) throw new Error(`Kein Kunde mit ${document}`);
        return rows.length > 0
          ? table([
              ['Dokument', 'Fassung', 'Zeitpunkt', 'IP'],
              ...rows.map((row) => [
                row.document,
                String(row.version),
                date(row.acceptedAt),
                row.ip ?? '–',
              ]),
            ])
          : 'Keine Zustimmungen gespeichert.';
      }
      if (action === 'status' || action === undefined) {
        const lines = [];
        for (const key of DOCUMENT_KEYS) {
          const current = await compliance.current(key);
          const upcoming = await compliance.upcoming(key);
          lines.push([
            key,
            `Fassung ${current.version} seit ${current.effective.toISOString().slice(0, 10)}`,
            upcoming
              ? `Fassung ${upcoming.version} ab ${upcoming.effective.toISOString().slice(0, 10)}`
              : '',
          ]);
        }
        const open = compliance.openItems();
        return [
          table([['Dokument', 'gültig', 'angekündigt'], ...lines]),
          open.length > 0
            ? `\nNoch auszufüllen vor dem Start:\n${open.map((item) => `  ${item}`).join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
      }
      throw new Error('legal status | announce <doc> <n> | accepted <e-mail>');
    }
    default:
      return USAGE;
  }
}
