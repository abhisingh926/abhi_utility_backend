# Abhi Utility – Backend

Node.js + MySQL backend for the Abhi Utility app:

- **Accounts** – email + password sign-up/login, refresh-token sessions, change password, **forgot password (6-digit code by email)**, delete account.
- **Cloud backup** – the app backs up the diary + tasks (and diary photos) and restores them on any phone; last 10 backups kept per user.
- **Free trial** – registering gives a **1-month (30-day) free trial** of Pro, once per email (Gmail dot/+ aliases count as one, and deleting the account doesn't reset it). Older accounts get theirs on next login/app start. `TRIAL_DAYS` changes the length (0 = off).
- **Referral program** – every user has a code; when a new person registers with it (or enters it within 7 days), the referrer gets **+1 month of Pro** and the new user **+10 days** on top of the free trial, added after the Pro time they already have. One reward per email ever (same alias rules as the trial), no self-referral, max 12 rewards per person per year (`REFERRAL_*` settings).
- **Subscriptions** – verifies Google Play (and later App Store) purchases with Google/Apple, keeps them up to date through store notifications, and tells the app whether the user is **Pro**.
- **Admin panel** (`/admin`) – stats, search users, create accounts, give/remove Pro, reset passwords, disable/delete users, see / remove profile photos, history of admin actions.
- **Plans** (`/admin` → *Plans*) – create and edit the subscription plans the app shows: name, Play product ID, billing period, amount, currency, label (e.g. "Best value"), description, order, shown/hidden. Shows paying subscribers and estimated revenue per plan, and a history of plan changes. The two default plans (`PRODUCT_MONTHLY` / `PRODUCT_YEARLY`) are created on first start without an amount: fill it in.
  - The amount **charged** is set in Play Console (and App Store Connect); the app shows the store's price on the buy button. The amount in the admin panel is used for the revenue figures, so keep it the same as in the store. A plan's product ID can't be changed once created; plans someone bought can be hidden but not deleted.
- **Web pages** – `/delete-account` (required by Google Play and the App Store) and `/reset-password`.

Tables are created automatically on start; the first admin comes from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

```
App ──buys with──▶ Google Play Billing / Apple StoreKit
 └─ sends purchase token ──▶ this backend ──verifies──▶ Google / Apple
                              ├─ MySQL (users, subscriptions, events)
                              ├─ /webhooks/google, /webhooks/apple (renewals, cancels, refunds)
                              └─ /admin (manage users)
```

## Run locally

Needs Node.js 20+ and MySQL 8 (or MariaDB 10.5+).

```bash
cp .env.example .env        # then edit DB_*, JWT_SECRET, ADMIN_*
npm install
npm start                   # http://localhost:3000, admin panel: /admin
npm test                    # unit tests (store status mapping)
npm run smoke               # end-to-end API check against the running server
```

Quick MySQL with Docker: `docker run -d --name abhi-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=abhi -e MYSQL_USER=abhi -e MYSQL_PASSWORD=abhipw -p 3307:3306 mysql:8.0` (then `DB_PORT=3307`).

## API (all JSON)

Errors look like `{ "error": { "code": "invalid_credentials", "message": "Wrong email or password" } }`.
Authenticated calls send `Authorization: Bearer <accessToken>`. Access tokens last 15 minutes; get a new pair with `/auth/refresh`.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/health` | | uptime check |
| POST | `/api/v1/auth/register` | `email, password, name?, referralCode?` | → `accessToken, refreshToken, user, entitlement, trialStarted, referral` (starts the free trial; a wrong code → 400 `invalid_referral_code`) |
| POST | `/api/v1/auth/login` | `email, password` | same as register |
| POST | `/api/v1/auth/refresh` | `refreshToken` | → new `accessToken, refreshToken` (old one stops working) |
| POST | `/api/v1/auth/logout` | `refreshToken` | |
| POST | `/api/v1/auth/change-password` | `currentPassword, newPassword` | logs out other devices |
| POST | `/api/v1/auth/forgot-password` | `email` | emails a 6-digit code (valid 15 min); same answer whether the email exists or not |
| POST | `/api/v1/auth/reset-password` | `email, code, newPassword` | → logged-in session; other devices logged out; 5 wrong codes = code dead |
| GET | `/api/v1/me` | | `user` + `entitlement { isPro, isTrial, source, productId, status, expiresAt, autoRenew, trial { used, startedAt, endsAt } }` |
| PATCH | `/api/v1/me` | `name` | |
| PUT | `/api/v1/me/avatar` | raw image bytes (JPEG, PNG or WebP, max 2 MB) | profile photo → `user` (`avatarVersion` changes with every new photo; null = no photo) |
| GET · DELETE | `/api/v1/me/avatar` | | the photo (404 = none) · remove it. Stored in `STORAGE_DIR/avatars/`, deleted with the account |
| DELETE | `/api/v1/me` | `password` | deletes the account |
| GET | `/api/v1/me/subscriptions` | | purchase history |
| GET | `/api/v1/me/referral` | | `code, link, rewardDays, invited, rewarded, daysEarned, friends[], referredBy, canApplyCode` |
| POST | `/api/v1/me/referral/apply` | `code` | enter a friend's code after registering (first 7 days) |
| GET | `/api/v1/plans` | | `trialDays` + `products[]` (`id` = store product ID, `name, description, badge, period, price, currency`), shown plans only, in display order |
| POST | `/api/v1/purchases/google` | `purchaseToken` | after a Play purchase / restore → `entitlement` |
| POST | `/api/v1/purchases/apple` | `signedTransaction` or `transactionId` | after an App Store purchase / restore |
| GET | `/api/v1/backups` | | list of backups (no data) + storage used |
| POST | `/api/v1/backups/photos/check` | `hashes` | → `missing` photo hashes to upload |
| PUT | `/api/v1/backups/photos/:sha256` | raw photo bytes | upload one photo (checked against its hash) |
| POST | `/api/v1/backups` | `payload, encrypted?, photoHashes?, meta?, device?, appVersion?` | save a snapshot (diary + tasks JSON, or encrypted text) |
| GET | `/api/v1/backups/latest` · `/api/v1/backups/:id` | | snapshot with `payload` (restore) |
| GET | `/api/v1/backups/photos/:sha256` | | download a photo (restore) |
| DELETE | `/api/v1/backups/:id` · `/api/v1/backups` | | delete one / all backups |
| POST | `/webhooks/google?token=…` | Pub/Sub push | Google Play real-time notifications |
| POST | `/webhooks/apple` | `signedPayload` | App Store Server Notifications V2 |
| GET | `/api/v1/admin/plans` | | every plan + `subscribers { active, renewing, ever }`, `revenuePerMonth`; `totals` per currency (admins only) |
| POST | `/api/v1/admin/plans` | `productId, name, period, price?, currency?, description?, badge?, active?, sortOrder?` | `period`: week, month, quarter, half_year, year |
| PATCH · DELETE | `/api/v1/admin/plans/:id` | any field except `productId` | delete only works for plans nobody bought |
| * | `/api/v1/admin/...` | | admin panel API (admins only) |

**Backups are opaque to the server:** it never reads `payload` or photos, so the app can encrypt them on the phone first (`encrypted: true`) – then not even an admin can read a user's diary. The admin panel shows only backup sizes.

**In the app:** when buying, pass the user's `user.accountToken` as Google Play's `obfuscatedAccountId` (and Apple's `appAccountToken`). Then renewals/cancellations from store webhooks are matched to the right account even if the app is never opened again.

## Deploy on Hostinger (Business Web Hosting)

Menu names in hPanel change from time to time; look for the closest match.

1. **Create the database** – hPanel → *Databases → MySQL Databases*: create a database and user (Hostinger prefixes them, e.g. `u123456789_abhi`). Note the name, user, password; host is usually `localhost`.
2. **Upload the code** – zip this folder **without** `node_modules`, `.env` and `server.log` (or push it to a private GitHub repo).
3. **Create the Node.js app** – hPanel → *Websites* → your site (`palegreen-whale-996077.hostingersite.com`) → *Node.js* / *Deploy Node.js app*:
   - Upload the zip (or connect the GitHub repo).
   - Node.js version: **20** or **22** (18 is not enough).
   - Entry file: `server.js` · install/build command: `npm install` · start command: `npm start`.
4. **Environment variables** – add every variable from `.env.example` with your real values (don't add `PORT`; Hostinger sets it). Important:
   - `JWT_SECRET`: a long random string – `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD`: your admin login (change the password after the first login).
   - **Email** for forgot-password codes: hPanel → *Emails* → create a mailbox like `no-reply@<your domain>`, then set `SMTP_HOST=smtp.hostinger.com`, `SMTP_PORT=465`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`.
   - **`STORAGE_DIR`** for backup photos: a folder **outside** the app folder (e.g. `/home/u123456789/abhi_storage`) – redeploying replaces the app folder and would delete the photos. Hostinger's File Manager shows your home path.
5. **Deploy / start**, then open:
   - `https://palegreen-whale-996077.hostingersite.com/api/health` → `{"ok":true,...}`
   - `https://palegreen-whale-996077.hostingersite.com/admin` → log in with the admin account.
6. **HTTPS** must be on (Hostinger's free SSL) – the app and Google/Apple webhooks need it.

## CI/CD (auto-deploy on push to `main`)

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs on every push and pull request to `main`:

1. **Test** – `npm ci`, syntax check of every `.js` file, `npm test`, and a check that the app starts.
2. **Release** (pushes to `main` only, tests green) – moves the `production` branch to that commit.
3. **Hostinger** is connected to `production` and redeploys by itself (`npm install` + restart).
4. **Health** – waits for `https://<site>/api/health` to answer `{"ok":true}`; the run fails if it doesn't.

So broken code never reaches the live site: if tests fail, `production` isn't moved.

**One-time setup**

1. Push this workflow to `main` once. The first run creates the `production` branch.
2. hPanel → *Websites* → your Node.js app → *Deployments / Git* → connect GitHub repo `abhi_utility_backend`, **branch `production`** (not `main`). Entry `server.js`, start `npm start`, Node 20 or 22. Auto-deploy is on by default for Git deploys.
   - If the app was first created from a zip, create it again with *Import Git repository* and copy the environment variables over.
3. GitHub → *Settings → Actions → General → Workflow permissions* → **Read and write** (the release job pushes `production`).
4. Optional:
   - *Settings → Environments → production* → add yourself as a required reviewer to approve each deploy by hand.
   - *Settings → Secrets and variables → Actions → Variables* → `PUBLIC_URL` if the site address changes.
   - *Settings → Branches* → protect `main` and require the **Test** check before merging PRs.

Re-deploy without a code change: *Actions → CI / Deploy → Run workflow*. Roll back: run the workflow from an older commit, or `git push origin <old-sha>:production --force`.

## Google Play setup (for real Android purchases)

1. **Play Console** – create the app, upload a build (`.aab`) to *Internal testing*, then *Monetize → Subscriptions*: create `abhi_pro_monthly` and `abhi_pro_yearly` (or change `PRODUCT_*`), each with a base plan and price. **Don't add a Play free-trial offer** – the trial comes from registering (`TRIAL_DAYS`), otherwise users would get two.
2. **Service account** – Google Cloud Console (any project): enable **Google Play Android Developer API** → *IAM → Service accounts* → create one → *Keys → Add key → JSON*.
3. **Give it access** – Play Console → *Users and permissions* → invite the service account's email → app permissions: *View financial data* and *Manage orders and subscriptions*.
4. **Put the key on the server** – upload the JSON to `secrets/google-service-account.json` (keep it out of Git) or paste the whole JSON into `GOOGLE_SERVICE_ACCOUNT_JSON`.
5. **Real-time notifications** – Google Cloud → *Pub/Sub*: create a topic; on the topic add `google-play-developer-notifications@system.gserviceaccount.com` as **Pub/Sub Publisher**; create a **push** subscription to
   `https://palegreen-whale-996077.hostingersite.com/webhooks/google?token=<GOOGLE_RTDN_TOKEN>`.
   Play Console → *Monetize → Monetization setup* → enter the topic name → **Send test notification** (shows up as a `TEST` row in `store_events`).

## App Store setup (later, for the iPhone version)

App Store Connect → *Users and Access → Integrations → In-App Purchase* key (`.p8`) → set `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_PATH`, `APPLE_BUNDLE_ID`, `APPLE_APP_ID`; App Store Server Notifications V2 URL: `https://<your-site>/webhooks/apple`. Apple's root certificates are in `certs/apple/`.

## Security notes

- Passwords: bcrypt. Refresh tokens: random, stored hashed, rotated on every use; re-using an old one logs that user out everywhere.
- Login/sign-up are rate-limited (30 per 15 min per IP). Disabled users are rejected immediately.
- Admins can't disable, demote or delete themselves. Every admin change is logged (`admin_actions`).
- Never commit `.env`, `secrets/` or `*.p8`.
