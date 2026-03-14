// ─── Enums (mirror SQL enum types) ───────────────────────────────────────────

export type PlanType = "starter" | "pro";

export type UserRole = "superadmin" | "owner" | "staff";

export type IntakeStatus = "draft" | "open" | "closed";

/** Standard JLPT levels. Custom levels (e.g. "VIP", "GA") are also valid strings. */
export type JlptLevel = "N5" | "N4" | "N3" | "N2" | "N1" | (string & {});

export type ClassStatus = "draft" | "open" | "full" | "closed";

export type EnrollmentStatus =
  | "pending_payment"
  | "payment_submitted"
  | "partial_payment"
  | "confirmed"
  | "rejected";

export type PaymentStatus = "pending" | "verified" | "rejected";

/** @deprecated Use plain string instead. Kept for backward compatibility. */
export type MyanmarBank = string;

// ─── RPC return shapes ────────────────────────────────────────────────────────

export type SubmitCartEnrollmentResult =
  | {
      success: true;
      enrollment_ref: string;
      enrollment_id: string;
      tenant_id: string;
      total_fee_mmk: number;
      quantity: number;
      items: Array<{
        class_id: string;
        class_level: string;
        quantity: number;
        fee_mmk: number;
        subtotal_mmk: number;
      }>;
    }
  | {
      success: false;
      error: string;
      class_id?: string;
      class_level?: string;
      seat_remaining?: number;
      max?: number;
      opens_at?: string;
      detail?: string;
    };

export type SubmitEnrollmentResult =
  | {
      success: true;
      enrollment_ref: string;
      enrollment_id: string;
      class_level: JlptLevel;
      fee_mmk: number;
      tenant_id: string;
      seat_remaining: number;
      quantity: number;
    }
  | {
      success: false;
      error: "CLASS_NOT_FOUND" | "CLASS_NOT_OPEN" | "CLASS_FULL" | "NOT_ENOUGH_SEATS" | "EXCEEDS_MAX_TICKETS" | "ENROLLMENT_NOT_OPEN" | "ENROLLMENT_CLOSED" | "INTERNAL_ERROR";
      class_status?: ClassStatus;
      opens_at?: string;
      closed_at?: string;
      detail?: string;
      max?: number;
      seat_remaining?: number;
    };

// ─── Default class fees (MMK) ─────────────────────────────────────────────────

export const DEFAULT_CLASS_FEES: Record<string, number> = {
  N5: 300_000,
  N4: 350_000,
  N3: 400_000,
  N2: 450_000,
  N1: 500_000,
};

// ─── Menu button shape (stored in tenants.menu_buttons JSONB) ────────────────

export interface MenuButton {
  key: string;
  title: string;
  visible: boolean;
}

// ─── Row types ────────────────────────────────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  logo_url: string | null;
  currency: string;             // default 'MMK'
  language: string;             // default 'my+en'
  plan: PlanType;
  org_type: string;             // default 'language_school'
  label_intake: string;         // default 'Intake'
  label_class: string;          // default 'Class Type'
  label_student: string;        // default 'Student'
  label_seat: string;           // default 'Seat'
  label_fee: string;            // default 'Fee'
  messenger_enabled: boolean;
  messenger_page_id: string | null;
  messenger_page_token: string | null;
  messenger_verify_token: string | null;
  messenger_greeting: string | null;
  handoff_timeout_min: number;
  menu_buttons: MenuButton[] | null;
  created_at: string;
}

export interface User {
  id: string;                   // matches auth.users.id
  tenant_id: string;
  email: string;
  role: UserRole;
  full_name: string | null;
  phone: string | null;
  created_at: string;
}

export interface Intake {
  id: string;
  tenant_id: string;
  name: string;                 // e.g. "April 2026 Intake" / "ဧပြီ ၂၀၂၆ စာရင်းသွင်းမှု"
  year: number;
  slug: string;                 // stable URL slug, set once on creation (e.g. "april-2026")
  hero_image_url: string | null; // hero banner for public enrollment page
  status: IntakeStatus;
  created_at: string;
}

export type ClassMode = "online" | "offline";

export interface Class {
  id: string;
  intake_id: string;
  tenant_id: string;
  level: string;
  fee_mmk: number;
  seat_total: number;
  seat_remaining: number;
  enrollment_open_at: string | null;
  enrollment_close_at: string | null;
  status: ClassStatus;
  mode: ClassMode;
  event_date: string | null;
  start_time: string | null;
  end_time: string | null;
  venue: string | null;
  image_url: string | null;
  max_tickets_per_person: number;
  created_at: string;
}

export interface Enrollment {
  id: string;
  enrollment_ref: string;       // e.g. "NM-2026-00042" (auto-generated)
  class_id: string | null;       // null for cart enrollments (uses enrollment_items)
  tenant_id: string;
  student_name_en: string;      // name in English
  student_name_mm: string | null; // name in Myanmar script
  nrc_number: string | null;    // Myanmar National Registration Card
  phone: string;
  email: string | null;
  form_data: Record<string, string> | null;
  quantity: number;
  status: EnrollmentStatus;
  enrolled_at: string;
  messenger_psid: string | null;
}

export interface Payment {
  id: string;
  enrollment_id: string;
  tenant_id: string;
  amount_mmk: number;
  proof_image_url: string | null;
  proof_image_urls: string[];
  bank_reference: string | null;
  admin_note: string | null;
  received_amount_mmk: number | null;
  status: PaymentStatus;
  verified_by: string | null;   // references users.id
  verified_at: string | null;
  created_at: string;
}

export interface EnrollmentItem {
  id: string;
  enrollment_id: string;
  class_id: string;
  tenant_id: string;
  quantity: number;
  fee_mmk: number;
  created_at: string;
}

export interface BankAccount {
  id: string;
  tenant_id: string;
  bank_name: string;
  account_number: string;
  account_holder: string;
  is_active: boolean;
  qr_code_url: string | null;
  created_at: string;
}

export interface StaffInvite {
  id: string;
  tenant_id: string;
  email: string;
  token: string;
  invited_by: string | null;
  accepted_at: string | null;
  expires_at: string;
  created_at: string;
}

// ─── Supabase Database shape ──────────────────────────────────────────────────

export interface Database {
  public: {
    Tables: {
      tenants: {
        Row: Tenant;
        Insert: Omit<Tenant, "id" | "created_at">;
        Update: Partial<Omit<Tenant, "id" | "created_at">>;
      };
      users: {
        Row: User;
        Insert: Omit<User, "created_at">;
        Update: Partial<Omit<User, "id" | "created_at">>;
      };
      intakes: {
        Row: Intake;
        Insert: Omit<Intake, "id" | "created_at">;
        Update: Partial<Omit<Intake, "id" | "created_at">>;
      };
      classes: {
        Row: Class;
        Insert: Omit<Class, "id" | "created_at">;
        Update: Partial<Omit<Class, "id" | "created_at">>;
      };
      enrollments: {
        Row: Enrollment;
        Insert: Omit<Enrollment, "id" | "enrollment_ref" | "enrolled_at">;
        Update: Partial<Omit<Enrollment, "id" | "enrollment_ref" | "enrolled_at">>;
      };
      payments: {
        Row: Payment;
        Insert: Omit<Payment, "id" | "created_at">;
        Update: Partial<Omit<Payment, "id" | "created_at">>;
      };
      bank_accounts: {
        Row: BankAccount;
        Insert: Omit<BankAccount, "id" | "created_at">;
        Update: Partial<Omit<BankAccount, "id" | "created_at">>;
      };
      enrollment_items: {
        Row: EnrollmentItem;
        Insert: Omit<EnrollmentItem, "id" | "created_at">;
        Update: Partial<Omit<EnrollmentItem, "id" | "created_at">>;
      };
      staff_invites: {
        Row: StaffInvite;
        Insert: Omit<StaffInvite, "id" | "token" | "accepted_at" | "expires_at" | "created_at">;
        Update: Partial<Omit<StaffInvite, "id" | "token" | "created_at">>;
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_my_tenant_id: {
        Args: Record<string, never>;
        Returns: string;
      };
      seed_default_classes: {
        Args: { p_intake_id: string; p_tenant_id: string; p_seat_total?: number };
        Returns: void;
      };
      submit_cart_enrollment: {
        Args: { p_items: string; p_tenant_id?: string | null };
        Returns: SubmitCartEnrollmentResult;
      };
      submit_enrollment: {
        Args: {
          p_class_id:         string;
          p_student_name_en:  string;
          p_phone:            string;
          p_student_name_mm?: string | null;
          p_nrc_number?:      string | null;
          p_email?:           string | null;
        };
        Returns: SubmitEnrollmentResult;
      };
    };
    Enums: {
      plan_type: PlanType;
      user_role: UserRole;
      intake_status: IntakeStatus;
      jlpt_level: JlptLevel;
      class_status: ClassStatus;
      enrollment_status: EnrollmentStatus;
      payment_status: PaymentStatus;
      myanmar_bank: MyanmarBank;
    };
  };
}
