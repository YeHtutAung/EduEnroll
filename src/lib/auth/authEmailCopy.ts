import { EMAIL_FOOTER_URL } from "@/lib/email";
import { isAuthEmailType } from "./authEmailLimits";

// ─── Send Email Hook copy ───────────────────────────────────────────────────
//
// Buyer sign-in (signup = new email, magiclink = existing email) is a 6-digit
// code and NOTHING else: no /auth/v1/verify link, no token_hash, no
// redirect_to. A link would let whoever opens the email first (a scanner, a
// forwarded copy) sign in. The footer link to the KuuNyi homepage is the only
// href.
//
// Staff types keep short copy. Recovery and invite link to Supabase's own
// verify endpoint (the Supabase URL, never email_data.site_url, which is the
// app's site URL). Reauthentication shows the code.
//
// email_change (Task 1 finding, verified on the local stack): email_data.token
// goes to the CURRENT address (user.email), email_data.token_new to the NEW
// address (user.new_email). Only that pairing confirms the change.
//
// The new Myanmar strings need native review before release.

export interface AuthHookPayload {
  user: { email?: string | null; new_email?: string | null; [k: string]: unknown };
  email_data: {
    token?: string | null;
    token_hash?: string | null;
    redirect_to?: string | null;
    email_action_type?: string | null;
    site_url?: string | null;
    token_new?: string | null;
    token_hash_new?: string | null;
    [k: string]: unknown;
  };
}

export interface AuthEmailMessage {
  to: string;
  subject: string;
  html: string;
}

const MM = "font-family: 'Noto Sans Myanmar', sans-serif;";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Supabase sends 6 digits; allow up to 10 in case the OTP length is raised. */
function code(v: unknown): string | null {
  const s = str(v);
  return /^\d{6,10}$/.test(s) ? s : null;
}

function layout(content: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #1a1a1a;">
  <div style="max-width: 520px; margin: 0 auto; padding: 32px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
      ${content}
    </div>
    <div style="text-align: center; margin-top: 24px; font-size: 12px; color: #9ca3af;">
      <p>&copy; ${new Date().getFullYear()} Powered by <a href="${esc(EMAIL_FOOTER_URL)}" style="color: #1a3f8a;">KuuNyi</a></p>
    </div>
  </div>
</body>
</html>`;
}

function heading(en: string, mm: string): string {
  return `<div style="text-align: center; margin-bottom: 24px;">
        <h1 style="margin: 0; font-size: 22px; color: #1a1a1a;">${en}</h1>
        <p style="margin: 4px 0 0; color: #6b7280; ${MM}">${mm}</p>
      </div>`;
}

function codeBox(c: string): string {
  return `<div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; text-align: center; margin: 20px 0;">
        <p style="font-family: 'JetBrains Mono', monospace; font-size: 32px; font-weight: 700; color: #1a6b3c; letter-spacing: 6px; margin: 0;">${esc(c)}</p>
      </div>`;
}

function para(en: string, mm: string): string {
  return `<p style="font-size: 14px; color: #374151; margin: 12px 0 0;">${en}</p>
      <p style="font-size: 13px; color: #6b7280; margin: 4px 0 0; ${MM}">${mm}</p>`;
}

const IGNORE = para(
  "If you didn't ask for this, ignore this email. Don't share this code with anyone.",
  "သင်တောင်းဆိုခြင်း မဟုတ်ပါက ဤအီးမေးလ်ကို လျစ်လျူရှုနိုင်ပါသည်။ ဤကုဒ်ကို မည်သူ့ကိုမျှ မမျှဝေပါနှင့်။",
);

const EXPIRES = para("This code expires in 10 minutes.", "ဤကုဒ်သည် ၁၀ မိနစ်အတွင်း သက်တမ်းကုန်ဆုံးပါမည်။");

function buyerCodeEmail(to: string, c: string): AuthEmailMessage {
  return {
    to,
    subject: `KuuNyi sign-in code / KuuNyi ဝင်ရောက်ရန်ကုဒ်: ${c}`,
    html: layout(`
      ${heading("Your KuuNyi sign-in code", "KuuNyi ဝင်ရောက်ရန်ကုဒ်")}
      ${para("Enter this code to sign in to KuuNyi.", "KuuNyi သို့ ဝင်ရောက်ရန် ဤကုဒ်ကို ထည့်ပါ။")}
      ${codeBox(c)}
      ${EXPIRES}
      ${IGNORE}
    `),
  };
}

function codeEmail(to: string, c: string, subject: string, en: string, mm: string, bodyEn: string, bodyMm: string): AuthEmailMessage {
  return {
    to,
    subject: `${subject}: ${c}`,
    html: layout(`
      ${heading(en, mm)}
      ${para(bodyEn, bodyMm)}
      ${codeBox(c)}
      ${EXPIRES}
      ${IGNORE}
    `),
  };
}

function linkEmail(to: string, link: string, subject: string, en: string, mm: string, bodyEn: string, bodyMm: string, button: string): AuthEmailMessage {
  const href = esc(link);
  return {
    to,
    subject,
    html: layout(`
      ${heading(en, mm)}
      ${para(bodyEn, bodyMm)}
      <div style="text-align: center; margin: 28px 0 16px;">
        <a href="${href}" style="display: inline-block; padding: 12px 28px; background: #1a6b3c; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">${button}</a>
      </div>
      ${para(
        "If you didn't ask for this, ignore this email.",
        "သင်တောင်းဆိုခြင်း မဟုတ်ပါက ဤအီးမေးလ်ကို လျစ်လျူရှုနိုင်ပါသည်။",
      )}
    `),
  };
}

function verifyLink(supabaseUrl: string, tokenHash: string, type: "recovery" | "invite", redirectTo: string): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  const redirect = redirectTo ? `&redirect_to=${encodeURIComponent(redirectTo)}` : "";
  return `${base}/auth/v1/verify?token=${encodeURIComponent(tokenHash)}&type=${type}${redirect}`;
}

/**
 * The messages to send for one hook call, or null when the type isn't one we
 * send or the payload lacks what that type needs (the caller answers 400).
 */
export function authEmailMessages(payload: AuthHookPayload, supabaseUrl: string): AuthEmailMessage[] | null {
  const type = payload?.email_data?.email_action_type;
  if (!isAuthEmailType(type)) return null;
  const d = payload.email_data;
  const to = str(payload.user?.email);
  if (!to) return null;

  switch (type) {
    case "signup":
    case "magiclink": {
      const c = code(d.token);
      return c ? [buyerCodeEmail(to, c)] : null;
    }
    case "reauthentication": {
      const c = code(d.token);
      return c
        ? [
            codeEmail(
              to,
              c,
              "KuuNyi confirmation code / KuuNyi အတည်ပြုကုဒ်",
              "Confirm it's you",
              "သင်ဖြစ်ကြောင်း အတည်ပြုပါ",
              "Enter this code to confirm the change to your account.",
              "သင့်အကောင့်ပြောင်းလဲမှုကို အတည်ပြုရန် ဤကုဒ်ကို ထည့်ပါ။",
            ),
          ]
        : null;
    }
    case "recovery":
    case "invite": {
      const hash = str(d.token_hash);
      if (!hash || !supabaseUrl) return null;
      const link = verifyLink(supabaseUrl, hash, type, str(d.redirect_to));
      return type === "recovery"
        ? [
            linkEmail(
              to,
              link,
              "Reset your KuuNyi password / KuuNyi စကားဝှက် ပြန်လည်သတ်မှတ်ရန်",
              "Reset your password",
              "စကားဝှက် ပြန်လည်သတ်မှတ်ရန်",
              "Use the button below to set a new password for your KuuNyi staff account.",
              "သင့် KuuNyi ဝန်ထမ်းအကောင့်အတွက် စကားဝှက်အသစ် သတ်မှတ်ရန် အောက်ပါခလုတ်ကို နှိပ်ပါ။",
              "Reset Password",
            ),
          ]
        : [
            linkEmail(
              to,
              link,
              "You're invited to KuuNyi / KuuNyi သို့ ဖိတ်ခေါ်ထားပါသည်",
              "You're invited to KuuNyi",
              "KuuNyi သို့ ဖိတ်ခေါ်ထားပါသည်",
              "You've been invited to a KuuNyi staff account. Use the button below to accept.",
              "KuuNyi ဝန်ထမ်းအကောင့်သို့ ဖိတ်ခေါ်ထားပါသည်။ လက်ခံရန် အောက်ပါခလုတ်ကို နှိပ်ပါ။",
              "Accept Invitation",
            ),
          ];
    }
    case "email_change": {
      const current = code(d.token);
      const next = code(d.token_new);
      const newTo = str(payload.user?.new_email);
      if (!current || !next || !newTo) return null;
      const subject = "Confirm your email change / အီးမေးလ်ပြောင်းလဲမှု အတည်ပြုရန်";
      return [
        codeEmail(
          to,
          current,
          subject,
          "Confirm your email change",
          "အီးမေးလ်ပြောင်းလဲမှု အတည်ပြုရန်",
          "Someone asked to change the email address on your KuuNyi account away from this address. Enter this code to confirm.",
          "သင့် KuuNyi အကောင့်၏ အီးမေးလ်လိပ်စာကို ဤလိပ်စာမှ ပြောင်းလဲရန် တောင်းဆိုထားပါသည်။ အတည်ပြုရန် ဤကုဒ်ကို ထည့်ပါ။",
        ),
        codeEmail(
          newTo,
          next,
          subject,
          "Confirm your new email",
          "အီးမေးလ်လိပ်စာအသစ် အတည်ပြုရန်",
          "Enter this code to confirm this address as the new email for your KuuNyi account.",
          "ဤလိပ်စာကို သင့် KuuNyi အကောင့်၏ အီးမေးလ်အသစ်အဖြစ် အတည်ပြုရန် ဤကုဒ်ကို ထည့်ပါ။",
        ),
      ];
    }
  }
}
