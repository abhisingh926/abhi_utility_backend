import { one, query } from './db.js';
import { seedPlans } from './services/plans.js';

/**
 * Database schema. Every statement is safe to run again, so this runs on every
 * start: no manual SQL needed on Hostinger.
 */
const statements = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid CHAR(36) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    name VARCHAR(100) NULL,
    role ENUM('user','admin') NOT NULL DEFAULT 'user',
    status ENUM('active','disabled') NOT NULL DEFAULT 'active',
    created_by_admin TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_login_at DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    device VARCHAR(120) NULL,
    expires_at DATETIME NOT NULL,
    revoked_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_refresh_user (user_id),
    CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // One row per store subscription (Google purchase token / Apple original
  // transaction) or per Pro grant made by an admin.
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NULL,
    source ENUM('google','apple','admin','trial','referral') NOT NULL,
    product_id VARCHAR(150) NOT NULL,
    store_ref VARCHAR(512) NULL,
    store_ref_hash CHAR(64) NULL UNIQUE,
    status ENUM('active','grace','cancelled','on_hold','paused','pending','expired','revoked') NOT NULL,
    auto_renew TINYINT(1) NOT NULL DEFAULT 0,
    starts_at DATETIME NULL,
    expires_at DATETIME NULL,
    note VARCHAR(255) NULL,
    raw JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_sub_user (user_id),
    CONSTRAINT fk_sub_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Every notification / verification from Google and Apple (for debugging).
  `CREATE TABLE IF NOT EXISTS store_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    source ENUM('google','apple') NOT NULL,
    event_type VARCHAR(80) NULL,
    store_ref_hash CHAR(64) NULL,
    payload JSON NULL,
    processed_ok TINYINT(1) NOT NULL DEFAULT 1,
    error VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_event_ref (store_ref_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Forgot password: 6-digit codes sent by email (stored hashed).
  `CREATE TABLE IF NOT EXISTS password_resets (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    code_hash CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    used_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_reset_user (user_id),
    CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Backup snapshots of the user's diary + tasks. The payload is opaque to the
  // server (the app may encrypt it before upload).
  `CREATE TABLE IF NOT EXISTS backups (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    payload MEDIUMTEXT NOT NULL,
    encrypted TINYINT(1) NOT NULL DEFAULT 0,
    size_bytes INT UNSIGNED NOT NULL,
    photo_hashes JSON NULL,
    meta JSON NULL,
    device VARCHAR(120) NULL,
    app_version VARCHAR(40) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_backup_user (user_id, created_at),
    CONSTRAINT fk_backup_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Photos used by backups, stored once per user per content hash.
  `CREATE TABLE IF NOT EXISTS backup_photos (
    user_id INT UNSIGNED NOT NULL,
    sha256 CHAR(64) NOT NULL,
    size_bytes INT UNSIGNED NOT NULL,
    content_type VARCHAR(100) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, sha256),
    CONSTRAINT fk_photo_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Emails (normalised, hashed) that already used the free trial. Kept when the
  // account is deleted, so deleting and signing up again doesn't give a new trial.
  `CREATE TABLE IF NOT EXISTS trial_claims (
    email_hash CHAR(64) NOT NULL PRIMARY KEY,
    user_id INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Referral program: who invited whom. The email hash (normalised like the trial)
  // stays unique after the account is deleted, so one email is rewarded only once.
  `CREATE TABLE IF NOT EXISTS referrals (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    referrer_id INT UNSIGNED NULL,
    referred_user_id INT UNSIGNED NULL UNIQUE,
    referred_email_hash CHAR(64) NOT NULL UNIQUE,
    status ENUM('rewarded','limit_reached') NOT NULL,
    reward_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_referrer (referrer_id, created_at),
    CONSTRAINT fk_ref_referrer FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_ref_referred FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Subscription plans offered in the app (admin panel → Plans). The store sets the real
  // price; [price] is the admin's copy of it, used for revenue estimates.
  `CREATE TABLE IF NOT EXISTS plans (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    product_id VARCHAR(150) NOT NULL UNIQUE,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(255) NULL,
    badge VARCHAR(40) NULL,
    billing_period ENUM('week','month','quarter','half_year','year') NOT NULL DEFAULT 'month',
    price DECIMAL(12,2) NULL,
    currency CHAR(3) NOT NULL DEFAULT 'INR',
    active TINYINT(1) NOT NULL DEFAULT 1,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS admin_actions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    admin_id INT UNSIGNED NULL,
    target_user_id INT UNSIGNED NULL,
    action VARCHAR(60) NOT NULL,
    details JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_action_target (target_user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export async function migrate() {
  for (const sql of statements) {
    await query(sql);
  }
  await addSubscriptionSources();
  await addReferralCodeColumn();
  await seedPlans();
}

const SOURCES = "ENUM('google','apple','admin','trial','referral')";

/** Older databases: add 'trial' / 'referral' to subscriptions.source. */
async function addSubscriptionSources() {
  const col = await one(
    `SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions' AND COLUMN_NAME = 'source'`,
  );
  if (col && !(String(col.type).includes("'trial'") && String(col.type).includes("'referral'"))) {
    await query(`ALTER TABLE subscriptions MODIFY source ${SOURCES} NOT NULL`);
  }
}

/** users.referral_code (created lazily, unique). */
async function addReferralCodeColumn() {
  const col = await one(
    `SELECT 1 AS ok FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'referral_code'`,
  );
  if (!col) await query('ALTER TABLE users ADD COLUMN referral_code CHAR(8) NULL UNIQUE AFTER role');
}
