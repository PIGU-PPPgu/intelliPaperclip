import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

if (process.env.CI !== "true") throw new Error("This synthetic admin test runs only in disposable CI");
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const publicUrl = env.match(/^PAPERCLIP_PUBLIC_URL=(.+)$/m)?.[1];
if (!publicUrl) throw new Error("Missing CI public origin");
const origin = new URL(publicUrl).origin;
const api = "http://127.0.0.1:3100";

async function request(label, pathname, method = "GET", body, cookie) {
  const response = await fetch(`${api}${pathname}`, {
    method,
    headers: {
      Origin: origin,
      Host: new URL(origin).host,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, data };
}

const suffix = randomBytes(5).toString("hex");
const email = `paperclip-ci-${suffix}@example.test`;
const password = `Ci-${randomBytes(24).toString("hex")}`;
const signup = await request("sign up", "/api/auth/sign-up/email", "POST", {
  name: "CI Admin",
  email,
  password,
});
const cookie = (signup.response.headers.getSetCookie?.() ?? [])
  .map((value) => value.split(";", 1)[0])
  .join("; ");
assert.ok(cookie, "Sign-up returned no browser session cookie");
const claim = await request("first admin claim", "/api/bootstrap/claim", "POST", undefined, cookie);
assert.equal(claim.data.claimed, true);
await request("authenticated companies", "/api/companies", "GET", undefined, cookie);

const install = await request("workbench install", "/api/plugins/install", "POST", {
  packageName: "/opt/intellipaperclip/plugins/workbench",
  isLocalPath: true,
}, cookie);
assert.equal(install.data.pluginKey, "paperclip.department-workbench");
const health = await request("workbench health", `/api/plugins/${install.data.id}/health`, "GET", undefined, cookie);
assert.equal(health.data.healthy, true);
writeFileSync("/tmp/intellipaperclip-ci-auth.json", JSON.stringify({ email, password }), { mode: 0o600 });
console.log(JSON.stringify({ auth: "pass", adminClaim: "pass", plugin: install.data.pluginKey, pluginHealth: health.data.status }));
