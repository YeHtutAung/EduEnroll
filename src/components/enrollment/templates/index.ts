// Language school templates
export { default as LsClassicTemplate } from "./LsClassicTemplate";
export { default as LsModernTemplate } from "./LsModernTemplate";
export { default as LsWarmTemplate } from "./LsWarmTemplate";

// Event templates
export { default as EvLuxuryTemplate } from "./EvLuxuryTemplate";
export { default as EvFestivalTemplate } from "./EvFestivalTemplate";
export { default as EvCorporateTemplate } from "./EvCorporateTemplate";

// Legacy templates (still used by admin portal rendering — kept for backward compat)
export { default as MinimalTemplate } from "./MinimalTemplate";
export { default as BoldTemplate } from "./BoldTemplate";
export { default as WarmTemplate } from "./WarmTemplate";
export { default as ProfessionalTemplate } from "./ProfessionalTemplate";

// Trusted Official flow (dedicated /tickets/ + /checkout/ routes)
export { default as EvTrustedOfficialTemplate } from "./EvTrustedOfficialTemplate";
export type { EvTrustedOfficialTemplateProps } from "./EvTrustedOfficialTemplate";

export type { TemplateProps, EventTemplateProps } from "./types";
