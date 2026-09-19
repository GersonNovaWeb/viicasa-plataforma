import { readFile } from 'node:fs/promises';

export async function openDatabase(config) {
  if(!['pglite','postgres'].includes(config.driver))throw new Error('El adaptador SQL no admite este driver; usar openFirestore');
  if (config.driver === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const client = new PGlite(config.memory ? undefined : config.dataDir);
    await client.waitReady;
    return { query: (sql, args = []) => client.query(sql, args),
      transaction: fn => client.transaction(tx => fn(tx)), close: () => client.close() };
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined });
  return { query: (sql, args = []) => pool.query(sql, args), close: () => pool.end(),
    async transaction(fn) {
      const tx = await pool.connect();
      try { await tx.query('BEGIN'); const result = await fn(tx); await tx.query('COMMIT'); return result; }
      catch (error) { await tx.query('ROLLBACK'); throw error; }
      finally { tx.release(); }
    } };
}
export async function migrate(db) {
  await db.transaction(async tx => {
    // Transaction-scoped lock prevents concurrent application starts from racing migrations.
    await tx.query('SELECT pg_advisory_xact_lock(867421)');
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const [version, filename] of [[1,'001_phase1.sql'],[2,'002_shipping.sql']]) {
      const existing = await tx.query('SELECT version FROM schema_migrations WHERE version=$1',[version]);
      if (existing.rows.length) continue;
      const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
      if (tx.exec) await tx.exec(sql);
      else await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',[version]);
    }
  });
}
export async function one(db, sql, args = []) { return (await db.query(sql, args)).rows[0]; }
