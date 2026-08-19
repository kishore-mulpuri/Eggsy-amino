import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#870206",
          dark: "#720005",
        },
        bg: "#FAF8F7",
        surface: "#FFFFFF",
        input: "#E8F0FE",
        ink: {
          DEFAULT: "#131313",
          muted: "#8B8B8B",
        },
        line: "#EBEBEB",
        accent: "#F5C84B",
      },
      boxShadow: {
        card: "0 1px 2px rgba(19, 19, 19, 0.05), 0 1px 3px rgba(19, 19, 19, 0.06)",
        float: "0 8px 24px rgba(19, 19, 19, 0.12)",
      },
    },
  },
  plugins: [],
} satisfies Config;
