import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "AI Homepage",
    description: "A new-tab page an agent rebuilds daily from what you've actually been browsing.",
    permissions: [
      "history", //       getHistory tool
      "tabs", //          getPageHtml: open pages and watch them load
      "scripting", //     getPageHtml: inject the scraper into loaded pages
      "webRequest", //    getPageHtml: the address each scraped page was served from (observe only)
      "storage", //       API key, settings, the built homepage
      "alarms", //        heartbeat: scheduled rebuilds while the browser is open
      "notifications", // surface a failed headless rebuild when no tab is open
    ],
    // Needed to scrape arbitrary pages and to call the configured API origin.
    host_permissions: ["<all_urls>"],
    // target=_blank from the generated page must escape the sandbox. Chrome
    // forbids allow-same-origin here; the default policy omits the escape token.
    content_security_policy: {
      sandbox:
        "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';",
    },
  },
});
