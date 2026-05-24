import { defineConfig } from "vite-plus";

export default defineConfig({
  // Vite+ reads this for lint/fmt/check/staged; Astro owns dev/build via astro CLI
  lint: {
    ignorePatterns: ["**/*.astro", ".wrangler/**"],
    rules: {
      "typescript/triple-slash-reference": "off",
    },
  },
  fmt: {
    ignorePatterns: [".wrangler/**"],
  },
  staged: {
    "*.{js,jsx,ts,tsx,mjs}": ["vp fmt --no-error-on-unmatched-pattern", "vp lint --fix"],
    "*.{md,json,yaml,yml,html,css,scss}": "vp fmt --no-error-on-unmatched-pattern",
  },
});
