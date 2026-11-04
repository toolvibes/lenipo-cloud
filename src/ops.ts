import { Cloud } from './cloud.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { createMailer } from './mail.js';
import { runOps } from './operator.js';
import { MemoryPayments, StripePayments } from './payments.js';
import { DockerPlatform } from './platform/docker.js';
import { MemoryPlatform } from './platform/memory.js';

/**
 * The operator's command line (E-156), in the container of the service:
 *   docker compose exec cloud node dist/ops.js status
 * It reads and queues work; the running service does the work.
 */
const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);
const platform =
  config.PLATFORM === 'docker'
    ? new DockerPlatform(config)
    : new MemoryPlatform((slug) => `http://localhost:4000/${slug}`);
const payments = config.STRIPE_SECRET_KEY
  ? new StripePayments(config.STRIPE_SECRET_KEY, config.STRIPE_AUTOMATIC_TAX)
  : new MemoryPayments();
const cloud = new Cloud(
  config,
  database,
  platform,
  createMailer(config, (text) => console.log(text)),
  payments,
);
try {
  console.log(await runOps(cloud.fleet, process.argv.slice(2), cloud.compliance));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await database.sql.end({ timeout: 5 });
}
