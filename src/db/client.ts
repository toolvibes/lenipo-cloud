import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return { sql, db };
}

/** Applies the migrations in ../../drizzle (next to src and dist). */
export async function migrateDatabase(database: Database): Promise<void> {
  const folder = fileURLToPath(new URL('../../drizzle', import.meta.url));
  await migrate(database.db, { migrationsFolder: folder });
}
