// src/mocks/fixtures/enrollment.ts

export interface BankAccount {
  bank_name: string;
  account_number: string;
  account_holder: string;
  qr_code_url: string | null;
}

const BASE = {
  status: "pending_payment",
  student_name_en: "E2E Test User",
  email: "e2e@test.com",
  total_amount: 5000,
  items: [{ level: "N3", quantity: 1, fee_amount: 5000 }],
  event_name: "E2E Test Event",
  intake_id: "intake-e2e-001",
  logo_url: null,
  brand_color: null,
  mmqr_provider: null,
  bank_accounts: [] as BankAccount[],
  payment_method: null,
  card_brand: null,
  card_last4: null,
};

const AYA_BANK: BankAccount = {
  bank_name: "AYA Bank",
  account_number: "123456789",
  account_holder: "Nihon Moment Co.",
  qr_code_url: null,
};

export const BANK_TRANSFER_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-BANK-001",
  payment_mode: "bank_transfer",
  bank_accounts: [AYA_BANK],
};

export const MMQR_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-MMQR-001",
  payment_mode: "mmqr",
  mmqr_provider: "abank",
};

export const PAYPAY_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-PAYPAY-001",
  payment_mode: "paypay",
};

export const STRIPE_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-STRIPE-001",
  payment_mode: "stripe",
  stripe_client_secret: "pi_test_e2e_secret_xyz",
};

export const SUBMITTED_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-SUBMITTED-001",
  status: "payment_submitted",
  payment_mode: "bank_transfer",
  payment_method: "bank_transfer",
  bank_accounts: [AYA_BANK],
};

export const VERIFIED_ENROLLMENT = {
  ...BASE,
  enrollment_ref: "E2E-VERIFIED-001",
  status: "pending_payment",
  payment_mode: "stripe",
  payment_method: "stripe",
  card_brand: "visa",
  card_last4: "4242",
};

export const FORM_FIELDS = [
  {
    id: "f1",
    field_key: "name_en",
    field_label: "Full Name",
    field_type: "text",
    is_required: true,
    options: null,
    sort_order: 1,
    is_default: true,
  },
  {
    id: "f2",
    field_key: "email",
    field_label: "Email",
    field_type: "email",
    is_required: true,
    options: null,
    sort_order: 2,
    is_default: true,
  },
];
