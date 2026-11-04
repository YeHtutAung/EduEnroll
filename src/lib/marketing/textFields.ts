import type { MarketingContent } from "./content";

export type TextField = {
  label: string;
  path: string;
  /** Edits `${path}.en` and `${path}.mm` side by side. */
  localized?: boolean;
  multiline?: boolean;
  /** Path of this item's `hidden` flag, when the item can be hidden here. */
  hiddenPath?: string;
};
export type TextGroup = { title: string; fields: TextField[] };

const f = (label: string, path: string, opts: Partial<TextField> = {}): TextField => ({ label, path, ...opts });
const loc = (label: string, path: string, opts: Partial<TextField> = {}) => f(label, path, { localized: true, ...opts });
const long = { multiline: true };

export function textGroups(c: MarketingContent): TextGroup[] {
  return [
    {
      title: "Hero",
      fields: [
        f("Sign-in button", "hero.signIn"),
        f("Get-started button", "hero.getStarted"),
        f("Eyebrow", "hero.eyebrow"),
        loc("Headline", "hero.headline"),
        f("Subtext", "hero.subtext", long),
        f("Main button", "hero.primaryCta"),
        f("Second button", "hero.secondaryCta"),
        loc("Trust line", "hero.trust", long),
      ],
    },
    {
      title: "Trusted by",
      fields: [loc("Heading", "organizers.heading"), f("Intro", "organizers.intro", long)],
    },
    { title: "Accepted payments", fields: [loc("Heading", "payments.heading")] },
    {
      title: "Solutions",
      fields: [
        f("Eyebrow", "solutions.eyebrow"),
        loc("Heading", "solutions.heading"),
        f("Intro", "solutions.intro", long),
        ...c.solutions.items.flatMap((item, i) => {
          const p = `solutions.items.${i}`;
          return [
            f(`Card ${i + 1}: label`, `${p}.label`, { hiddenPath: `${p}.hidden` }),
            loc(`Card ${i + 1}: title`, `${p}.title`),
            f(`Card ${i + 1}: description`, `${p}.description`, long),
          ];
        }),
      ],
    },
    {
      title: "Cashless bars & food stalls",
      fields: [
        f("Eyebrow", "pos.eyebrow"),
        loc("Title", "pos.title"),
        f("Description", "pos.description", long),
        ...c.pos.bullets.map((_, i) => f(`Bullet ${i + 1}`, `pos.bullets.${i}`)),
      ],
    },
    {
      title: "How it works",
      fields: [
        loc("Heading", "howItWorks.heading"),
        f("Intro", "howItWorks.intro", long),
        ...c.howItWorks.steps.map((_, i) =>
          loc(`Step ${i + 1}`, `howItWorks.steps.${i}.title`, { hiddenPath: `howItWorks.steps.${i}.hidden` }),
        ),
      ],
    },
    {
      title: "Industries",
      fields: [
        loc("Heading", "industries.heading"),
        f("Intro", "industries.intro", long),
        ...c.industries.items.map((_, i) =>
          loc(`Card ${i + 1}`, `industries.items.${i}.name`, { hiddenPath: `industries.items.${i}.hidden` }),
        ),
      ],
    },
    {
      title: "Call to action",
      fields: [
        loc("Heading", "cta.heading"),
        f("Intro", "cta.intro", long),
        f("Main button", "cta.primary"),
        f("Second button", "cta.secondary"),
      ],
    },
    {
      title: "Footer",
      fields: [
        f("Tagline", "footer.tagline", long),
        f("Product heading", "footer.productHeading"),
        f("How-it-works link", "footer.howItWorksLink"),
        f("Organisers heading", "footer.organisersHeading"),
        f("Get-started link", "footer.getStartedLink"),
        f("Sign-in link", "footer.signInLink"),
        f("Legal heading", "footer.legalHeading"),
        f("Privacy link", "footer.privacyLink"),
        f("Copyright", "footer.copyright"),
      ],
    },
  ];
}

/** Every replaceable photo, for the Images tab. Partner and payment logos have their own tabs. */
export function imageSlots(c: MarketingContent): { label: string; path: string; canClear?: boolean }[] {
  return [
    { label: "Hero", path: "hero.image" },
    ...c.solutions.items.map((item, i) => ({
      label: `Solution: ${item.label}`,
      path: `solutions.items.${i}.image`,
      canClear: true,
    })),
    { label: "Cashless bars & food stalls", path: "pos.image" },
    { label: "How it works background", path: "howItWorks.image" },
    ...c.industries.items.map((item, i) => ({ label: `Industry: ${item.name.en}`, path: `industries.items.${i}.image` })),
    { label: "Call to action background", path: "cta.image" },
  ];
}
