import { readFile, writeFile } from 'node:fs/promises';
import type { Instance, Platform } from './platform.js';

interface State {
  database: boolean;
  container: 'running' | 'stopped' | null;
  image: string | null;
  hosts: string[];
  /** Backups played in, in order. */
  restored: string[];
  env: Record<string, string>;
}

/**
 * A platform that only keeps notes (tests, development without Docker). The API of the
 * instances is wherever `instanceUrl` points, e.g. a stand-in server in tests.
 */
export class MemoryPlatform implements Platform {
  readonly state = new Map<string, State>();
  /** Steps to fail once, e.g. "ensureInstance", to test retries. */
  readonly failOnce = new Set<string>();

  constructor(private readonly url: (slug: string) => string) {}

  private of(slug: string): State {
    const known = this.state.get(slug);
    if (known) return known;
    const fresh: State = {
      database: false,
      container: null,
      image: null,
      hosts: [],
      restored: [],
      env: {},
    };
    this.state.set(slug, fresh);
    return fresh;
  }

  private step(name: string) {
    if (this.failOnce.delete(name)) throw new Error(`${name} failed (test)`);
  }

  async ensureDatabase(instance: Instance) {
    this.step('ensureDatabase');
    this.of(instance.slug).database = true;
  }

  async dropDatabase(slug: string) {
    this.of(slug).database = false;
  }

  async ensureInstance(instance: Instance) {
    this.step('ensureInstance');
    const state = this.of(instance.slug);
    state.container = 'running';
    state.image = instance.image;
    state.env = instance.env;
  }

  async stopInstance(slug: string) {
    const state = this.of(slug);
    if (state.container) state.container = 'stopped';
  }

  async startInstance(slug: string) {
    const state = this.of(slug);
    if (state.container) state.container = 'running';
  }

  async removeInstance(slug: string) {
    const state = this.of(slug);
    state.container = null;
    state.image = null;
  }

  async ensureRoute(instance: Instance) {
    this.of(instance.slug).hosts = instance.hosts;
  }

  async removeRoute(slug: string) {
    this.of(slug).hosts = [];
  }

  instanceUrl(slug: string) {
    return this.url(slug);
  }

  private exports = 0;

  async exportInstance(slug: string, file: string) {
    this.step('exportInstance');
    this.exports += 1;
    await writeFile(file, `PK export of ${slug} #${this.exports}`);
  }

  async restoreInstance(slug: string, file: string) {
    this.step('restoreInstance');
    const state = this.of(slug);
    if (state.container !== 'running') throw new Error(`${slug} does not run`);
    state.restored.push(await readFile(file, 'utf8'));
  }
}
