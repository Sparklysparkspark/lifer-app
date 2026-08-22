import nodemailer from "nodemailer";
import { SMTP_FROM, SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_USER } from "../config.js";

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (!SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

// See config.ts's SMTP_HOST comment — with no SMTP configured, this logs the mail to the
// server console instead of sending it, so password reset still works on a fresh install.
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.log(`[mailer] SMTP not configured — would send to ${to}:\n${subject}\n\n${text}`);
    return;
  }
  await t.sendMail({ from: SMTP_FROM, to, subject, text });
}
