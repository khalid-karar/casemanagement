import nodemailer from 'nodemailer';
import type { Notification, Person, Repo } from '../api/repo';

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(m: Mail): Promise<void>; readonly name: string }

/** Development: prints instead of sending, so nothing leaves the machine. */
export class ConsoleMailer implements Mailer {
  name = 'console'; sent: Mail[] = [];
  async send(m: Mail) { this.sent.push(m); console.log(JSON.stringify({ event: 'mail_not_sent', to: m.to, subject: m.subject })); }
}
export class SmtpMailer implements Mailer {
  name = 'smtp'; private t;
  constructor(url: string, private from: string) { this.t = nodemailer.createTransport(url); }
  async send(m: Mail) { await this.t.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text }); }
}
/** SMTP_URL=smtps://user:pass@host:465  MAIL_FROM="Cases <no-reply@client.sa>"  Without SMTP_URL nothing is sent. */
export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer {
  return env['SMTP_URL'] ? new SmtpMailer(env['SMTP_URL'], env['MAIL_FROM'] ?? 'no-reply@localhost') : new ConsoleMailer();
}

const WHAT: Record<string, [string, string]> = {
  ASSIGNED: ['A case was assigned to you', 'أُسندت إليك قضية'],
  MENTIONED: ['You were mentioned in a case', 'تمت الإشارة إليك في قضية'],
  STATE_CHANGED: ['A case you handle moved to a new step', 'انتقلت قضية تتولاها إلى خطوة جديدة'],
  SLA_RISK: ['A case is close to its target date', 'قضية يقترب موعدها المستهدف'],
  SLA_BREACH: ['A case has passed its target date', 'قضية تجاوزت موعدها المستهدف'],
  ACTION_DUE: ['A corrective action is due', 'إجراء تصحيحي يستحق قريبًا'],
  REPORT_NEW: ['A new report is waiting in the reports inbox', 'بلاغ جديد في صندوق البلاغات'],
  REPORT_REPLY: ['A reporter has replied to a report', 'ردّ مُبلِّغ على بلاغه'],
  REPORT_STALE: ['A report has been waiting for a response', 'بلاغ ينتظر ردًّا'],
};

/** Bilingual, content-free: the case number and a link. Everything else stays behind sign-in. */
export function composeMail(n: Notification, p: Person, appUrl: string): Mail {
  const [en, ar] = WHAT[n.kind] ?? ['A case needs your attention', 'قضية تحتاج إلى انتباهك'];
  const isReport = n.kind.startsWith('REPORT_');
  const link = `${appUrl.replace(/\/$/, '')}/#/${isReport ? 'reports' : 'cases'}/${encodeURIComponent(n.caseId)}`;
  const [noAr, noEn] = isReport ? ['رقم البلاغ', 'Report'] : ['رقم القضية', 'Case'];
  return {
    to: p.email!, subject: `${ar} · ${en}${isReport ? '' : ` (${n.caseId})`}`,
    text: `${ar}\n${noAr}: ${n.caseId}\n${link}\n\n${en}\n${noEn}: ${n.caseId}\n${link}\n\nلا تتضمن هذه الرسالة تفاصيل القضية؛ سجّل الدخول لعرضها.\nThis message contains no case details; sign in to view them.`,
  };
}

/** Sends pending notification e-mails. People without an address, or who opted out, are skipped (and marked done). A failure is retried next run. */
export async function sendPendingMail(repo: Repo, mailer: Mailer, appUrl: string, at: string, limit = 50) {
  let sent = 0, failed = 0;
  for (const t of await repo.listTenants()) {
    const batch = await repo.pendingEmails(t, limit);
    const done: string[] = [];
    for (const { n, person } of batch) {
      if (!person.email || person.emailOptout) { done.push(n.id); continue; }
      try { await mailer.send(composeMail(n, person, appUrl)); done.push(n.id); sent++; }
      catch (e) {
        failed++; console.error(JSON.stringify({ event: 'mail_failed', error: (e as Error).message }));
        if (Date.parse(at) - Date.parse(n.createdAt) > 24 * 3600_000) done.push(n.id); // give up after a day
      }
    }
    if (done.length) await repo.markEmailed(t, done, at);
  }
  return { sent, failed };
}
