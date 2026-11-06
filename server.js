import { createApp } from './src/app.js';
import { config } from './src/config.js';
import { query } from './src/db.js';
import { migrate } from './src/migrate.js';
import { createUser, findByEmail } from './src/services/users.js';

/** Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD if it doesn't exist yet. */
async function ensureAdmin() {
  const { email, password } = config.admin;
  if (!email || !password) return;
  const existing = await findByEmail(email.trim().toLowerCase());
  if (existing) {
    if (existing.role !== 'admin') {
      await query("UPDATE users SET role = 'admin' WHERE id = ?", [existing.id]);
      console.log(`Made ${email} an admin`);
    }
    return;
  }
  if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters');
  await createUser({ email: email.trim().toLowerCase(), password, name: 'Admin', role: 'admin', createdByAdmin: true });
  console.log(`Created admin account ${email}`);
}

async function main() {
  await migrate();
  await ensureAdmin();
  createApp().listen(config.port, () => {
    console.log(`Abhi Utility backend running on port ${config.port} (${config.env})`);
  });
}

main().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});
