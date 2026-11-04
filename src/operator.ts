import type { Fleet } from './fleet.js';

/**
 * The commands of `ops.js` (E-156). They only read and queue work; the running service does it.
 * Returns the text to print; errors go to the caller.
 */
export const USAGE = `ops.js <command>

  status                       instances, capacity, revenue and costs, rollout, alerts
  tenants                      every instance with version, health and last backup
  tenant <name>                one instance: state, backups, jobs, events
  canary <name> on|off         updated in the first wave of a rollout
  rollout start <version> [--wave <n>]
  rollout status | resume | cancel
  backup <name>                a backup now
  restore <name> <backup> --yes
                               replaces all data with that backup (id or its start)
  sleep <name> | wake <name>
  retry <name>                 failed jobs of the instance run again
  alerts                       open alerts`;

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

export async function runOps(fleet: Fleet, args: string[]): Promise<string> {
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
        const rollout = await fleet.startRollout(version, wave ? Number(wave) : undefined);
        return `Rollout auf ${rollout.version} gestartet, Wellen zu ${rollout.waveSize}. Die erste Welle beginnt innerhalb einer Minute.`;
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
    default:
      return USAGE;
  }
}
