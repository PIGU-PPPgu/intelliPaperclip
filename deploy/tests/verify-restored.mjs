import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

if (process.env.CI !== "true") throw new Error("Restore verification runs only in disposable CI");
const { email, password } = JSON.parse(readFileSync("/tmp/intellipaperclip-ci-auth.json", "utf8"));
const publicUrl = readFileSync(new URL("../.env", import.meta.url), "utf8")
  .match(/^PAPERCLIP_PUBLIC_URL=(.+)$/m)?.[1];
if (!publicUrl) throw new Error("Missing CI public origin");
const origin = new URL(publicUrl).origin;
const base = "http://127.0.0.1:3100";
const headers = { Origin: origin, Host: new URL(origin).host, "Content-Type": "application/json" };

const signin = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers,
  body: JSON.stringify({ email, password }),
  signal: AbortSignal.timeout(30000),
});
assert.equal(signin.status, 200, `Restored sign-in returned HTTP ${signin.status}`);
const cookie = signin.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
assert.ok(cookie, "Restored sign-in returned no session cookie");
const plugins = await fetch(`${base}/api/plugins`, {
  headers: { ...headers, Cookie: cookie },
  signal: AbortSignal.timeout(30000),
});
assert.equal(plugins.status, 200, `Restored plugin list returned HTTP ${plugins.status}`);
const workbench = (await plugins.json()).find((plugin) => plugin.pluginKey === "paperclip.department-workbench");
assert.ok(workbench?.id, "Restored workbench install record is missing");
const health = await fetch(`${base}/api/plugins/${workbench.id}/health`, {
  headers: { ...headers, Cookie: cookie },
  signal: AbortSignal.timeout(30000),
});
assert.equal(health.status, 200);
assert.equal((await health.json()).healthy, true);
console.log(JSON.stringify({ restoredLogin: "pass", restoredWorkbench: "ready" }));
