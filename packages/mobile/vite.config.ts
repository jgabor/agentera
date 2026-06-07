import { defineConfig } from "vite-plus";

export default defineConfig({
  // Vite+ reads this for lint/fmt/check/staged until SvelteKit scaffold lands
  staged: {
    "*.{md,json,yaml,yml}": "vp fmt --no-error-on-unmatched-pattern",
  },
});
