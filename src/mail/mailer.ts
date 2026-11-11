import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Abstract so tests can capture emails instead of sending them. */
export abstract class Mailer {
  abstract send(email: Email): Promise<void>;
}

/**
 * Development: writes emails to the server log instead of sending them. The config refuses this
 * in production, because sign-in codes in a log would let anyone with log access take accounts.
 */
@Injectable()
export class LogMailer extends Mailer {
  private readonly logger = new Logger('Mail');

  async send(email: Email): Promise<void> {
    this.logger.log(`To ${email.to}: ${email.subject}\n${email.text}`);
  }
}

/** Sends through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
@Injectable()
export class ResendMailer extends Mailer {
  private readonly logger = new Logger('Mail');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  async send(email: Email): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.email.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.config.email.from, to: [email.to], subject: email.subject, text: email.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // never log the address or the body: it holds the code
      this.logger.error(`Resend answered ${res.status}`);
      throw new Error(`Could not send email (${res.status})`);
    }
  }
}
