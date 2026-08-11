const path = require("node:path");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [path.join(__dirname, "src/**/*.{js,jsx}")],
  theme: {
    extend: {
      colors: {
        night: {
          950: "#050812",
          900: "#080d19",
          850: "#0b1220",
          800: "#101a2b",
        },
        aurora: {
          mint: "#7cf6c8",
          cyan: "#64d9ff",
          violet: "#a899ff",
          coral: "#ff8e83",
          gold: "#ffd782",
        },
      },
      fontFamily: {
        sans: ["Inter", "Avenir Next", "Segoe UI", "system-ui", "sans-serif"],
        display: ["Inter", "Avenir Next", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["SFMono-Regular", "Cascadia Code", "Consolas", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(124,246,200,.13), 0 24px 90px rgba(0,0,0,.42)",
        mint: "0 0 28px rgba(124,246,200,.24)",
      },
      animation: {
        "slow-pulse": "slow-pulse 3.8s ease-in-out infinite",
        drift: "drift 12s ease-in-out infinite",
        shimmer: "shimmer 1.8s linear infinite",
      },
      keyframes: {
        "slow-pulse": {
          "0%, 100%": { opacity: "0.45", transform: "scale(0.92)" },
          "50%": { opacity: "0.9", transform: "scale(1.08)" },
        },
        drift: {
          "0%, 100%": { transform: "translate3d(0, 0, 0)" },
          "50%": { transform: "translate3d(0, -8px, 0)" },
        },
        shimmer: {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(100%)" },
        },
      },
    },
  },
  plugins: [],
};
