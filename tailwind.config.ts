import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["JetBrains Mono", "SFMono-Regular", "Consolas", "monospace"],
      },
      boxShadow: {
        alert: "0 0 40px rgba(255, 0, 64, 0.55), inset 0 0 32px rgba(255, 0, 64, 0.16)",
      },
      keyframes: {
        scan: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100vh)" },
        },
        glitch: {
          "0%, 100%": { transform: "translate(0)" },
          "20%": { transform: "translate(-2px, 2px)" },
          "40%": { transform: "translate(2px, -1px)" },
          "60%": { transform: "translate(-1px, -2px)" },
          "80%": { transform: "translate(1px, 1px)" },
        },
      },
      animation: {
        scan: "scan 2.8s linear infinite",
        glitch: "glitch 180ms steps(2, end) infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
