import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://agentera.dev",
  adapter: cloudflare({
    platformProxy: {
      configPath: "wrangler.jsonc",
    },
  }),
  integrations: [
    starlight({
      title: "Agentera",
      description: "The open protocol for turning AI coding agents into an engineering team.",
      logo: { src: "./src/assets/logo.svg", alt: "Agentera" },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/jgabor/agentera" }],
      customCss: ["./src/styles/starlight-overrides.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [{ autogenerate: { directory: "docs/getting-started" } }],
        },
        {
          label: "Capabilities",
          items: [{ autogenerate: { directory: "docs/capabilities" } }],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "docs/reference" } }],
        },
      ],
    }),
  ],
});
