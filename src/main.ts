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

// The worker: jobs every few seconds, deadlines and reminders every minute.
if (config.WORKER) {
  let busy = false;
  let lastTick = 0;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await cloud.runJobs();
      if (Date.now() - lastTick > 60_000) {
        lastTick = Date.now();
        await cloud.tick();
      }
    } catch (error) {
      app.log.error(error, 'Worker');
    } finally {
      busy = false;
    }
  }, 3000);
}

await app.listen({ host: '0.0.0.0', port: config.PORT });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await database.sql.end({ timeout: 5 });
    process.exit(0);
  });
}
