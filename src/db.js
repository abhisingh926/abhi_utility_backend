import mysql from 'mysql2/promise';
import { config } from './config.js';

/** Connection pool. All times are stored and read as UTC. */
export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 8,
  timezone: 'Z',
  charset: 'utf8mb4',
});

pool.pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

/** Runs a query and returns the rows (or the result for INSERT/UPDATE). */
export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}
