import { config } from '../config/env.js';

/**
 * Normalises a phone number to E.164. Numbers without a country code are
 * assumed to belong to the default country (India, +91). Indian mobile
 * numbers must have 10 digits and start with 6-9.
 */
export function normalizePhone(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;

  const defaultCc = config.defaults.countryCode.replace('+', '');

  if (hasPlus) {
    if (digits.startsWith('91')) return validateIndian(digits.slice(2));
    // Generic international number: 7-15 digits in total.
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }

  if (defaultCc === '91') {
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return validateIndian(digits);
  }

  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  const full = `${defaultCc}${digits}`;
  if (full.length < 8 || full.length > 15) return null;
  return `+${full}`;
}

function validateIndian(national: string): string | null {
  if (!/^[6-9]\d{9}$/.test(national)) return null;
  return `+91${national}`;
}

/** Masks a phone number for logs/messages: +91•••••43210 */
export function maskPhone(phone: string): string {
  if (phone.length <= 5) return phone;
  return `${phone.slice(0, 3)}${'•'.repeat(Math.max(0, phone.length - 8))}${phone.slice(-5)}`;
}
