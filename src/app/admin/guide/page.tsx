"use client";

import { useState } from "react";

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

// ── Guide Topics ─────────────────────────────────────────────────────────────

interface GuideTopic {
  id: string;
  title: string;
  icon: string;
  videoId: string | null; // YouTube video ID (unlisted), null = coming soon
  content: React.ReactNode;
}

const GUIDE_TOPICS: GuideTopic[] = [
  {
    id: "create-event",
    title: "Create an Event",
    icon: "🎪",
    videoId: null, // TODO: add YouTube video ID
    content: (
      <div className="space-y-4">
        <p className="text-gray-600">
          Events are the top-level container for your tickets and registrations. Each event has its
          own public registration page.
        </p>
        <ol className="space-y-3 text-sm text-gray-700">
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              1
            </span>
            <div>
              <p className="font-medium">Go to Events & Ticket Types</p>
              <p className="text-gray-500 mt-0.5">
                Click the &quot;Events & Ticket Types&quot; link in the left sidebar.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              2
            </span>
            <div>
              <p className="font-medium">Click &quot;+ New Event&quot;</p>
              <p className="text-gray-500 mt-0.5">
                You&apos;ll find this button at the top-right of the events list page.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              3
            </span>
            <div>
              <p className="font-medium">Pick a month and year</p>
              <p className="text-gray-500 mt-0.5">
                Select the month and year for your event. An event name will be auto-generated (e.g.
                &quot;March 2026 Event&quot;), but you can edit it to any custom name.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              4
            </span>
            <div>
              <p className="font-medium">Click &quot;Create Event&quot;</p>
              <p className="text-gray-500 mt-0.5">
                You&apos;ll be taken to the event detail page where you can add ticket types.
              </p>
            </div>
          </li>
        </ol>
        <div className="rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
          <strong>Tip:</strong> After creating the event, its status will be &quot;draft&quot;. You
          need to set it to &quot;open&quot; before attendees can register.
        </div>
      </div>
    ),
  },
  {
    id: "create-tickets",
    title: "Create Ticket Types",
    icon: "🎫",
    videoId: null, // TODO: add YouTube video ID
    content: (
      <div className="space-y-4">
        <p className="text-gray-600">
          Ticket types define the different options attendees can choose when registering for your
          event (e.g. &quot;VIP&quot;, &quot;Standard&quot;, &quot;Early Bird&quot;).
        </p>
        <ol className="space-y-3 text-sm text-gray-700">
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              1
            </span>
            <div>
              <p className="font-medium">Open your event</p>
              <p className="text-gray-500 mt-0.5">
                From the events list, click on the event you want to add tickets to.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              2
            </span>
            <div>
              <p className="font-medium">Click &quot;+ Add Ticket Type&quot;</p>
              <p className="text-gray-500 mt-0.5">
                In the ticket types section, click the add button to create a new ticket type.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              3
            </span>
            <div>
              <p className="font-medium">Set ticket details</p>
              <p className="text-gray-500 mt-0.5">
                Enter the ticket name, price (in MMK), and number of available seats.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              4
            </span>
            <div>
              <p className="font-medium">Save the ticket type</p>
              <p className="text-gray-500 mt-0.5">
                Click &quot;Add&quot; to save. The ticket will appear in the list. You can add
                multiple ticket types to the same event.
              </p>
            </div>
          </li>
        </ol>
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          <strong>Note:</strong> Seats are tracked automatically. When all seats are taken, the
          ticket type status changes to &quot;full&quot;.
        </div>
      </div>
    ),
  },
  {
    id: "setup-tickets",
    title: "Setup Ticket Details",
    icon: "⚙️",
    videoId: null, // TODO: add YouTube video ID
    content: (
      <div className="space-y-4">
        <p className="text-gray-600">
          After creating ticket types, you can fine-tune their settings — adjust pricing, seat
          counts, dates, and status.
        </p>
        <h3 className="text-sm font-semibold text-gray-900">Editing a Ticket Type</h3>
        <ul className="space-y-2 text-sm text-gray-700">
          <li className="flex gap-2">
            <span className="text-[#6d28d9]">•</span>
            <span>
              <strong>Price:</strong> Click on the fee amount to edit it. Enter the new price in MMK.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-[#6d28d9]">•</span>
            <span>
              <strong>Seats:</strong> Click the seat count to change availability. Remaining seats
              update automatically based on registrations.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-[#6d28d9]">•</span>
            <span>
              <strong>Dates:</strong> Set start/end dates to control when the ticket type is
              available for registration.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-[#6d28d9]">•</span>
            <span>
              <strong>Status:</strong> Toggle between &quot;open&quot;, &quot;closed&quot;, or
              &quot;full&quot; to control registration availability.
            </span>
          </li>
        </ul>
        <h3 className="text-sm font-semibold text-gray-900 pt-2">Multi-Ticket Support</h3>
        <p className="text-sm text-gray-600">
          Attendees can purchase multiple tickets at once. The quantity selector appears on the
          public registration page, allowing them to register for multiple seats in a single
          submission.
        </p>
      </div>
    ),
  },
  {
    id: "manage-forms",
    title: "Manage Registration Forms",
    icon: "📝",
    videoId: null, // TODO: add YouTube video ID
    content: (
      <div className="space-y-4">
        <p className="text-gray-600">
          Each event has a customizable registration form. You can add, remove, and reorder fields
          to collect the information you need from attendees.
        </p>
        <h3 className="text-sm font-semibold text-gray-900">Accessing the Form Builder</h3>
        <ol className="space-y-3 text-sm text-gray-700">
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              1
            </span>
            <div>
              <p className="font-medium">Open your event</p>
              <p className="text-gray-500 mt-0.5">Navigate to the event detail page.</p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              2
            </span>
            <div>
              <p className="font-medium">Click &quot;Edit Form&quot;</p>
              <p className="text-gray-500 mt-0.5">
                You&apos;ll find this link in the event detail page. It opens the form builder.
              </p>
            </div>
          </li>
        </ol>
        <h3 className="text-sm font-semibold text-gray-900 pt-2">Adding Fields</h3>
        <ul className="space-y-2 text-sm text-gray-700">
          <li className="flex gap-2">
            <span className="text-[#6d28d9]">•</span>
            <span>
              Click &quot;+ Add Field&quot; to add a new form field.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-[#6d28d9]">•</span>
            <span>
              Choose the field type: <strong>Text</strong>, <strong>Select</strong> (dropdown),{" "}
              <strong>Radio</strong>, <strong>Date</strong>, <strong>Phone</strong>,{" "}
              <strong>File</strong> upload, or <strong>Checkbox</strong>.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-[#6d28d9]">•</span>
            <span>
              For Select and Radio fields, add the options that attendees can choose from.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-[#6d28d9]">•</span>
            <span>Toggle &quot;Required&quot; to make a field mandatory.</span>
          </li>
        </ul>
        <h3 className="text-sm font-semibold text-gray-900 pt-2">Reordering & Removing</h3>
        <ul className="space-y-2 text-sm text-gray-700">
          <li className="flex gap-2">
            <span className="text-[#6d28d9]">•</span>
            <span>
              <strong>Drag & drop</strong> fields to reorder them. The order you set is the order
              attendees see on the registration page.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-[#6d28d9]">•</span>
            <span>
              Click the <strong>delete</strong> icon to remove a custom field. Default fields
              (Name, Phone) cannot be removed.
            </span>
          </li>
        </ul>
        <div className="rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
          <strong>Tip:</strong> Default fields (like student name and phone) are always included and
          cannot be deleted, ensuring you always capture essential information.
        </div>
      </div>
    ),
  },
  {
    id: "bank-accounts",
    title: "Setup Payment Accounts",
    icon: "🏦",
    videoId: null, // TODO: add YouTube video ID
    content: (
      <div className="space-y-4">
        <p className="text-gray-600">
          Configure your bank accounts so attendees know where to send payment after registering.
          These appear on the payment instructions page.
        </p>
        <ol className="space-y-3 text-sm text-gray-700">
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              1
            </span>
            <div>
              <p className="font-medium">Go to Settings</p>
              <p className="text-gray-500 mt-0.5">
                Click &quot;Settings&quot; in the sidebar (owner-only).
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              2
            </span>
            <div>
              <p className="font-medium">Add a bank account</p>
              <p className="text-gray-500 mt-0.5">
                Choose from preset banks (KBZ, AYA, CB, Wave Money, KPay, etc.) or type a custom
                bank name. Enter the account holder name and account number.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              3
            </span>
            <div>
              <p className="font-medium">Upload QR code (optional)</p>
              <p className="text-gray-500 mt-0.5">
                You can upload a payment QR code image. If a QR code is provided, the account number
                becomes optional.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              4
            </span>
            <div>
              <p className="font-medium">Activate the account</p>
              <p className="text-gray-500 mt-0.5">
                Accounts are active by default. You can deactivate them anytime — deactivated
                accounts won&apos;t be shown to attendees.
              </p>
            </div>
          </li>
        </ol>
      </div>
    ),
  },
  {
    id: "open-registration",
    title: "Open Registration",
    icon: "🚀",
    videoId: null, // TODO: add YouTube video ID
    content: (
      <div className="space-y-4">
        <p className="text-gray-600">
          Once your event, tickets, form, and payment accounts are set up, you can open registration
          for attendees.
        </p>
        <ol className="space-y-3 text-sm text-gray-700">
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              1
            </span>
            <div>
              <p className="font-medium">Set event status to &quot;Open&quot;</p>
              <p className="text-gray-500 mt-0.5">
                On the event detail page, change the status from &quot;Draft&quot; to
                &quot;Open&quot;. This makes the event visible on the public registration page.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              2
            </span>
            <div>
              <p className="font-medium">Ensure ticket types are open</p>
              <p className="text-gray-500 mt-0.5">
                At least one ticket type should have status &quot;open&quot; with available seats.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[#6d28d9] text-white text-xs font-bold flex items-center justify-center">
              3
            </span>
            <div>
              <p className="font-medium">Share the registration link</p>
              <p className="text-gray-500 mt-0.5">
                Copy the public registration URL from the event detail page and share it with your
                audience.
              </p>
            </div>
          </li>
        </ol>
        <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          <strong>Checklist before opening:</strong>
          <ul className="mt-1 space-y-0.5 list-disc list-inside">
            <li>At least one ticket type created with seats available</li>
            <li>Registration form fields configured</li>
            <li>Bank account(s) added in Settings</li>
            <li>Event status set to &quot;Open&quot;</li>
          </ul>
        </div>
      </div>
    ),
  },
];

// ── Guide Page ───────────────────────────────────────────────────────────────

export default function GuidePage() {
  const [activeTopic, setActiveTopic] = useState(GUIDE_TOPICS[0].id);
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null);

  const activeContent = GUIDE_TOPICS.find((t) => t.id === activeTopic);

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">User Guide</h1>
        <p className="text-sm text-gray-500 mt-1">
          Step-by-step instructions to help you get started with managing events.
        </p>
      </div>

      <div className="flex gap-6">
        {/* Topic sidebar */}
        <nav className="hidden md:block w-56 shrink-0">
          <div className="sticky top-6 space-y-1">
            {GUIDE_TOPICS.map((topic) => (
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
            {GUIDE_TOPICS.map((topic) => (
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
