import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { maskPhone } from '../../lib/phone.js';

export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string): Promise<void>;
}

/** Development provider: messages are written to the server log instead of being sent. */
class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';

  async send(to: string, body: string): Promise<void> {
    logger.info({ to: maskPhone(to) }, `[sms:console] ${body}`);
  }
}

/** Twilio Programmable Messaging via its REST API (no SDK dependency). */
class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string,
  ) {}

  async send(to: string, body: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: this.from, Body: body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.error({ status: response.status, to: maskPhone(to), text: text.slice(0, 300) }, 'Twilio SMS failed');
      throw new Error(`SMS delivery failed with status ${response.status}`);
    }
  }
}

function createProvider(): SmsProvider {
  if (config.sms.provider === 'twilio') {
    const { accountSid, authToken, fromNumber } = config.sms.twilio;
    return new TwilioSmsProvider(accountSid!, authToken!, fromNumber!);
  }
  return new ConsoleSmsProvider();
}

export const smsProvider: SmsProvider = createProvider();
