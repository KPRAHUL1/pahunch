import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
      colors: {
        ink: { 950: "#07090d", 900: "#0d1117", 800: "#151b24", 700: "#1f2731", 600: "#2d3846" },
        signal: { go: "#22c55e", warn: "#f59e0b", stop: "#ef4444", info: "#38bdf8" },
      },
    },
  },
  plugins: [],
} satisfies Config;
