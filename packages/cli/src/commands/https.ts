import { parseArgs } from "node:util";
import { certFiles, commandExists, disableHttps, httpsEnabled, loadConfig, mkcertInstallFix, setupHttps } from "@dx/core";
import { findDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, info, ok, tildify, warn } from "../ui.js";

export const httpsCommand: Command = {
  name: "https",
  summary: "Serve https://shop.localhost with a certificate your browsers trust (opt-in)",
  usage: [
    "dx https           turn it on: trust a local certificate authority (asks once), make the certificate",
    "dx https --status  whether it's on, and where the certificate is",
    "dx https --off     turn it off (http://shop.localhost keeps working)",
    "",
    "Uses mkcert (install: " + mkcertInstallFix() + ").",
    "Needed for things browsers allow only on https: secure cookies, service workers, OAuth callbacks.",
  ].join("\n"),
  async run(argv) {
    const { values } = parseArgs({ args: argv, options: { off: { type: "boolean" }, status: { type: "boolean" } } });
    if (values.off) {
      disableHttps();
      ok("Local HTTPS is off. Restart the dashboard to apply: dx ui --stop, then dx ui");
      return;
    }
    if (values.status) {
      const on = httpsEnabled();
      const mkcert = await commandExists("mkcert");
      console.log(`${on ? c.green("on") : c.dim("off")}${on ? `, certificate in ${tildify(certFiles().cert)}` : ""}`);
      const dash = await findDashboard();
      const port = dash?.info.httpsPort;
      if (on && dash) port ? info(`Served on port ${port}: https://dx.localhost${port === 443 ? "" : `:${port}`}`) : warn("The running dashboard isn't serving https yet: dx ui --stop, then dx ui");
      if (!mkcert) warn(`mkcert isn't installed: ${mkcertInstallFix()}`);
      return;
    }
    console.log(c.dim("Setting up local HTTPS. Your system may ask to trust a new certificate authority: that's mkcert's, and it stays on this computer.\n"));
    const r = await setupHttps();
    for (const s of r.steps) (s.ok ? ok : warn)(`${s.name}${s.detail ? `: ${s.detail}` : ""}`);
    if (!r.ok) {
      if (r.fix) console.log(`\n${c.bold("To fix:")} ${r.fix}`);
      return 1;
    }
    const port = loadConfig().httpsPort;
    console.log(`\nRestart the dashboard to serve https: ${c.cyan("dx ui --stop")}, then ${c.cyan("dx ui")}. Then: https://dx.localhost${port && port !== 443 ? `:${port}` : ""}`);
  },
};
