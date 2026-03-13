import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "store.db");

let instance: Database.Database | null = null;

function getConnection(): Database.Database {
  if (!instance) {
    instance = new Database(DB_PATH);
    instance.pragma("journal_mode = WAL");
    instance.pragma("foreign_keys = ON");
  }
  return instance;
}

export const db = {
  /**
   * Run a SELECT query and return all matching rows.
   */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const conn = getConnection();
    const stmt = conn.prepare(sql);
    return stmt.all(...params) as T[];
  },

  /**
   * Insert a row into the given table.
   */
  async insert(table: string, data: Record<string, unknown>): Promise<void> {
    const conn = getConnection();
    const columns = Object.keys(data).join(", ");
    const placeholders = Object.keys(data).map(() => "?").join(", ");
    const stmt = conn.prepare(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`);
    stmt.run(...Object.values(data));
  },

  /**
   * Update a row by id in the given table.
   */
  async update(table: string, id: string, data: Record<string, unknown>): Promise<void> {
    const conn = getConnection();
    const sets = Object.keys(data).map((key) => `${key} = ?`).join(", ");
    const stmt = conn.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`);
    stmt.run(...Object.values(data), id);
  },

  /**
   * Close the database connection.
   */
  close(): void {
    if (instance) {
      instance.close();
      instance = null;
    }
  },
};
