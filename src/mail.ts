import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Keeps mails instead of sending them (tests, development). */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];

  async send(mail: Mail) {
    this.sent.push(mail);
  }

  /** The first link in the newest mail to this address. */
  linkTo(address: string): string {
    const mail = this.sent.findLast((entry) => entry.to === address);
    const link = mail?.text.match(/https?:\/\/\S+/)?.[0];
    if (!link) throw new Error(`No link mailed to ${address}`);
    return link;
  }
}

export function createMailer(config: Config, log: (text: string) => void): Mailer {
  if (!config.SMTP_URL) {
    return {
      async send(mail) {
        log(`Mail an ${mail.to} (kein SMTP_URL): ${mail.subject}\n${mail.text}`);
      },
    };
  }
  const transport = nodemailer.createTransport(config.SMTP_URL);
  return {
    async send(mail) {
      await transport.sendMail({ from: config.MAIL_FROM, ...mail });
    },
  };
}
