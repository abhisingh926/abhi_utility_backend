import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { HttpError } from '../http.js';

let transport;

export const mailConfigured = () => !!(config.mail.host && config.mail.user && config.mail.password);

function transporter() {
  transport ??= nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.port === 465, // 465 = SSL, 587 = STARTTLS
    auth: { user: config.mail.user, pass: config.mail.password },
  });
  return transport;
}

/**
 * Sends an email. Without SMTP settings: in development the email is printed
 * to the console; in production it fails with a clear error.
 */
export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) {
    if (config.env !== 'production') {
      console.log(`\n[mail not configured — would send]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
      return;
    }
    throw new HttpError(503, 'Email is not set up on the server yet', 'mail_not_configured');
  }
  try {
    await transporter().sendMail({ from: `"${config.mail.appName}" <${config.mail.from}>`, to, subject, text, html });
  } catch (e) {
    // The SMTP reason goes to the server log (hPanel → Node.js → Logs); the app gets a clear message.
    console.error(
      `[mail] sending to ${to} via ${config.mail.host}:${config.mail.port} failed:`,
      e.code || '',
      e.responseCode || '',
      String(e.response || e.message).slice(0, 300),
    );
    transport = undefined; // reconnect next time (e.g. after the settings were fixed)
    throw new HttpError(
      502,
      e.code === 'EAUTH'
        ? 'The server could not log in to the email account (check SMTP_USER / SMTP_PASSWORD).'
        : 'The email could not be sent. Please try again in a few minutes.',
      'mail_failed',
    );
  }
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function passwordResetEmail({ name, code, minutes }) {
  const app = config.mail.appName;
  const hello = name ? `Hi ${name},` : 'Hi,';
  const text = `${hello}

Your ${app} password reset code is: ${code}

It expires in ${minutes} minutes. Enter it in the app (or at ${config.publicUrl}/reset-password) and choose a new password.

If you didn't ask for this, ignore this email — your password stays the same.`;
  const html = `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1b1d2a">
  <h2 style="margin:0 0 12px">${escape(app)}</h2>
  <p>${escape(hello)}</p>
  <p>Your password reset code is:</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${escape(code)}</p>
  <p>It expires in ${minutes} minutes. Enter it in the app (or at <a href="${escape(config.publicUrl)}/reset-password">${escape(config.publicUrl)}/reset-password</a>) and choose a new password.</p>
  <p style="color:#6b6f85;font-size:13px">If you didn't ask for this, ignore this email — your password stays the same.</p>
</div>`;
  return { subject: `${code} is your ${app} password reset code`, text, html };
}

export function verificationEmail({ name, code, minutes }) {
  const app = config.mail.appName;
  const hello = name ? `Hi ${name},` : 'Hi,';
  const text = `${hello}

Your ${app} email confirmation code is: ${code}

It expires in ${minutes} minutes. Enter it in the app to confirm your email and start your free trial.

If you didn't create an ${app} account, ignore this email.`;
  const html = `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1b1d2a">
  <h2 style="margin:0 0 12px">${escape(app)}</h2>
  <p>${escape(hello)}</p>
  <p>Your email confirmation code is:</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${escape(code)}</p>
  <p>It expires in ${minutes} minutes. Enter it in the app to confirm your email and start your free trial.</p>
  <p style="color:#6b6f85;font-size:13px">If you didn't create an ${escape(app)} account, ignore this email.</p>
</div>`;
  return { subject: `${code} is your ${app} confirmation code`, text, html };
}
