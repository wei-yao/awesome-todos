import pg from "pg";
import { isDeepStrictEqual } from "node:util";

export async function createPostgresStore(connectionString, pool = new pg.Pool({
  connectionString,
  max: 3,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
}))
{
  pool.on("error", (error) => console.error("Database connection error:", error.message));
  try
  {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS little_focus_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        revision integer NOT NULL DEFAULT 0,
        data jsonb,
        last_write text
      );
      INSERT INTO little_focus_state (singleton) VALUES (true)
      ON CONFLICT (singleton) DO NOTHING;
    `);
  }
  catch (error)
  {
    await pool.end();
    throw error;
  }
  const read = async () =>
  {
    const result = await pool.query("SELECT revision, data AS state, last_write FROM little_focus_state WHERE singleton = true");
    return result.rows[0];
  };
  return {
    read,
    async write(revision, mutationId, state)
    {
      const result = await pool.query(
        `UPDATE little_focus_state SET data = $1::jsonb, revision = revision + 1, last_write = $2
         WHERE singleton = true AND revision = $3 AND last_write IS DISTINCT FROM $2
         RETURNING revision`,
        [JSON.stringify(state), mutationId, revision]
      );
      if (result.rowCount === 1)
      {
        return { revision: result.rows[0].revision };
      }
      const current = await read();
      return current.last_write === mutationId && isDeepStrictEqual(current.state, state)
        ? { revision: current.revision } : null;
    },
    async health()
    {
      await pool.query("SELECT 1");
    },
    close: () => pool.end()
  };
}
