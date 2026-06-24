import * as path from "path";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { env } from "process";

// wdio-obsidian-service downloads Obsidian builds into this dir (gitignored).
const cacheDir = path.resolve(".obsidian-cache");

// Default: just the latest installer. Override with e.g.
//   OBSIDIAN_VERSIONS="earliest/earliest latest/latest" npm run test:e2e
const versions = await parseObsidianVersions(
  env.OBSIDIAN_VERSIONS ?? "latest/latest",
  { cacheDir },
);

// Under CI, print the resolved versions so the workflow can key the
// .obsidian-cache GitHub cache on them (see .github/workflows/test.yaml).
if (env.CI) {
  console.log("obsidian-cache-key:", JSON.stringify(versions));
}

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",

  specs: ["./test/specs/**/*.e2e.ts"],

  maxInstances: Number(env.WDIO_MAX_INSTANCES || 1),

  capabilities: [
    // Desktop Electron (the default).
    ...versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
      browserName: "obsidian",
      "wdio:obsidianOptions": {
        appVersion,
        installerVersion,
        // Install the plugin-under-test from the repo root (manifest.json + main.js).
        plugins: ["."],
        // wdio copies this vault into a managed temp dir per run; the original is untouched.
        vault: "test/vaults/fixtures",
      },
    })),
    // Desktop Chrome emulating a phone viewport + mobile code paths. Still
    // Electron, not the real Android app — catches Platform.isMobile branches
    // and narrow-screen layout cheaply. Off by default; set E2E_EMULATE_MOBILE=1
    // (CI does this in a dedicated job) to keep local desktop runs fast.
    ...(env.E2E_EMULATE_MOBILE
      ? versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
          browserName: "obsidian",
          "wdio:obsidianOptions": {
            appVersion,
            installerVersion,
            emulateMobile: true,
            plugins: ["."],
            vault: "test/vaults/fixtures",
          },
          "goog:chromeOptions": {
            mobileEmulation: { deviceMetrics: { width: 390, height: 844 } },
          },
        }))
      : []),
  ],

  services: ["obsidian"],
  reporters: ["obsidian"],

  mochaOpts: {
    ui: "bdd",
    timeout: 60 * 1000,
  },
  waitforInterval: 250,
  waitforTimeout: 5 * 1000,
  logLevel: "warn",

  cacheDir,

  injectGlobals: false,
};
