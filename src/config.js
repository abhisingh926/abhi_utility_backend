import 'dotenv/config';

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function required(name) {
  const v = env(name);
  if (v === undefined) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

export const config = {
  env: env('NODE_ENV', 'development'),
  port: Number(env('PORT', 3000)),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000'),

  db: {
    host: env('DB_HOST', 'localhost'),
    port: Number(env('DB_PORT', 3306)),
    user: required('DB_USER'),
    password: env('DB_PASSWORD', ''),
    database: required('DB_NAME'),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    accessTtl: env('JWT_ACCESS_TTL', '15m'),
    refreshDays: Number(env('REFRESH_TOKEN_DAYS', 60)),
  },

  /** First admin account, created on startup if it doesn't exist yet. */
  admin: {
    email: env('ADMIN_EMAIL'),
    password: env('ADMIN_PASSWORD'),
  },

  /** Subscription products (same IDs as in Play Console / App Store Connect). */
  products: {
    monthly: env('PRODUCT_MONTHLY', 'abhi_pro_monthly'),
    yearly: env('PRODUCT_YEARLY', 'abhi_pro_yearly'),
  },

  /** Outgoing email (Hostinger: smtp.hostinger.com, port 465, your mailbox + password). */
  mail: {
    host: env('SMTP_HOST'),
    port: Number(env('SMTP_PORT', 465)),
    user: env('SMTP_USER'),
    password: env('SMTP_PASSWORD'),
    from: env('MAIL_FROM', env('SMTP_USER')),
    appName: env('APP_NAME', 'Abhi Utility'),
  },

  /** Testing only (never in production): password-reset API returns the code. */
  exposeResetCodeForTests: env('EXPOSE_RESET_CODE_FOR_TESTS') === 'true' && env('NODE_ENV') !== 'production',

  backup: {
    /** Folder for backup photos. On Hostinger keep it OUTSIDE the app folder (redeploys replace that). */
    storageDir: env('STORAGE_DIR', './storage'),
    keep: Number(env('BACKUP_KEEP', 10)),
    maxPayloadMb: Number(env('BACKUP_MAX_MB', 10)),
    maxPhotoMb: Number(env('BACKUP_PHOTO_MAX_MB', 15)),
    quotaMb: Number(env('BACKUP_QUOTA_MB', 1024)),
    proOnly: env('BACKUP_PRO_ONLY', 'false') === 'true',
  },

  google: {
    packageName: env('GOOGLE_PACKAGE_NAME', 'com.abhi.abhi_utility'),
    /** Service-account JSON: either the JSON itself or a path to the file. */
    serviceAccount: env('GOOGLE_SERVICE_ACCOUNT_JSON'),
    /** Secret in the Pub/Sub push URL: /webhooks/google?token=... */
    rtdnToken: env('GOOGLE_RTDN_TOKEN'),
  },

  apple: {
    bundleId: env('APPLE_BUNDLE_ID', 'com.abhi.abhiUtility'),
    appAppleId: env('APPLE_APP_ID') ? Number(env('APPLE_APP_ID')) : undefined,
    issuerId: env('APPLE_ISSUER_ID'),
    keyId: env('APPLE_KEY_ID'),
    /** Path to the App Store Connect API key (.p8). */
    privateKeyPath: env('APPLE_PRIVATE_KEY_PATH'),
    environment: env('APPLE_ENVIRONMENT', 'Sandbox'), // Sandbox | Production
    rootCertsDir: env('APPLE_ROOT_CERTS_DIR', './certs/apple'),
  },
};

if (config.env === 'production' && config.jwt.secret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}
