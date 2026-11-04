import { mkdir } from 'node:fs/promises';
import { Cloud } from './cloud.js';
import { loadConfig } from './config.js';
import { createDatabase, migrateDatabase } from './db/client.js';
import { createMailer } from './mail.js';
import { MemoryPayments, StripePayments } from './payments.js';
import { DockerPlatform } from './platform/docker.js';
import { MemoryPlatform } from './platform/memory.js';
import { createServer } from './server.js';

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);
await migrateDatabase(database);
await mkdir(config.EXPORT_DIR, { recursive: true });
await mkdir(config.BACKUP_DIR, { recursive: true });
const platform =
  config.PLATFORM === 'docker'
    ? new DockerPlatform(config)
    : new MemoryPlatform((slug) => `http://localhost:4000/${slug}`);
let log = (text: string) => console.log(text);
const payments = config.STRIPE_SECRET_KEY
  ? new StripePayments(config.STRIPE_SECRET_KEY, config.STRIPE_AUTOMATIC_TAX)
  : new MemoryPayments();
const cloud = new Cloud(
  config,
  database,
  platform,
  createMailer(config, (text) => log(text)),
  payments,
);
const app = await createServer(config, cloud);
log = (text) => app.log.info(text);

// The worker (E-156): JOB_WORKERS loops for jobs, never two of one instance at once, and the
// minute for deadlines, health, backups and rollouts apart from them, so a long backup holds
// up nothing else.
if (config.WORKER) {
  // A job that was running when the service stopped runs again.
  await database.sql`update jobs set status = 'queued' where status = 'running'`;
  const loop = (every: number, work: () => Promise<unknown>, label: string) => {
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await work();
      } catch (error) {
        app.log.error(error, label);
      } finally {
        busy = false;
      }
    }, every);
  };
  for (let worker = 0; worker < config.JOB_WORKERS; worker += 1) {
    loop(3000, () => cloud.runJobs(), 'Jobs');
  }
  loop(60_000, () => cloud.tick(), 'Tick');
}

await app.listen({ host: '0.0.0.0', port: config.PORT });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await database.sql.end({ timeout: 5 });
    process.exit(0);
  });
}
