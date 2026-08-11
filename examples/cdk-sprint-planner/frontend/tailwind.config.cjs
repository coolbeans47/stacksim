const path = require("node:path");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [path.join(__dirname, "src/**/*.{ts,tsx}")],
  theme: {
    extend: {
      colors: {
        canvas: "#f8f7f4",
        ink: "#172033",
        indigo: { 50: "#eef2ff", 100: "#e0e7ff", 500: "#6366f1", 600: "#4f46e5", 700: "#4338ca" },
      },
      boxShadow: {
        card: "0 1px 2px rgba(23,32,51,.06), 0 8px 24px rgba(23,32,51,.06)",
        drawer: "-16px 0 48px rgba(23,32,51,.12)",
      },
      fontFamily: {
        sans: ["Inter", "Avenir Next", "Segoe UI", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
