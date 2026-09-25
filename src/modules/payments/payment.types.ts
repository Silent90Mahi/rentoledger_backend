export const PAYMENT_METHODS = ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'deposit', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Methods a person can choose when recording money received (deposit adjustments are system generated). */
export const RECORDABLE_METHODS = ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other'] as const;
export type RecordableMethod = (typeof RECORDABLE_METHODS)[number];

export const PAYMENT_STATUSES = ['pending', 'confirmed', 'rejected', 'void'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  card: 'Card',
  deposit: 'Deposit adjustment',
  other: 'Other',
};
