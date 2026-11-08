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

// Safe by default: only an explicit NODE_ENV=development / test turns off the
// production checks below (a forgotten NODE_ENV on the server must not do that).
const nodeEnv = env('NODE_ENV', 'production');

export const config = {
  env: nodeEnv,
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

  /** Free trial: every new account gets this many days of Pro, one trial per email. 0 = no trial. */
  trial: {
    days: Number(env('TRIAL_DAYS', 30)),
  },

  /**
   * Referral program: a friend registers with your code -> you get `days` more Pro.
   * At most `maxPerYear` rewards per person per 365 days. `friendDays` = extra days
   * for the new user who registers with the code (0 = only the normal free trial). New users can enter a code
   * up to `applyWithinDays` after registering. `appUrl`: where the shared link points.
   */
  referral: {
    days: Number(env('REFERRAL_DAYS', 30)),
    friendDays: Number(env('REFERRAL_FRIEND_DAYS', 10)),
    maxPerYear: Number(env('REFERRAL_MAX_PER_YEAR', 12)),
    applyWithinDays: Number(env('REFERRAL_APPLY_DAYS', 7)),
    appUrl: env('APP_DOWNLOAD_URL', `https://play.google.com/store/apps/details?id=${env('GOOGLE_PACKAGE_NAME', 'com.abhi.abhi_utility')}`),
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
  exposeResetCodeForTests: env('EXPOSE_RESET_CODE_FOR_TESTS') === 'true' && nodeEnv !== 'production',

  backup: {
    /** Folder for backup photos. On Hostinger keep it OUTSIDE the app folder (redeploys replace that). */
    storageDir: env('STORAGE_DIR', './storage'),
    keep: Number(env('BACKUP_KEEP', 10)),
    maxPayloadMb: Number(env('BACKUP_MAX_MB', 10)),
    maxPhotoMb: Number(env('BACKUP_PHOTO_MAX_MB', 15)),
    quotaMb: Number(env('BACKUP_QUOTA_MB', 1024)),
    proOnly: env('BACKUP_PRO_ONLY', 'false') === 'true',
  },

  /** SOS when no contact answers: location + video, shared by a private link. */
  sos: {
    /** Days an SOS link (and its video) is kept. */
    linkDays: Number(env('SOS_LINK_DAYS', 30)),
    videoMaxMb: Number(env('SOS_VIDEO_MAX_MB', 60)),
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

const isLocalHost = (h) => ['localhost', '127.0.0.1', '::1', 'mysql', 'db'].includes(String(h).toLowerCase());

if (config.env === 'production') {
  if (config.jwt.secret.length < 32 || /^(replace|change|local|secret)/i.test(config.jwt.secret)) {
    throw new Error('JWT_SECRET must be a random secret of at least 32 characters in production');
  }
} else if (!isLocalHost(config.db.host)) {
  // A development config talking to a remote (probably the live) database.
  if (config.exposeResetCodeForTests) {
    throw new Error(
      `EXPOSE_RESET_CODE_FOR_TESTS=true with a remote database (${config.db.host}) would let anyone ` +
        'reset any real account: set it to false, or use a local database.',
    );
  }
  console.warn(`⚠️  NODE_ENV=${config.env} but DB_HOST=${config.db.host} is not local. Careful: this may be the live database.`);
}
