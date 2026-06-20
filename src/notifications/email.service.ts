import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface EmailTemplate {
  subject: string;
  html: (data: Record<string, unknown>) => string;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  unsubscribeUrl?: string;
}

/**
 * Transports emails via SMTP (nodemailer).
 * Falls back to console logging in development when no SMTP creds are set.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private readonly fromAddress: string;
  private readonly appBaseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.fromAddress = config.get<string>(
      'EMAIL_FROM',
      'noreply@orbitchain.io',
    );
    this.appBaseUrl = config.get<string>(
      'APP_BASE_URL',
      'http://localhost:3000',
    );
  }

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    const smtpHost = this.config.get<string>('SMTP_HOST');
    const smtpPort = this.config.get<number>('SMTP_PORT', 587);
    const smtpUser = this.config.get<string>('SMTP_USER');
    const smtpPass = this.config.get<string>('SMTP_PASS');

    if (smtpHost && smtpUser && smtpPass) {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPass },
      });
      this.logger.log('SMTP transporter configured');
    } else {
      // Fallback: JSON transport for development
      this.logger.warn(
        'No SMTP credentials found - using console logger as fallback. Set SMTP_HOST, SMTP_USER, SMTP_PASS to send real emails.',
      );
      this.transporter = nodemailer.createTransport({ jsonTransport: true });
    }

    return this.transporter;
  }

  /**
   * Appends an unsubscribe link and notification preferences footer to every email.
   */
  private wrapWithFooter(html: string, email: string): string {
    const unsubscribeUrl = `${this.appBaseUrl}/users/me/notification-preferences?email=${encodeURIComponent(email)}`;
    return `${html}
<hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
<p style="font-size:12px;color:#888">
  You received this email because you have notifications enabled on OrbitChain.
  <br />
  <a href="${unsubscribeUrl}" style="color:#666">Unsubscribe</a> from these emails or manage your
  <a href="${this.appBaseUrl}/users/me/notification-preferences" style="color:#666">notification preferences</a>.
</p>`;
  }

  /**
   * Send an email. In development mode without SMTP, logs the email to console.
   */
  async send(options: SendEmailOptions): Promise<void> {
    const transporter = this.getTransporter();
    const html = options.unsubscribeUrl
      ? options.html
      : this.wrapWithFooter(options.html, options.to);

    const mailOptions = {
      from: this.fromAddress,
      to: options.to,
      subject: options.subject,
      html,
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      this.logger.log(
        `Email sent to ${options.to}: ${options.subject} (id=${info.messageId})`,
      );

      // In dev mode with jsonTransport, log the message content
      if (info.messageId && info.message) {
        this.logger.debug(`Email body preview: ${info.message}`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to send email to ${options.to}: ${(error as Error).message}`,
      );
      throw error;
    }
  }
}
