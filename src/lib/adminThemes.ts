import type { AdminTheme } from "@/types/database";

export interface AdminThemeTokens {
  sidebarBg: string;
  sidebarText: string;
  sidebarTextMuted: string;
  sidebarActiveBg: string;
  sidebarActiveText: string;
  sidebarHoverBg: string;
  sidebarBorder: string;
  sidebarBadgeBg: string;
  pageBg: string;
}

export const ADMIN_THEMES: Record<AdminTheme, AdminThemeTokens> = {
  minimal: {
    sidebarBg: "#f8fafc",
    sidebarText: "#1e293b",
    sidebarTextMuted: "#64748b",
    sidebarActiveBg: "#dbeafe",
    sidebarActiveText: "#1d4ed8",
    sidebarHoverBg: "#f1f5f9",
    sidebarBorder: "#e2e8f0",
    sidebarBadgeBg: "#f59e0b",
    pageBg: "#f9fafb",
  },
  bold: {
    sidebarBg: "#09090b",
    sidebarText: "#fafafa",
    sidebarTextMuted: "rgba(250,250,250,0.45)",
    sidebarActiveBg: "#fbbf24",
    sidebarActiveText: "#09090b",
    sidebarHoverBg: "rgba(250,250,250,0.06)",
    sidebarBorder: "rgba(250,250,250,0.08)",
    sidebarBadgeBg: "#ef4444",
    pageBg: "#f4f4f5",
  },
  warm: {
    sidebarBg: "#7c2d12",
    sidebarText: "#fff7ed",
    sidebarTextMuted: "rgba(255,247,237,0.55)",
    sidebarActiveBg: "#ea580c",
    sidebarActiveText: "#ffffff",
    sidebarHoverBg: "rgba(255,247,237,0.1)",
    sidebarBorder: "rgba(255,247,237,0.12)",
    sidebarBadgeBg: "#fbbf24",
    pageBg: "#fffbf7",
  },
  professional: {
    sidebarBg: "#0f1225",
    sidebarText: "#ffffff",
    sidebarTextMuted: "rgba(255,255,255,0.4)",
    sidebarActiveBg: "#1a3f8a",
    sidebarActiveText: "#ffffff",
    sidebarHoverBg: "rgba(255,255,255,0.08)",
    sidebarBorder: "rgba(255,255,255,0.1)",
    sidebarBadgeBg: "#b07d2a",
    pageBg: "#f0f4ff",
  },
};

export function getThemeTokens(theme: AdminTheme): AdminThemeTokens {
  return ADMIN_THEMES[theme] ?? ADMIN_THEMES.professional;
}

export function themeToCSSVars(tokens: AdminThemeTokens): Record<string, string> {
  return {
    "--sidebar-bg": tokens.sidebarBg,
    "--sidebar-text": tokens.sidebarText,
    "--sidebar-text-muted": tokens.sidebarTextMuted,
    "--sidebar-active-bg": tokens.sidebarActiveBg,
    "--sidebar-active-text": tokens.sidebarActiveText,
    "--sidebar-hover-bg": tokens.sidebarHoverBg,
    "--sidebar-border": tokens.sidebarBorder,
    "--sidebar-badge-bg": tokens.sidebarBadgeBg,
    "--page-bg": tokens.pageBg,
  };
}
