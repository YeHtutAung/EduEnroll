import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-noto-sans)", "var(--font-noto-sans-myanmar)", "sans-serif"],
        myanmar: ["var(--font-noto-sans-myanmar)", "var(--font-noto-sans)", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
      keyframes: {
        "mail-nudge": {
          "0%, 40%, 100%": { transform: "translateY(0) rotate(0deg)" },
          "8%": { transform: "translateY(-3px) rotate(-9deg)" },
          "16%": { transform: "translateY(-3px) rotate(8deg)" },
          "24%": { transform: "translateY(-1px) rotate(-5deg)" },
          "32%": { transform: "translateY(0) rotate(3deg)" },
        },
        "mail-ring": {
          "0%": { transform: "scale(1)", opacity: "0.45" },
          "45%, 100%": { transform: "scale(1.7)", opacity: "0" },
        },
      },
      animation: {
        // Same length, so the ring goes out as the envelope wiggles, then both rest.
        "mail-nudge": "mail-nudge 3.2s ease-in-out infinite",
        "mail-ring": "mail-ring 3.2s ease-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
