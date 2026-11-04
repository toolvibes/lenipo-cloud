import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The legal documents of Lenipo Cloud (E-157): Markdown files `legal/<document>-<version>.md`
 * with a short head (title, effective). Every version stays reachable under its own address.
 */
export const DOCUMENTS = {
  agb: { title: 'Allgemeine Geschäftsbedingungen', contract: true },
  leistungsbeschreibung: { title: 'Leistungsbeschreibung', contract: true },
  avv: { title: 'Vertrag zur Auftragsverarbeitung', contract: true },
  tom: { title: 'Technische und organisatorische Maßnahmen', contract: true },
  unterauftragnehmer: { title: 'Unterauftragnehmer', contract: true },
  datenschutz: { title: 'Datenschutzerklärung', contract: false },
  impressum: { title: 'Impressum', contract: false },
} as const;
export type DocumentKey = keyof typeof DOCUMENTS;
export const DOCUMENT_KEYS = Object.keys(DOCUMENTS) as DocumentKey[];
/** What a customer accepts at sign-up: the contract and its annexes. */
export const ACCEPTED: DocumentKey[] = [
  'agb',
  'leistungsbeschreibung',
  'avv',
  'tom',
  'unterauftragnehmer',
];
/** Contract documents change only after this notice, with the right to object (E-157). */
export const NOTICE_DAYS = 42;

export const isDocument = (value: string): value is DocumentKey =>
  (DOCUMENT_KEYS as string[]).includes(value);

export interface LegalVersion {
  document: DocumentKey;
  version: number;
  title: string;
  /** From this day on (00:00 Europe/Berlin is close enough; we use UTC midnight). */
  effective: Date;
  body: string;
}

/** Announced versions, from the database: "agb:2". */
export type Announced = ReadonlySet<string>;

export const DEFAULT_LEGAL_DIR = fileURLToPath(new URL('../legal/', import.meta.url));

/** Marks text a person still has to fill in before the start, e.g. the mail provider. */
export const OPEN_MARK = '[offen:';

export class Legal {
  private readonly versions = new Map<DocumentKey, LegalVersion[]>();

  constructor(dir = DEFAULT_LEGAL_DIR) {
    for (const name of readdirSync(dir)) {
      const match = /^([a-z]+)-(\d+)\.md$/.exec(name);
      if (!match) continue;
      const [, key = '', number = ''] = match;
      if (!isDocument(key)) throw new Error(`Unknown legal document ${name}`);
      const text = readFileSync(join(dir, name), 'utf8');
      const head = /^---\n([\s\S]*?)\n---\n/.exec(text);
      if (!head) throw new Error(`${name} has no head`);
      const field = (field: string) =>
        new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(head[1] ?? '')?.[1]?.trim();
      const effective = new Date(`${field('effective') ?? ''}T00:00:00Z`);
      if (Number.isNaN(effective.getTime())) throw new Error(`${name}: effective is no date`);
      const list = this.versions.get(key) ?? [];
      list.push({
        document: key,
        version: Number(number),
        title: field('title') ?? DOCUMENTS[key].title,
        effective,
        body: text.slice(head[0].length),
      });
      this.versions.set(key, list);
    }
    for (const key of DOCUMENT_KEYS) {
      const list = this.versions.get(key);
      if (!list?.length) throw new Error(`Legal document ${key} is missing`);
      list.sort((a, b) => a.version - b.version);
      if (list[0]?.version !== 1) throw new Error(`Legal document ${key} starts with version 1`);
    }
  }

  all(document: DocumentKey): LegalVersion[] {
    return this.versions.get(document) ?? [];
  }

  version(document: DocumentKey, version: number): LegalVersion | undefined {
    return this.all(document).find((entry) => entry.version === version);
  }

  /** Whether a version may take effect: always for the first, else once announced (contracts). */
  private released(entry: LegalVersion, announced: Announced): boolean {
    return (
      entry.version === 1 ||
      !DOCUMENTS[entry.document].contract ||
      announced.has(`${entry.document}:${entry.version}`)
    );
  }

  /** The version in force now. */
  current(document: DocumentKey, now: Date, announced: Announced): LegalVersion {
    const list = this.all(document).filter(
      (entry) => entry.effective <= now && this.released(entry, announced),
    );
    const found = list.at(-1) ?? this.all(document)[0];
    if (!found) throw new Error(`Legal document ${document} is missing`);
    return found;
  }

  /** A released version that takes effect later, if any. */
  upcoming(document: DocumentKey, now: Date, announced: Announced): LegalVersion | undefined {
    return this.all(document).find(
      (entry) => entry.effective > now && entry.version > 1 && this.released(entry, announced),
    );
  }

  /** Places someone still has to fill in, e.g. "agb-1.md: [offen: …]". */
  openItems(): string[] {
    const items: string[] = [];
    for (const list of this.versions.values()) {
      for (const entry of list) {
        for (const line of entry.body.split('\n')) {
          const at = line.indexOf(OPEN_MARK);
          if (at >= 0) {
            items.push(
              `${entry.document}-${entry.version}.md: ${line.slice(at, line.indexOf(']', at) + 1)}`,
            );
          }
        }
      }
    }
    return items;
  }
}
