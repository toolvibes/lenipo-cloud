import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import postgres from 'postgres';
import { Client, request } from 'undici';
import type { Config } from '../config.js';
import {
  containerName,
  databaseName,
  type Instance,
  type Platform,
  volumeName,
} from './platform.js';
import { extractSingleFile, packSingleFile } from './tar.js';

const MOUNT = '/var/lib/lenipo/files';
const EXPORT_PATH = '/tmp/lenipo-export.zip';
const RESTORE_DIR = '/tmp';
const RESTORE_NAME = 'lenipo-restore.zip';

/** Quotes an SQL identifier; names here come from validated slugs only. */
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * Instances as Docker containers on one host (E-152, E-153): the Docker Engine API over its
 * socket, a superuser connection to the PostgreSQL cluster, and the admin API of Caddy.
 */
export class DockerPlatform implements Platform {
  private readonly docker: Client;

  constructor(private readonly config: Config) {
    this.docker = new Client('http://docker', { socketPath: config.DOCKER_SOCKET });
  }

  private async api(method: string, path: string, body?: unknown, okStatuses: number[] = []) {
    const response = await this.docker.request({
      method: method as 'GET',
      path: `/v1.43${path}`,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.body.text();
    if (response.statusCode >= 400 && !okStatuses.includes(response.statusCode)) {
      throw new Error(`Docker ${method} ${path}: ${response.statusCode} ${text.slice(0, 300)}`);
    }
    return { status: response.statusCode, json: text ? (JSON.parse(text) as unknown) : null };
  }

  private admin() {
    const url = this.config.TENANT_DATABASE_ADMIN_URL;
    if (!url) throw new Error('TENANT_DATABASE_ADMIN_URL is not set');
    return postgres(url, { max: 1, onnotice: () => {} });
  }

  async ensureDatabase(instance: Instance) {
    const name = databaseName(instance.slug);
    const sql = this.admin();
    try {
      const role = await sql`select 1 from pg_roles where rolname = ${name}`;
      await sql.unsafe(
        `${role.length > 0 ? 'alter' : 'create'} role ${ident(name)} login password ${literal(instance.databasePassword)}`,
      );
      const exists = await sql`select 1 from pg_database where datname = ${name}`;
      if (exists.length === 0) {
        await sql.unsafe(`create database ${ident(name)} owner ${ident(name)}`);
      }
      await sql.unsafe(`revoke connect on database ${ident(name)} from public`);
    } finally {
      await sql.end({ timeout: 5 });
    }
    // pgvector for the search by meaning; the instance creates its tables itself.
    const url = new URL(this.config.TENANT_DATABASE_ADMIN_URL as string);
    url.pathname = `/${name}`;
    const tenant = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      await tenant.unsafe('create extension if not exists vector');
    } catch {
      // Without pgvector the instance runs, just without search by meaning.
    } finally {
      await tenant.end({ timeout: 5 });
    }
  }

  async dropDatabase(slug: string) {
    const name = databaseName(slug);
    const sql = this.admin();
    try {
      await sql.unsafe(`drop database if exists ${ident(name)} with (force)`);
      await sql.unsafe(`drop role if exists ${ident(name)}`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  private async ensureNetwork() {
    const found = await this.api(
      'GET',
      `/networks/${this.config.DOCKER_NETWORK}`,
      undefined,
      [404],
    );
    if (found.status === 404) {
      await this.api('POST', '/networks/create', { Name: this.config.DOCKER_NETWORK }, [409]);
    }
  }

  private async ensureImage(image: string) {
    const found = await this.api(
      'GET',
      `/images/${encodeURIComponent(image)}/json`,
      undefined,
      [404],
    );
    if (found.status !== 404) return;
    const [repository, tag = 'latest'] = image.split(/:(?=[^/]+$)/);
    // The answer streams progress until the pull is complete.
    await this.api(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(repository ?? image)}&tag=${encodeURIComponent(tag)}`,
    );
  }

  async ensureInstance(instance: Instance) {
    await this.ensureNetwork();
    await this.ensureImage(instance.image);
    const name = containerName(instance.slug);
    const env = Object.entries(instance.env)
      .map(([key, value]) => `${key}=${value}`)
      .sort();
    // A changed environment or image needs a new container; the files stay in the volume.
    const signature = JSON.stringify([instance.image, env]);
    const existing = await this.api('GET', `/containers/${name}/json`, undefined, [404]);
    if (existing.status !== 404) {
      const labels = (existing.json as { Config?: { Labels?: Record<string, string> } }).Config
        ?.Labels;
      if (labels?.['lenipo.signature'] === signature) {
        await this.api('POST', `/containers/${name}/start`, undefined, [304]);
        return;
      }
      await this.api('DELETE', `/containers/${name}?force=true`);
    }
    await this.api('POST', '/volumes/create', { Name: volumeName(instance.slug) });
    await this.api('POST', `/containers/create?name=${name}`, {
      Image: instance.image,
      Env: env,
      Labels: {
        'lenipo.tenant': instance.slug,
        'lenipo.signature': signature,
      },
      HostConfig: {
        Binds: [`${volumeName(instance.slug)}:${MOUNT}`],
        NetworkMode: this.config.DOCKER_NETWORK,
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: this.config.INSTANCE_MEMORY_MB * 1024 * 1024,
      },
    });
    await this.api('POST', `/containers/${name}/start`, undefined, [304]);
  }

  async stopInstance(slug: string) {
    await this.api('POST', `/containers/${containerName(slug)}/stop`, undefined, [304, 404]);
  }

  async startInstance(slug: string) {
    await this.api('POST', `/containers/${containerName(slug)}/start`, undefined, [304]);
  }

  async removeInstance(slug: string) {
    await this.api('DELETE', `/containers/${containerName(slug)}?force=true`, undefined, [404]);
    await this.api('DELETE', `/volumes/${volumeName(slug)}`, undefined, [404]);
  }

  private routeId(slug: string) {
    return `lenipo-${slug}`;
  }

  private async caddy(method: string, path: string, body?: unknown, okStatuses: number[] = []) {
    const response = await request(`${this.config.CADDY_ADMIN_URL}${path}`, {
      method: method as 'GET',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.body.text();
    if (response.statusCode >= 400 && !okStatuses.includes(response.statusCode)) {
      throw new Error(`Caddy ${method} ${path}: ${response.statusCode} ${text.slice(0, 300)}`);
    }
  }

  async ensureRoute(instance: Instance) {
    const upstream = containerName(instance.slug);
    await this.removeRoute(instance.slug);
    // Inserted first: the catch-all for stopped instances stays behind the routes of instances.
    await this.caddy('PUT', `/config/apps/http/servers/${this.config.CADDY_SERVER}/routes/0`, {
      '@id': this.routeId(instance.slug),
      match: [{ host: instance.hosts }],
      terminal: true,
      handle: [
        {
          handler: 'subroute',
          routes: [
            {
              // Collaborative editing (WebSocket) goes to the collaboration server.
              match: [{ path: ['/collab*'] }],
              handle: [
                { handler: 'rewrite', strip_path_prefix: '/collab' },
                { handler: 'reverse_proxy', upstreams: [{ dial: `${upstream}:4001` }] },
              ],
            },
            { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `${upstream}:4000` }] }] },
          ],
        },
      ],
    });
  }

  async removeRoute(slug: string) {
    await this.caddy('DELETE', `/id/${this.routeId(slug)}`, undefined, [404, 500]);
  }

  instanceUrl(slug: string) {
    return `http://${containerName(slug)}:4000`;
  }

  /** Runs a command in the container and waits for it; fails unless it exits with 0. */
  private async exec(slug: string, command: string[], what: string, user?: string) {
    const exec = await this.api('POST', `/containers/${containerName(slug)}/exec`, {
      Cmd: command,
      ...(user ? { User: user } : {}),
      AttachStdout: false,
      AttachStderr: false,
    });
    const id = (exec.json as { Id: string }).Id;
    await this.api('POST', `/exec/${id}/start`, { Detach: true });
    for (;;) {
      const state = (await this.api('GET', `/exec/${id}/json`)).json as {
        Running: boolean;
        ExitCode: number | null;
      };
      if (!state.Running) {
        if (state.ExitCode !== 0) throw new Error(`${what} ended with ${state.ExitCode}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  async exportInstance(slug: string, file: string) {
    const name = containerName(slug);
    await this.startInstance(slug);
    await this.exec(
      slug,
      ['node', 'api/dist/maintenance/backup-cli.js', '--out', EXPORT_PATH],
      'The backup',
    );
    // The file comes back as a tar archive with one entry.
    const response = await this.docker.request({
      method: 'GET',
      path: `/v1.43/containers/${name}/archive?path=${encodeURIComponent(EXPORT_PATH)}`,
    });
    if (response.statusCode !== 200) {
      throw new Error(`Docker archive: ${response.statusCode} ${await response.body.text()}`);
    }
    await pipeline(response.body, extractSingleFile(), createWriteStream(file));
  }

  async restoreInstance(slug: string, file: string) {
    const name = containerName(slug);
    const { size } = await stat(file);
    // Files go into a container as a tar archive.
    const upload = await this.docker.request({
      method: 'PUT',
      path: `/v1.43/containers/${name}/archive?path=${encodeURIComponent(RESTORE_DIR)}`,
      headers: { 'content-type': 'application/x-tar' },
      body: Readable.from(packSingleFile(RESTORE_NAME, size, createReadStream(file))),
    });
    const answer = await upload.body.text();
    if (upload.statusCode !== 200) {
      throw new Error(`Docker archive upload: ${upload.statusCode} ${answer.slice(0, 300)}`);
    }
    await this.exec(
      slug,
      ['node', 'api/dist/maintenance/restore-cli.js', '--in', `${RESTORE_DIR}/${RESTORE_NAME}`],
      'The restore',
    );
    // Uploaded archives belong to root; the instance runs as its own user.
    await this.exec(slug, ['rm', '-f', `${RESTORE_DIR}/${RESTORE_NAME}`], 'Cleaning up', '0');
  }
}
