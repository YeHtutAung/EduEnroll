import { MARKETING_SCHEMA_VERSION, SECTION_KEYS, type MarketingContent } from "./content";

export type ValidationResult =
  | { ok: true; content: MarketingContent }
  | { ok: false; errors: string[] };

const SHORT = 120;
const LONG = 600;
const SEO_DESCRIPTION = 300;
const NAME = 80;
const MAX_ORGANIZERS = 24;
const MAX_PAYMENTS = 12;
const MAX_PAYMENT_IMAGES = 4;
const MAX_IMAGE_SIDE = 6000;

// Item counts the page layout depends on. Items can be hidden, not added.
const SOLUTION_COUNT = 4;
const POS_BULLET_COUNT = 3;
const STEP_COUNT = 4;
const INDUSTRY_COUNT = 6;

const STATIC_PATH = /^\/marketing(\/[a-z0-9_-]+)+\.(jpe?g|png|webp)$/;
const PAYMENT_LOGO_FILES = new Set([
  "/kbzpay-logo.png",
  "/cbmmqr/cb-bank-logo.png",
  "/mmqr-logo.png",
  "/visa.svg",
  "/mastercard.svg",
]);
const BUCKET_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;
const ITEM_ID = /^[a-z0-9-]{1,40}$/;

type Obj = Record<string, unknown>;

/** Reads a tree of unknown values, collecting every problem rather than the first. */
class Checker {
  errors: string[] = [];

  fail(path: string, message: string) {
    this.errors.push(`${path}: ${message}`);
  }

  /** An object with exactly these keys. Returns null (and records why) otherwise. */
  obj(v: unknown, path: string, keys: string[]): Obj | null {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      this.fail(path, "must be an object");
      return null;
    }
    const o = v as Obj;
    for (const k of Object.keys(o)) if (!keys.includes(k)) this.fail(`${path}.${k}`, "unknown key");
    for (const k of keys) if (!(k in o)) this.fail(`${path}.${k}`, "missing");
    return o;
  }

  str(v: unknown, path: string, max = SHORT) {
    if (typeof v !== "string") return this.fail(path, "must be text");
    if (!v.trim()) return this.fail(path, "must not be blank");
    if (v.length > max) this.fail(path, `must be at most ${max} characters`);
  }

  bool(v: unknown, path: string) {
    if (typeof v !== "boolean") this.fail(path, "must be true or false");
  }

  loc(v: unknown, path: string, max = SHORT) {
    const o = this.obj(v, path, ["en", "mm"]);
    if (!o) return;
    this.str(o.en, `${path}.en`, max);
    this.str(o.mm, `${path}.mm`, max);
  }

  image(v: unknown, path: string) {
    const o = this.obj(v, path, ["kind", "path", "width", "height"]);
    if (!o) return;
    if (o.kind === "static") {
      const p = o.path;
      if (typeof p !== "string" || !(STATIC_PATH.test(p) || PAYMENT_LOGO_FILES.has(p))) {
        this.fail(`${path}.path`, "is not an allowed static image");
      }
    } else if (o.kind === "bucket") {
      if (typeof o.path !== "string" || !BUCKET_PATH.test(o.path)) {
        this.fail(`${path}.path`, "is not an uploaded image path");
      }
    } else {
      this.fail(`${path}.kind`, "must be static or bucket");
    }
    for (const side of ["width", "height"] as const) {
      const n = o[side];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_IMAGE_SIDE) {
        this.fail(`${path}.${side}`, `must be a whole number from 1 to ${MAX_IMAGE_SIDE}`);
      }
    }
  }

  /** A list with `min`..`max` entries. Returns [] (and records why) otherwise. */
  list(v: unknown, path: string, min: number, max: number): unknown[] {
    if (!Array.isArray(v)) {
      this.fail(path, "must be a list");
      return [];
    }
    if (v.length < min || v.length > max) {
      this.fail(path, min === max ? `must have exactly ${max} items` : `must have ${min} to ${max} items`);
    }
    return v;
  }

  /** Item ids must be well-formed and unique: React keys and reorder depend on it. */
  ids(items: unknown[], path: string) {
    const seen = new Set<unknown>();
    items.forEach((item, i) => {
      const id = (item as Obj | null)?.id;
      if (typeof id !== "string" || !ITEM_ID.test(id)) this.fail(`${path}[${i}].id`, "is not a valid id");
      if (seen.has(id)) this.fail(`${path}[${i}].id`, "is a duplicate");
      seen.add(id);
    });
  }
}

const TOP_KEYS = [
  "schemaVersion", "seo", "sections", "hero", "organizers", "payments",
  "solutions", "pos", "howItWorks", "industries", "cta", "footer",
];
const FOOTER_KEYS = [
  "tagline", "productHeading", "howItWorksLink", "organisersHeading",
  "getStartedLink", "signInLink", "legalHeading", "privacyLink", "copyright",
];

export function validateMarketingContent(input: unknown): ValidationResult {
  const c = new Checker();
  const top = c.obj(input, "content", TOP_KEYS);
  if (!top) return { ok: false, errors: c.errors };

  if (top.schemaVersion !== MARKETING_SCHEMA_VERSION) {
    c.fail("schemaVersion", `must be ${MARKETING_SCHEMA_VERSION}`);
  }

  const seo = c.obj(top.seo, "seo", ["title", "description"]);
  if (seo) {
    c.str(seo.title, "seo.title");
    c.str(seo.description, "seo.description", SEO_DESCRIPTION);
  }

  const sections = c.obj(top.sections, "sections", [...SECTION_KEYS]);
  if (sections) for (const k of SECTION_KEYS) c.bool(sections[k], `sections.${k}`);

  const hero = c.obj(top.hero, "hero", [
    "image", "signIn", "getStarted", "eyebrow", "headline", "subtext", "primaryCta", "secondaryCta", "trust",
  ]);
  if (hero) {
    c.image(hero.image, "hero.image");
    for (const k of ["signIn", "getStarted", "eyebrow", "primaryCta", "secondaryCta"]) c.str(hero[k], `hero.${k}`);
    c.loc(hero.headline, "hero.headline");
    c.str(hero.subtext, "hero.subtext", LONG);
    c.loc(hero.trust, "hero.trust", LONG);
  }

  const organizers = c.obj(top.organizers, "organizers", ["heading", "intro", "items"]);
  if (organizers) {
    c.loc(organizers.heading, "organizers.heading");
    c.str(organizers.intro, "organizers.intro", LONG);
    const items = c.list(organizers.items, "organizers.items", 0, MAX_ORGANIZERS);
    c.ids(items, "organizers.items");
    items.forEach((item, i) => {
      const p = `organizers.items[${i}]`;
      const o = c.obj(item, p, ["id", "name", "image", "hidden"]);
      if (!o) return;
      c.str(o.name, `${p}.name`, NAME);
      c.image(o.image, `${p}.image`);
      c.bool(o.hidden, `${p}.hidden`);
    });
  }

  const payments = c.obj(top.payments, "payments", ["heading", "items"]);
  if (payments) {
    c.loc(payments.heading, "payments.heading");
    const items = c.list(payments.items, "payments.items", 0, MAX_PAYMENTS);
    c.ids(items, "payments.items");
    items.forEach((item, i) => {
      const p = `payments.items[${i}]`;
      const o = c.obj(item, p, ["id", "name", "images", "hidden"]);
      if (!o) return;
      c.str(o.name, `${p}.name`, NAME);
      c.list(o.images, `${p}.images`, 1, MAX_PAYMENT_IMAGES).forEach((im, j) => c.image(im, `${p}.images[${j}]`));
      c.bool(o.hidden, `${p}.hidden`);
    });
  }

  const solutions = c.obj(top.solutions, "solutions", ["eyebrow", "heading", "intro", "items"]);
  if (solutions) {
    c.str(solutions.eyebrow, "solutions.eyebrow");
    c.loc(solutions.heading, "solutions.heading");
    c.str(solutions.intro, "solutions.intro", LONG);
    const items = c.list(solutions.items, "solutions.items", SOLUTION_COUNT, SOLUTION_COUNT);
    c.ids(items, "solutions.items");
    items.forEach((item, i) => {
      const p = `solutions.items[${i}]`;
      const o = c.obj(item, p, ["id", "label", "title", "description", "image", "hidden"]);
      if (!o) return;
      c.str(o.label, `${p}.label`);
      c.loc(o.title, `${p}.title`);
      c.str(o.description, `${p}.description`, LONG);
      if (o.image !== null) c.image(o.image, `${p}.image`);
      c.bool(o.hidden, `${p}.hidden`);
    });
  }

  const pos = c.obj(top.pos, "pos", ["image", "eyebrow", "title", "description", "bullets"]);
  if (pos) {
    c.image(pos.image, "pos.image");
    c.str(pos.eyebrow, "pos.eyebrow");
    c.loc(pos.title, "pos.title");
    c.str(pos.description, "pos.description", LONG);
    c.list(pos.bullets, "pos.bullets", POS_BULLET_COUNT, POS_BULLET_COUNT).forEach((b, i) =>
      c.str(b, `pos.bullets[${i}]`),
    );
  }

  const how = c.obj(top.howItWorks, "howItWorks", ["image", "heading", "intro", "steps"]);
  if (how) {
    c.image(how.image, "howItWorks.image");
    c.loc(how.heading, "howItWorks.heading");
    c.str(how.intro, "howItWorks.intro", LONG);
    const steps = c.list(how.steps, "howItWorks.steps", STEP_COUNT, STEP_COUNT);
    c.ids(steps, "howItWorks.steps");
    steps.forEach((item, i) => {
      const p = `howItWorks.steps[${i}]`;
      const o = c.obj(item, p, ["id", "title", "hidden"]);
      if (!o) return;
      c.loc(o.title, `${p}.title`);
      c.bool(o.hidden, `${p}.hidden`);
    });
  }

  const industries = c.obj(top.industries, "industries", ["heading", "intro", "items"]);
  if (industries) {
    c.loc(industries.heading, "industries.heading");
    c.str(industries.intro, "industries.intro", LONG);
    const items = c.list(industries.items, "industries.items", INDUSTRY_COUNT, INDUSTRY_COUNT);
    c.ids(items, "industries.items");
    items.forEach((item, i) => {
      const p = `industries.items[${i}]`;
      const o = c.obj(item, p, ["id", "name", "image", "hidden"]);
      if (!o) return;
      c.loc(o.name, `${p}.name`);
      c.image(o.image, `${p}.image`);
      c.bool(o.hidden, `${p}.hidden`);
    });
  }

  const cta = c.obj(top.cta, "cta", ["image", "heading", "intro", "primary", "secondary"]);
  if (cta) {
    c.image(cta.image, "cta.image");
    c.loc(cta.heading, "cta.heading");
    c.str(cta.intro, "cta.intro", LONG);
    c.str(cta.primary, "cta.primary");
    c.str(cta.secondary, "cta.secondary");
  }

  const footer = c.obj(top.footer, "footer", FOOTER_KEYS);
  if (footer) {
    for (const k of FOOTER_KEYS) c.str(footer[k], `footer.${k}`, k === "tagline" ? LONG : SHORT);
  }

  if (c.errors.length) return { ok: false, errors: c.errors };
  return { ok: true, content: input as MarketingContent };
}
