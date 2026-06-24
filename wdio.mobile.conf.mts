import * as path from "path";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { env } from "process";

// Drive the REAL Obsidian Android app via Appium + an Android emulator.
// Heavyweight, not part of standard CI — run via `make test-android` for
// periodic serious testing. Requires a local Android SDK + an AVD named
// "obsidian_test", or override with APPIUM_HOST/APPIUM_PORT to a running
// Appium server. See:
// https://jesse-r-s-hines.github.io/wdio-obsidian-service/wdio-obsidian-service/README#android

const cacheDir = path.resolve(".obsidian-cache");

// Beta builds aren't published for the Android app.
const versions = await parseObsidianVersions(
  env.OBSIDIAN_MOBILE_VERSIONS ?? env.OBSIDIAN_VERSIONS ?? "earliest/earliest latest/latest",
  { cacheDir },
);
if (env.CI) {
  console.log("obsidian-cache-key:", JSON.stringify(versions));
}

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",

  specs: ["./test/specs/**/*.e2e.ts"],

  maxInstances: 1, // appium doesn't parallelize
  hostname: env.APPIUM_HOST || "localhost",
  port: parseInt(env.APPIUM_PORT || "4723"),

  // installerVersion is irrelevant for the mobile app.
  capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion]) => ({
    browserName: "obsidian",
    browserVersion: appVersion,
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:avd": env.ANDROID_AVD || "obsidian_test",
    "appium:noReset": true,
    "appium:adbExecTimeout": 60 * 1000,
    "wdio:obsidianOptions": {
      plugins: ["."],
      vault: "test/vaults/fixtures",
    },
  })),

  services: [
    "obsidian",
    ["appium", { args: { allowInsecure: "*:chromedriver_autodownload,*:adb_shell" } }],
  ],
  reporters: ["obsidian"],

  mochaOpts: { ui: "bdd", timeout: 60 * 1000 },
  waitforInterval: 250,
  waitforTimeout: 5 * 1000,
  logLevel: "warn",

  cacheDir,

  injectGlobals: false,
};
