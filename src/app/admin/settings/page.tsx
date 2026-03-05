"use client";

import { useCallback, useEffect, useState } from "react";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import type { BankAccount, MyanmarBank } from "@/types/database";

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_BANKS: MyanmarBank[] = ["KBZ", "AYA", "CB", "UAB", "Yoma", "Other"];

const BANK_STYLES: Record<
  MyanmarBank,
  { bg: string; text: string; dot: string }
> = {
  KBZ:   { bg: "bg-emerald-100", text: "text-emerald-800", dot: "bg-emerald-500" },
  AYA:   { bg: "bg-blue-100",    text: "text-blue-800",    dot: "bg-blue-500"    },
  CB:    { bg: "bg-amber-100",   text: "text-amber-800",   dot: "bg-amber-500"   },
  UAB:   { bg: "bg-purple-100",  text: "text-purple-800",  dot: "bg-purple-500"  },
  Yoma:  { bg: "bg-teal-100",    text: "text-teal-800",    dot: "bg-teal-500"    },
  Other: { bg: "bg-gray-100",    text: "text-gray-600",    dot: "bg-gray-400"    },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function Pulse({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />;
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-6 py-5 border-b border-gray-100">
        <h2 className="text-base font-bold text-gray-900">{title}</h2>
        {subtitle && <p className="text-sm text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

// ── Toggle switch ─────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a3f8a] disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? "bg-[#1a6b3c]" : "bg-gray-200"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

// ── Add Bank Account Modal ────────────────────────────────────────────────────

function AddBankModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (account: BankAccount) => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    bank_name: "KBZ" as MyanmarBank,
    account_number: "",
    account_holder: "",
  });
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/admin/bank-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, is_active: true }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? `${res.status}`);
      }
      const account = (await res.json()) as BankAccount;
      toast.success(`${account.bank_name} account added.`);
      onAdded(account);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add account.");
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-5">Add Bank Account</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Bank
            </label>
            <select
              value={form.bank_name}
              onChange={(e) => setForm((f) => ({ ...f, bank_name: e.target.value as MyanmarBank }))}
              className={`${inputClass} bg-white`}
            >
              {VALID_BANKS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Account Number
            </label>
            <input
              type="text"
              value={form.account_number}
              onChange={(e) => setForm((f) => ({ ...f, account_number: e.target.value }))}
              required
              placeholder="e.g. 1234567890"
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Account Holder Name
            </label>
            <input
              type="text"
              value={form.account_holder}
              onChange={(e) => setForm((f) => ({ ...f, account_holder: e.target.value }))}
              required
              placeholder="e.g. Nihon Moment"
              className={inputClass}
            />
          </div>

          {/* Preview badge */}
          {form.bank_name && (
            <div className="flex items-center gap-2 text-sm">
              <span
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full font-semibold ${BANK_STYLES[form.bank_name].bg} ${BANK_STYLES[form.bank_name].text}`}
              >
                <span className={`w-2 h-2 rounded-full ${BANK_STYLES[form.bank_name].dot}`} />
                {form.bank_name}
              </span>
              <span className="text-gray-400">preview</span>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-4 py-2.5 bg-[#1a3f8a] text-white rounded-xl text-sm font-medium hover:bg-blue-900 disabled:opacity-50 transition-colors"
            >
              {saving ? "Adding…" : "Add Account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Settings Page ─────────────────────────────────────────────────────────────

// Stable client — created once outside the component so it never changes reference
const supabase = createClient();

export default function SettingsPage() {
  const toast = useToast();

  // ── Bank accounts ──────────────────────────────────────────────────────────
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState<BankAccount | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const res = await fetch("/api/admin/bank-accounts");
      if (!res.ok) throw new Error(`${res.status}`);
      setAccounts((await res.json()) as BankAccount[]);
    } catch {
      toast.error("Failed to load bank accounts.");
    } finally {
      setLoadingAccounts(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleToggle(account: BankAccount) {
    setTogglingId(account.id);
    try {
      const res = await fetch(`/api/admin/bank-accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !account.is_active }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const updated = (await res.json()) as BankAccount;
      setAccounts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      toast.success(
        updated.is_active
          ? `${account.bank_name} account activated.`
          : `${account.bank_name} account deactivated.`,
      );
    } catch {
      toast.error("Failed to update account.");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete() {
    if (!deletingAccount) return;
    setDeletingId(deletingAccount.id);
    try {
      const res = await fetch(`/api/admin/bank-accounts/${deletingAccount.id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
      setAccounts((prev) => prev.filter((a) => a.id !== deletingAccount.id));
      toast.success(`${deletingAccount.bank_name} account deleted.`);
    } catch {
      toast.error("Failed to delete account.");
    } finally {
      setDeletingId(null);
      setDeletingAccount(null);
    }
  }

  // ── School profile ─────────────────────────────────────────────────────────
  const [schoolName, setSchoolName] = useState("Nihon Moment");
  const [schoolNameMm, setSchoolNameMm] = useState("နီဟုန်မိုမန့်");
  const [email, setEmail] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);

  const fetchProfile = useCallback(async () => {
    setLoadingProfile(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      setEmail(user.email ?? "");

      // Fetch admin profile → tenant_id
      const { data: profile } = await supabase
        .from("users")
        .select("tenant_id")
        .eq("id", user.id)
        .single() as { data: { tenant_id: string } | null; error: unknown };
      if (!profile) return;
      setTenantId(profile.tenant_id);

      // Fetch tenant name
      const { data: tenant } = await supabase
        .from("tenants")
        .select("name")
        .eq("id", profile.tenant_id)
        .single() as { data: { name: string } | null; error: unknown };
      if (tenant?.name) setSchoolName(tenant.name);
    } catch {
      // non-critical; keep defaults
    } finally {
      setLoadingProfile(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId) return;
    setSavingProfile(true);
    try {
      const { error } = await supabase
        .from("tenants")
        .update({ name: schoolName.trim() } as never)
        .eq("id", tenantId);
      if (error) throw new Error((error as Error).message);
      toast.success("School profile saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save profile.");
    } finally {
      setSavingProfile(false);
    }
  }

  // ── Change password ────────────────────────────────────────────────────────
  const [pwForm, setPwForm] = useState({
    current: "",
    newPw: "",
    confirm: "",
  });
  const [pwError, setPwError] = useState<string | null>(null);
  const [changingPw, setChangingPw] = useState(false);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);

    if (pwForm.newPw.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    if (pwForm.newPw !== pwForm.confirm) {
      setPwError("New password and confirmation do not match.");
      return;
    }
    if (pwForm.newPw === pwForm.current) {
      setPwError("New password must differ from your current password.");
      return;
    }

    setChangingPw(true);
    try {
      // Verify current password by re-signing in
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email,
        password: pwForm.current,
      });
      if (signInErr) {
        setPwError("Current password is incorrect.");
        return;
      }
      // Update to new password
      const { error: updateErr } = await supabase.auth.updateUser({
        password: pwForm.newPw,
      });
      if (updateErr) throw new Error(updateErr.message);

      toast.success("Password updated successfully.");
      setPwForm({ current: "", newPw: "", confirm: "" });
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Failed to update password.");
    } finally {
      setChangingPw(false);
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchAccounts();
    fetchProfile();
  }, [fetchAccounts, fetchProfile]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const inputClass =
    "w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent";

  return (
    <div className="min-h-screen bg-[#f0f4ff] px-6 py-8 lg:px-8 space-y-8">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-sm font-myanmar text-gray-400 mt-0.5">ဆက်တင်များ</p>
      </div>

      {/* ── Section 1: Bank Accounts ─────────────────────────────────── */}
      <SectionCard
        title="Bank Accounts"
        subtitle="Students see active accounts on their payment page."
      >
        {/* Add button */}
        <div className="flex items-center justify-between mb-5">
          <p className="text-sm text-gray-500">
            {!loadingAccounts && (
              <>
                {accounts.filter((a) => a.is_active).length} active ·{" "}
                {accounts.length} total
              </>
            )}
          </p>
          <button
            onClick={() => setShowAddAccount(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-[#1a3f8a] text-white text-sm font-medium rounded-xl hover:bg-blue-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add Bank Account
          </button>
        </div>

        {/* Account list */}
        {loadingAccounts ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="flex items-center gap-4 py-3 border-b border-gray-100">
                <Pulse className="h-7 w-16 rounded-full" />
                <Pulse className="h-4 w-32 flex-1" />
                <Pulse className="h-4 w-24" />
                <Pulse className="h-6 w-11 rounded-full" />
                <Pulse className="h-7 w-7 rounded-lg" />
              </div>
            ))}
          </div>
        ) : accounts.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">
            No bank accounts yet. Add one for students to pay into.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {accounts.map((account) => {
              const style = BANK_STYLES[account.bank_name] ?? BANK_STYLES.Other;
              return (
                <div
                  key={account.id}
                  className="flex items-center gap-4 py-4 first:pt-0 last:pb-0"
                >
                  {/* Bank badge */}
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold shrink-0 ${style.bg} ${style.text}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                    {account.bank_name}
                  </span>

                  {/* Account info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-mono font-semibold text-gray-800 truncate">
                      {account.account_number}
                    </p>
                    <p className="text-xs text-gray-400 truncate">{account.account_holder}</p>
                  </div>

                  {/* Active status label */}
                  <span
                    className={`text-xs font-medium shrink-0 ${account.is_active ? "text-[#1a6b3c]" : "text-gray-400"}`}
                  >
                    {account.is_active ? "Active" : "Inactive"}
                  </span>

                  {/* Toggle */}
                  <Toggle
                    checked={account.is_active}
                    onChange={() => handleToggle(account)}
                    disabled={togglingId === account.id}
                  />

                  {/* Delete */}
                  <button
                    onClick={() => setDeletingAccount(account)}
                    disabled={deletingId === account.id}
                    className="p-1.5 text-gray-300 hover:text-[#c0392b] hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                    aria-label={`Delete ${account.bank_name} account`}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Info note */}
        <div className="mt-5 flex items-start gap-2 rounded-xl bg-[#f0f4ff] px-4 py-3">
          <svg className="w-4 h-4 text-[#1a3f8a] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
          </svg>
          <p className="text-xs text-[#1a3f8a]">
            Students will see <strong>active</strong> accounts when submitting their
            payment proof on the enrollment page.
          </p>
        </div>
      </SectionCard>

      {/* ── Section 2: School Profile ────────────────────────────────── */}
      <SectionCard title="School Profile" subtitle="Update your school name displayed to students.">

        {loadingProfile ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="space-y-1.5">
                <Pulse className="h-4 w-24" />
                <Pulse className="h-10 w-full rounded-xl" />
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* Profile form */}
            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    School Name (English)
                  </label>
                  <input
                    type="text"
                    value={schoolName}
                    onChange={(e) => setSchoolName(e.target.value)}
                    required
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    School Name (Myanmar)
                  </label>
                  <input
                    type="text"
                    value={schoolNameMm}
                    onChange={(e) => setSchoolNameMm(e.target.value)}
                    className={`${inputClass} font-myanmar`}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Admin Email
                </label>
                <input
                  type="email"
                  value={email}
                  readOnly
                  className={`${inputClass} bg-gray-50 text-gray-400 cursor-not-allowed`}
                />
                <p className="mt-1 text-xs text-gray-400">
                  Contact support to change your login email.
                </p>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={savingProfile}
                  className="px-6 py-2.5 bg-[#1a3f8a] text-white text-sm font-medium rounded-xl hover:bg-blue-900 disabled:opacity-50 transition-colors"
                >
                  {savingProfile ? "Saving…" : "Save Profile"}
                </button>
              </div>
            </form>

            {/* Divider */}
            <div className="my-8 border-t border-gray-100" />

            {/* Change password */}
            <div>
              <h3 className="text-sm font-bold text-gray-800 mb-1">Change Password</h3>
              <p className="text-xs text-gray-400 mb-5">
                Use a strong password of at least 8 characters.
              </p>

              <form onSubmit={handleChangePassword} className="space-y-4 max-w-sm">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Current Password
                  </label>
                  <input
                    type="password"
                    value={pwForm.current}
                    onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
                    required
                    autoComplete="current-password"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    New Password
                  </label>
                  <input
                    type="password"
                    value={pwForm.newPw}
                    onChange={(e) => {
                      setPwForm((f) => ({ ...f, newPw: e.target.value }));
                      setPwError(null);
                    }}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Confirm New Password
                  </label>
                  <input
                    type="password"
                    value={pwForm.confirm}
                    onChange={(e) => {
                      setPwForm((f) => ({ ...f, confirm: e.target.value }));
                      setPwError(null);
                    }}
                    required
                    autoComplete="new-password"
                    className={`${inputClass} ${pwForm.confirm && pwForm.confirm !== pwForm.newPw ? "border-red-300 focus:ring-red-400" : ""}`}
                  />
                  {pwForm.confirm && pwForm.confirm !== pwForm.newPw && (
                    <p className="mt-1 text-xs text-[#c0392b]">Passwords do not match.</p>
                  )}
                </div>

                {pwError && (
                  <div className="flex items-start gap-2 rounded-xl bg-red-50 border border-red-100 px-4 py-3">
                    <svg className="w-4 h-4 text-[#c0392b] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                    </svg>
                    <p className="text-xs text-[#c0392b]">{pwError}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={changingPw || !pwForm.current || !pwForm.newPw || !pwForm.confirm}
                  className="px-6 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-700 disabled:opacity-50 transition-colors"
                >
                  {changingPw ? "Updating…" : "Update Password"}
                </button>
              </form>
            </div>
          </>
        )}
      </SectionCard>

      {/* ── Modals ──────────────────────────────────────────────────────── */}
      {showAddAccount && (
        <AddBankModal
          onClose={() => setShowAddAccount(false)}
          onAdded={(account) => {
            setAccounts((prev) => [...prev, account]);
            setShowAddAccount(false);
          }}
        />
      )}

      {deletingAccount && (
        <ConfirmModal
          variant="danger"
          title="Delete Bank Account?"
          message={`This will permanently remove the ${deletingAccount.bank_name} account (${deletingAccount.account_number}). Students will no longer see it on the payment page.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeletingAccount(null)}
        />
      )}
    </div>
  );
}
