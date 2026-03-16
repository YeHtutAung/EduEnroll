"use client";

import { useState, useEffect, useCallback } from "react";
import { createBrowserClient } from "@supabase/ssr";

// ── Video Modal ──────────────────────────────────────────────────────────────

function VideoModal({ videoId, onClose }: { videoId: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 text-white/80 hover:text-white text-sm font-medium transition-colors"
        >
          Close
        </button>
        <div className="relative w-full pt-[56.25%] rounded-xl overflow-hidden bg-black shadow-2xl">
          <iframe
            className="absolute inset-0 w-full h-full"
            src={`https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`}
            title="Video Tutorial"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      </div>
    </div>
  );
}

// ── Org Labels type ──────────────────────────────────────────────────────────

interface OrgLabels {
  intake: string;
  class: string;
  student: string;
  seat: string;
  fee: string;
}

const DEFAULT_LABELS: OrgLabels = {
  intake: "Intake",
  class: "Class Type",
  student: "Student",
  seat: "Seat",
  fee: "Fee",
};

// ── Guide Topics (dynamic) ──────────────────────────────────────────────────

interface GuideTopic {
  id: string;
  title: string;
  icon: string;
  videoId: string | null;
  content: React.ReactNode;
}

function buildGuideTopics(L: OrgLabels): GuideTopic[] {
  const intakeLower = L.intake.toLowerCase();
  const classLower = L.class.toLowerCase();
  const studentLower = L.student.toLowerCase();

  return [
    {
      id: "create-intake",
      title: `Create ${L.intake === "Intake" ? "an" : "a"} ${L.intake}`,
      icon: "🎪",
      videoId: "ef2oEm0SMtg",
      content: (
        <div className="space-y-4">
          <p className="text-gray-600">
            {L.intake === "Event"
              ? "Events are the top-level container for your tickets and registrations."
              : `${L.intake}s are the top-level container for your ${classLower}s and registrations.`}{" "}
            Each {intakeLower} has its own public registration page.
          </p>
          <ol className="space-y-3 text-sm text-gray-700">
            <StepItem n={1} title={`Go to ${L.intake}s & ${L.class}s`}>
              Click the &quot;{L.intake}s & {L.class}s&quot; link in the left sidebar.
            </StepItem>
            <StepItem n={2} title={`Click "+ New ${L.intake}"`}>
              You&apos;ll find this button at the top-right of the {intakeLower}s list page.
            </StepItem>
            <StepItem n={3} title="Pick a month and year">
              Select the month and year for your {intakeLower}. A name will be auto-generated (e.g.
              &quot;March 2026 {L.intake}&quot;), but you can edit it to any custom name.
            </StepItem>
            <StepItem n={4} title={`Click "Create ${L.intake}"`}>
              You&apos;ll be taken to the {intakeLower} detail page where you can add {classLower}s.
            </StepItem>
          </ol>
          <TipBox color="blue">
            <strong>Tip:</strong> After creating the {intakeLower}, its status will be &quot;draft&quot;.
            You need to set it to &quot;open&quot; before {studentLower}s can register.
          </TipBox>
        </div>
      ),
    },
    {
      id: "create-classes",
      title: `Create ${L.class}s`,
      icon: "🎫",
      videoId: "EBRZLMqCeSE",
      content: (
        <div className="space-y-4">
          <p className="text-gray-600">
            {L.class}s define the different options {studentLower}s can choose when registering for your{" "}
            {intakeLower} (e.g. different levels, tiers, or categories).
          </p>
          <ol className="space-y-3 text-sm text-gray-700">
            <StepItem n={1} title={`Open your ${intakeLower}`}>
              From the {intakeLower}s list, click on the {intakeLower} you want to add {classLower}s to.
            </StepItem>
            <StepItem n={2} title={`Click "+ Add ${L.class}"`}>
              In the {classLower}s section, click the add button to create a new {classLower}.
            </StepItem>
            <StepItem n={3} title={`Set ${classLower} details`}>
              Enter the {classLower} name, price (in MMK), and number of available {L.seat.toLowerCase()}s.
            </StepItem>
            <StepItem n={4} title={`Save the ${classLower}`}>
              Click &quot;Add&quot; to save. The {classLower} will appear in the list. You can add
              multiple {classLower}s to the same {intakeLower}.
            </StepItem>
          </ol>
          <TipBox color="amber">
            <strong>Note:</strong> {L.seat}s are tracked automatically. When all {L.seat.toLowerCase()}s
            are taken, the {classLower} status changes to &quot;full&quot;.
          </TipBox>
        </div>
      ),
    },
    {
      id: "setup-classes",
      title: `Setup ${L.class} Details`,
      icon: "⚙️",
      videoId: "MPuCyj-yQXc",
      content: (
        <div className="space-y-4">
          <p className="text-gray-600">
            After creating {classLower}s, you can fine-tune their settings — adjust pricing,{" "}
            {L.seat.toLowerCase()} counts, dates, and status.
          </p>
          <h3 className="text-sm font-semibold text-gray-900">Editing a {L.class}</h3>
          <ul className="space-y-2 text-sm text-gray-700">
            <BulletItem>
              <strong>Price:</strong> Click on the {L.fee.toLowerCase()} amount to edit it. Enter the new
              price in MMK.
            </BulletItem>
            <BulletItem>
              <strong>{L.seat}s:</strong> Click the {L.seat.toLowerCase()} count to change availability.
              Remaining {L.seat.toLowerCase()}s update automatically based on registrations.
            </BulletItem>
            <BulletItem>
              <strong>Dates:</strong> Set start/end dates to control when the {classLower} is available for
              registration.
            </BulletItem>
            <BulletItem>
              <strong>Status:</strong> Toggle between &quot;open&quot;, &quot;closed&quot;, or
              &quot;full&quot; to control registration availability.
            </BulletItem>
          </ul>
          <h3 className="text-sm font-semibold text-gray-900 pt-2">Multi-Quantity Support</h3>
          <p className="text-sm text-gray-600">
            {L.student}s can register for multiple {L.seat.toLowerCase()}s at once. The quantity selector
            appears on the public registration page, allowing them to register for multiple{" "}
            {L.seat.toLowerCase()}s in a single submission.
          </p>
        </div>
      ),
    },
    {
      id: "manage-forms",
      title: "Manage Registration Forms",
      icon: "📝",
      videoId: "mBWIFXAUg3o",
      content: (
        <div className="space-y-4">
          <p className="text-gray-600">
            Each {intakeLower} has a customizable registration form. You can add, remove, and reorder
            fields to collect the information you need from {studentLower}s.
          </p>
          <h3 className="text-sm font-semibold text-gray-900">Accessing the Form Builder</h3>
          <ol className="space-y-3 text-sm text-gray-700">
            <StepItem n={1} title={`Open your ${intakeLower}`}>
              Navigate to the {intakeLower} detail page.
            </StepItem>
            <StepItem n={2} title='Click "Edit Form"'>
              You&apos;ll find this link in the {intakeLower} detail page. It opens the form builder.
            </StepItem>
          </ol>
          <h3 className="text-sm font-semibold text-gray-900 pt-2">Adding Fields</h3>
          <ul className="space-y-2 text-sm text-gray-700">
            <BulletItem>
              Click &quot;+ Add Field&quot; to add a new form field.
            </BulletItem>
            <BulletItem>
              Choose the field type: <strong>Text</strong>, <strong>Select</strong> (dropdown),{" "}
              <strong>Radio</strong>, <strong>Date</strong>, <strong>Phone</strong>,{" "}
              <strong>File</strong> upload, or <strong>Checkbox</strong>.
            </BulletItem>
            <BulletItem>
              For Select and Radio fields, add the options that {studentLower}s can choose from.
            </BulletItem>
            <BulletItem>
              Toggle &quot;Required&quot; to make a field mandatory.
            </BulletItem>
          </ul>
          <h3 className="text-sm font-semibold text-gray-900 pt-2">Reordering & Removing</h3>
          <ul className="space-y-2 text-sm text-gray-700">
            <BulletItem>
              <strong>Drag & drop</strong> fields to reorder them. The order you set is the order{" "}
              {studentLower}s see on the registration page.
            </BulletItem>
            <BulletItem>
              Click the <strong>delete</strong> icon to remove a custom field. Default fields (Name, Phone)
              cannot be removed.
            </BulletItem>
          </ul>
          <TipBox color="blue">
            <strong>Tip:</strong> Default fields (like {studentLower} name and phone) are always included
            and cannot be deleted, ensuring you always capture essential information.
          </TipBox>
        </div>
      ),
    },
    {
      id: "bank-accounts",
      title: "Setup Payment Accounts",
      icon: "🏦",
      videoId: "IQ7h7g088rg",
      content: (
        <div className="space-y-4">
          <p className="text-gray-600">
            Configure your bank accounts so {studentLower}s know where to send payment after registering.
            These appear on the payment instructions page.
          </p>
          <ol className="space-y-3 text-sm text-gray-700">
            <StepItem n={1} title="Go to Settings">
              Click &quot;Settings&quot; in the sidebar (owner-only).
            </StepItem>
            <StepItem n={2} title="Add a bank account">
              Choose from preset banks (KBZ, AYA, CB, Wave Money, KPay, etc.) or type a custom bank name.
              Enter the account holder name and account number.
            </StepItem>
            <StepItem n={3} title="Upload QR code (optional)">
              You can upload a payment QR code image. If a QR code is provided, the account number becomes
              optional.
            </StepItem>
            <StepItem n={4} title="Activate the account">
              Accounts are active by default. You can deactivate them anytime — deactivated accounts
              won&apos;t be shown to {studentLower}s.
            </StepItem>
          </ol>
        </div>
      ),
    },
    {
      id: "open-registration",
      title: "Open Registration",
      icon: "🚀",
      videoId: "XopK_RiB_Y4",
      content: (
        <div className="space-y-4">
          <p className="text-gray-600">
            Once your {intakeLower}, {classLower}s, form, and payment accounts are set up, you can open
            registration for {studentLower}s.
          </p>
          <ol className="space-y-3 text-sm text-gray-700">
            <StepItem n={1} title={`Set ${intakeLower} status to "Open"`}>
              On the {intakeLower} detail page, change the status from &quot;Draft&quot; to
              &quot;Open&quot;. This makes the {intakeLower} visible on the public registration page.
            </StepItem>
            <StepItem n={2} title={`Ensure ${classLower}s are open`}>
              At least one {classLower} should have status &quot;open&quot; with available{" "}
              {L.seat.toLowerCase()}s.
            </StepItem>
            <StepItem n={3} title="Share the registration link">
              Copy the public registration URL from the {intakeLower} detail page and share it with your
              audience.
            </StepItem>
          </ol>
          <TipBox color="green">
            <strong>Checklist before opening:</strong>
            <ul className="mt-1 space-y-0.5 list-disc list-inside">
              <li>At least one {classLower} created with {L.seat.toLowerCase()}s available</li>
              <li>Registration form fields configured</li>
              <li>Bank account(s) added in Settings</li>
              <li>{L.intake} status set to &quot;Open&quot;</li>
            </ul>
          </TipBox>
        </div>
      ),
    },
    {
      id: "student-enrollment",
      title: `${L.student} Enrollment & Payment`,
      icon: "👤",
      videoId: "w3hcKjrPd7s",
      content: (
        <div className="space-y-4">
          <p className="text-gray-600">
            This is what your {studentLower}s see when they register and pay. Share this flow with your
            team so everyone understands the {studentLower} experience.
          </p>
          <h3 className="text-sm font-semibold text-gray-900">Registration Flow</h3>
          <ol className="space-y-3 text-sm text-gray-700">
            <StepItem n={1} title="Open the registration link">
              {L.student}s open the public registration URL you shared. They see available{" "}
              {classLower}s with {L.fee.toLowerCase()}s and {L.seat.toLowerCase()} availability.
            </StepItem>
            <StepItem n={2} title={`Select ${classLower} and quantity`}>
              They choose which {classLower}(s) to register for and set the quantity if multiple{" "}
              {L.seat.toLowerCase()}s are needed.
            </StepItem>
            <StepItem n={3} title="Fill in the registration form">
              They enter their name, phone number, and any custom fields you configured in the form
              builder.
            </StepItem>
            <StepItem n={4} title="Review and submit">
              They review their order summary and submit the registration. A reference number is generated
              (e.g. &quot;NM-2026-00042&quot;).
            </StepItem>
          </ol>
          <h3 className="text-sm font-semibold text-gray-900 pt-2">Payment Flow</h3>
          <ol className="space-y-3 text-sm text-gray-700">
            <StepItem n={1} title="View payment instructions">
              After registering, {studentLower}s are taken to the payment page showing your bank
              accounts, QR codes, and the total amount due.
            </StepItem>
            <StepItem n={2} title="Make the transfer">
              They transfer the {L.fee.toLowerCase()} to one of your bank accounts using mobile banking,
              KPay, Wave, etc.
            </StepItem>
            <StepItem n={3} title="Upload payment screenshot">
              They upload a screenshot of the transfer confirmation as proof of payment.
            </StepItem>
            <StepItem n={4} title="Wait for verification">
              The enrollment status changes to &quot;Payment Under Review&quot;. They can check their
              status anytime using the reference number.
            </StepItem>
          </ol>
          <TipBox color="amber">
            <strong>Auto-cancel:</strong> If a {studentLower} doesn&apos;t submit payment within the
            configured deadline (set in Settings → Enrollment Policy), their enrollment is automatically
            cancelled and {L.seat.toLowerCase()}s are released.
          </TipBox>
        </div>
      ),
    },
    {
      id: "payment-management",
      title: "Approve / Reject Payments",
      icon: "✅",
      videoId: "IghCecbB38Q",
      content: (
        <div className="space-y-4">
          <p className="text-gray-600">
            When {studentLower}s submit payment screenshots, you need to verify them. You can approve,
            reject, or record partial payments.
          </p>
          <h3 className="text-sm font-semibold text-gray-900">Reviewing Payments</h3>
          <ol className="space-y-3 text-sm text-gray-700">
            <StepItem n={1} title="Go to Payments">
              Click &quot;Payments&quot; in the sidebar. You&apos;ll see all pending payments that need
              review.
            </StepItem>
            <StepItem n={2} title="View payment details">
              Click on a payment to see the {studentLower}&apos;s information, the uploaded screenshot,
              and the amount due.
            </StepItem>
            <StepItem n={3} title="Verify the screenshot">
              Compare the uploaded screenshot with your bank/wallet transaction history to confirm the
              transfer was received.
            </StepItem>
          </ol>
          <h3 className="text-sm font-semibold text-gray-900 pt-2">Payment Actions</h3>
          <ul className="space-y-2 text-sm text-gray-700">
            <BulletItem>
              <strong>Approve (Full Payment):</strong> Click &quot;Approve&quot; when the full amount has
              been received. The enrollment status changes to &quot;Confirmed&quot; and the{" "}
              {studentLower} is notified.
            </BulletItem>
            <BulletItem>
              <strong>Partial Payment:</strong> If the {studentLower} paid less than the full amount,
              enter the received amount. The enrollment status changes to &quot;Partial Payment&quot; and
              the {studentLower} can see the remaining balance on their status page.
            </BulletItem>
            <BulletItem>
              <strong>Reject:</strong> If the screenshot is invalid or payment wasn&apos;t received, reject
              it with a note explaining why. The {studentLower} can submit a new payment.
            </BulletItem>
          </ul>
          <TipBox color="blue">
            <strong>Tip:</strong> You can add an admin note when approving or rejecting a payment. This
            note is visible to the {studentLower} on their status page, so use it to communicate any
            important information (e.g. &quot;Partial payment received — please pay the remaining
            balance&quot;).
          </TipBox>
          <TipBox color="green">
            <strong>Notification badge:</strong> The sidebar shows a badge count of pending payments that
            need your attention. This updates automatically every 30 seconds.
          </TipBox>
        </div>
      ),
    },
    {
      id: "messenger-bot",
      title: "Facebook Messenger Bot",
      icon: "💬",
      videoId: "A684gbpPE3k",
      content: (
        <div className="space-y-4">
          <p className="text-gray-600">
            Connect your Facebook Page to enable an auto-reply bot that helps {studentLower}s check
            enrollment status, view registration links, and get answers to common questions — all through
            Messenger.
          </p>
          <h3 className="text-sm font-semibold text-gray-900">Connecting Your Facebook Page</h3>
          <ol className="space-y-3 text-sm text-gray-700">
            <StepItem n={1} title="Go to Settings">
              Click &quot;Settings&quot; in the sidebar (owner-only). Scroll down to the &quot;Facebook
              Messenger Bot&quot; section.
            </StepItem>
            <StepItem n={2} title='Click "Connect Facebook Page"'>
              You&apos;ll be redirected to Facebook to authorize the connection. Make sure you&apos;re
              logged into the Facebook account that manages your Page.
            </StepItem>
            <StepItem n={3} title="Select your Page">
              If you manage multiple Facebook Pages, you&apos;ll see a list to choose from. Select the
              Page you want to connect.
            </StepItem>
            <StepItem n={4} title="Enable the bot">
              After connecting, toggle the bot switch to &quot;On&quot;. The bot will start responding to
              messages on your Page automatically.
            </StepItem>
          </ol>
          <h3 className="text-sm font-semibold text-gray-900 pt-2">Customizing the Bot</h3>
          <ul className="space-y-2 text-sm text-gray-700">
            <BulletItem>
              <strong>Custom Greeting:</strong> Set a welcome message that {studentLower}s see when they
              first message your Page (e.g. &quot;Welcome! How can we help you?&quot;).
            </BulletItem>
            <BulletItem>
              <strong>Menu Buttons:</strong> Customize the quick-reply buttons shown to users. You can
              rename buttons, show or hide them using the toggle switches.
            </BulletItem>
            <BulletItem>
              <strong>Live Agent Handoff:</strong> When a {studentLower} requests to speak with a human,
              the bot pauses for a configurable duration (default 15 minutes) so your team can respond
              directly.
            </BulletItem>
          </ul>
          <h3 className="text-sm font-semibold text-gray-900 pt-2">Managing the Connection</h3>
          <ul className="space-y-2 text-sm text-gray-700">
            <BulletItem>
              <strong>Enable / Disable:</strong> Toggle the bot on or off anytime without disconnecting
              the Page. When disabled, the bot won&apos;t respond to messages.
            </BulletItem>
            <BulletItem>
              <strong>Disconnect:</strong> To fully remove the connection, click &quot;Disconnect
              Page&quot;. You can reconnect anytime.
            </BulletItem>
          </ul>
          <TipBox color="blue">
            <strong>Tip:</strong> After connecting, click &quot;Save Bot Settings&quot; to apply your
            custom greeting, menu buttons, and handoff timeout changes.
          </TipBox>
          <TipBox color="amber">
            <strong>Note:</strong> The bot uses your organization&apos;s registration link and data to
            answer {studentLower} queries. Make sure your {intakeLower}s and {classLower}s are set up
            before enabling the bot.
          </TipBox>
        </div>
      ),
    },
  ];
}

// ── Reusable sub-components ─────────────────────────────────────────────────

function StepItem({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
        {n}
      </span>
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-gray-500 mt-0.5">{children}</p>
      </div>
    </li>
  );
}

function BulletItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="text-[#6d28d9]">•</span>
      <span>{children}</span>
    </li>
  );
}

function TipBox({ color, children }: { color: "blue" | "amber" | "green"; children: React.ReactNode }) {
  const colors = {
    blue: "bg-blue-50 border-blue-200 text-blue-800",
    amber: "bg-amber-50 border-amber-200 text-amber-800",
    green: "bg-green-50 border-green-200 text-green-800",
  };
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${colors[color]}`}>
      {children}
    </div>
  );
}

// ── Guide Page ───────────────────────────────────────────────────────────────

export default function GuidePage() {
  const [labels, setLabels] = useState<OrgLabels>(DEFAULT_LABELS);
  const [loading, setLoading] = useState(true);
  const [activeTopic, setActiveTopic] = useState("create-intake");
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null);

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  const fetchLabels = useCallback(async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data: profile } = (await supabase
        .from("users")
        .select("tenant_id")
        .eq("id", user.id)
        .single()) as { data: { tenant_id: string } | null; error: unknown };
      if (!profile) return;

      const { data: tenant } = (await supabase
        .from("tenants")
        .select("label_intake, label_class, label_student, label_seat, label_fee")
        .eq("id", profile.tenant_id)
        .single()) as {
        data: {
          label_intake: string | null;
          label_class: string | null;
          label_student: string | null;
          label_seat: string | null;
          label_fee: string | null;
        } | null;
        error: unknown;
      };

      if (tenant) {
        setLabels({
          intake: tenant.label_intake ?? "Intake",
          class: tenant.label_class ?? "Class Type",
          student: tenant.label_student ?? "Student",
          seat: tenant.label_seat ?? "Seat",
          fee: tenant.label_fee ?? "Fee",
        });
      }
    } catch {
      // keep defaults
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    fetchLabels();
  }, [fetchLabels]);

  const topics = buildGuideTopics(labels);
  const activeContent = topics.find((t) => t.id === activeTopic);

  if (loading) {
    return (
      <div className="p-6 lg:p-10 max-w-5xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-gray-200 rounded" />
          <div className="h-4 w-72 bg-gray-100 rounded" />
          <div className="h-64 bg-gray-100 rounded-2xl mt-6" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">User Guide</h1>
        <p className="text-sm text-gray-500 mt-1">
          Step-by-step instructions to help you get started with managing{" "}
          {labels.intake.toLowerCase()}s.
        </p>
      </div>

      <div className="flex gap-6">
        {/* Topic sidebar */}
        <nav className="hidden md:block w-56 shrink-0">
          <div className="sticky top-6 space-y-1">
            {topics.map((topic) => (
              <button
                key={topic.id}
                onClick={() => setActiveTopic(topic.id)}
                className={[
                  "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-left transition-colors",
                  activeTopic === topic.id
                    ? "bg-[#6d28d9] text-white font-medium"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                ].join(" ")}
              >
                <span className="text-base leading-none shrink-0">{topic.icon}</span>
                <span className="truncate">{topic.title}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* Mobile topic selector */}
        <div className="md:hidden w-full mb-4">
          <select
            value={activeTopic}
            onChange={(e) => setActiveTopic(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6d28d9] focus:border-transparent"
          >
            {topics.map((topic) => (
              <option key={topic.id} value={topic.id}>
                {topic.icon} {topic.title}
              </option>
            ))}
          </select>
        </div>

        {/* Content area */}
        <div className="flex-1 min-w-0">
          {activeContent && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{activeContent.icon}</span>
                  <h2 className="text-lg font-bold text-gray-900">{activeContent.title}</h2>
                </div>

                {/* Video Tutorial Button */}
                {activeContent.videoId ? (
                  <button
                    onClick={() => setPlayingVideoId(activeContent.videoId)}
                    className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 text-sm font-medium transition-colors shrink-0"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Watch Video
                  </button>
                ) : (
                  <span className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gray-50 text-gray-400 border border-gray-200 text-xs font-medium shrink-0 cursor-default">
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Video coming soon
                  </span>
                )}
              </div>
              {activeContent.content}
            </div>
          )}
        </div>
      </div>

      {/* Video Modal */}
      {playingVideoId && (
        <VideoModal videoId={playingVideoId} onClose={() => setPlayingVideoId(null)} />
      )}
    </div>
  );
}
