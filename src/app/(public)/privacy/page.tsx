import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy - KuuNyi",
  description:
    "Learn how KuuNyi collects, uses, and protects your information when using our enrollment management platform.",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto max-w-[740px] py-10 sm:py-16">
      {/* Label */}
      <p className="mb-4 text-[11px] font-mono uppercase tracking-[0.2em] text-gray-500">
        Legal Document
      </p>

      {/* Title */}
      <h1 className="text-3xl sm:text-[40px] font-semibold leading-tight tracking-tight text-gray-900 mb-3">
        Privacy Policy
      </h1>

      {/* Last updated */}
      <p className="text-xs font-mono text-gray-500 mb-12 pb-8 border-b border-gray-200">
        Last updated: March 2026 &nbsp;&middot;&nbsp; Effective: March 2026
      </p>

      {/* Intro */}
      <div className="mb-12 rounded border border-gray-200 border-l-[3px] border-l-[#6d28d9] bg-white px-6 py-5 text-[15px] leading-[1.7] text-gray-500">
        KuuNyi (&ldquo;we&rdquo;, &ldquo;our&rdquo;, or &ldquo;us&rdquo;) is committed to protecting
        your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your
        information when you use our enrollment management platform at kuunyi.com and any associated
        subdomains.
      </div>

      {/* Sections */}
      <div className="space-y-10 text-[14.5px] leading-[1.8] text-[#3a3a36]">
        <Section title="1. Information We Collect">
          <p>We collect information you provide directly to us when using the KuuNyi platform:</p>
          <PolicyList
            items={[
              "Account information — name, email address, and password when you register an organization",
              "Organization information — school or business name, subdomain, and organization type",
              "Enrollment data — student names, contact information, NRC numbers, and form responses submitted through enrollment forms",
              "Payment records — payment proof images and payment status information",
              "Messenger data — Facebook Page IDs and access tokens for organizations using the Messenger bot integration",
              "Usage data — pages visited, actions taken, and timestamps within the platform",
            ]}
          />
        </Section>

        <Section title="2. How We Use Your Information">
          <p>We use the information we collect to:</p>
          <PolicyList
            items={[
              "Provide, operate, and maintain the KuuNyi platform",
              "Process enrollments and manage student records on behalf of organizations",
              "Send enrollment confirmation and status notification emails",
              "Enable Facebook Messenger chatbot functionality for connected organizations",
              "Improve and develop new features for the platform",
              "Respond to support requests and inquiries",
              "Ensure the security and integrity of the platform",
            ]}
          />
        </Section>

        <Section title="3. Data Storage and Security">
          <p>
            Your data is stored securely using Supabase (PostgreSQL) hosted infrastructure. We
            implement industry-standard security measures including:
          </p>
          <PolicyList
            items={[
              "Encrypted data transmission via HTTPS/TLS",
              "Row-level security policies on all database tables",
              "Secure authentication via Supabase Auth",
              "Role-based access controls limiting data access by user role",
              "Audit logging for sensitive operations such as bank account changes",
            ]}
          />
          <p>
            While we implement strong security measures, no method of transmission over the internet
            is 100% secure. We cannot guarantee absolute security of your data.
          </p>
        </Section>

        <Section title="4. Data Sharing and Disclosure">
          <p>
            We do not sell, trade, or rent your personal information to third parties. We may share
            your information only in the following circumstances:
          </p>
          <PolicyList
            items={[
              "With service providers who assist in operating our platform (Supabase, Vercel, Resend) under strict data processing agreements",
              "With Facebook/Meta when you use the Messenger bot integration — governed by Meta's own Privacy Policy",
              "When required by law, court order, or governmental authority",
              "To protect the rights, property, or safety of KuuNyi, our users, or the public",
            ]}
          />
        </Section>

        <Section title="5. Multi-Tenant Data Isolation">
          <p>
            KuuNyi is a multi-tenant platform. Each organization&apos;s data is logically separated
            and isolated. Organization administrators cannot access data belonging to other
            organizations. Students and enrollees can only access their own enrollment information.
          </p>
        </Section>

        <Section title="6. Facebook Messenger Integration">
          <p>If your organization uses the KuuNyi Messenger bot integration:</p>
          <PolicyList
            items={[
              "We collect and store your Facebook Page ID and Page Access Token to enable bot functionality",
              "Messages sent through Messenger are processed to respond to enrollment and status inquiries",
              "We do not store full Messenger conversation histories beyond what is needed to process requests",
              "This integration is governed by both this Privacy Policy and Meta's Platform Terms",
            ]}
          />
        </Section>

        <Section title="7. Cookies and Tracking">
          <p>
            KuuNyi uses essential cookies to maintain your login session and platform functionality.
            We do not use advertising cookies or third-party tracking technologies. Session cookies
            are deleted when you close your browser.
          </p>
        </Section>

        <Section title="8. Data Retention">
          <p>
            We retain your data for as long as your account is active or as needed to provide
            services. Organization owners may request deletion of their account and associated data
            at any time by contacting us. Enrollment records may be retained for up to 12 months
            after account closure for legal compliance purposes.
          </p>
        </Section>

        <Section title="9. Your Rights">
          <p>You have the right to:</p>
          <PolicyList
            items={[
              "Access the personal information we hold about you",
              "Request correction of inaccurate or incomplete data",
              "Request deletion of your personal data",
              "Export your organization's enrollment data at any time",
              "Withdraw consent for data processing where applicable",
            ]}
          />
          <p>To exercise any of these rights, please contact us using the details below.</p>
        </Section>

        <Section title="10. Children's Privacy">
          <p>
            KuuNyi is not directed to children under the age of 13. We do not knowingly collect
            personal information from children under 13. If you believe a child has provided us with
            personal information, please contact us and we will delete it promptly.
          </p>
        </Section>

        <Section title="11. Changes to This Policy">
          <p>
            We may update this Privacy Policy from time to time. We will notify organization
            administrators of material changes via email. Continued use of the platform after changes
            constitutes acceptance of the updated policy. The &ldquo;Last updated&rdquo; date at the
            top of this page reflects the most recent revision.
          </p>
        </Section>

        <Section title="12. Contact Us">
          <p>
            If you have questions, concerns, or requests regarding this Privacy Policy or how we
            handle your data, please contact us:
          </p>
          <div className="mt-4 rounded-md border border-gray-200 bg-white p-6">
            <p className="text-sm font-semibold text-gray-900">KuuNyi</p>
            <p className="mt-2 text-sm">
              Email:{" "}
              <a href="mailto:support@kuunyi.com" className="text-[#6d28d9] hover:underline">
                support@kuunyi.com
              </a>
            </p>
            <p className="text-sm">
              Website:{" "}
              <a
                href="https://www.kuunyi.com"
                className="text-[#6d28d9] hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                www.kuunyi.com
              </a>
            </p>
            <p className="mt-2 text-[13px] text-gray-400">
              We aim to respond to all privacy inquiries within 5 business days.
            </p>
          </div>
        </Section>
      </div>
    </div>
  );
}

// ─── Reusable components ──────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight text-gray-900 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function PolicyList({ items }: { items: string[] }) {
  return (
    <ul className="my-3 space-y-1">
      {items.map((item, i) => (
        <li key={i} className="relative pl-5">
          <span className="absolute left-0 text-xs text-gray-500">&mdash;</span>
          {item}
        </li>
      ))}
    </ul>
  );
}
