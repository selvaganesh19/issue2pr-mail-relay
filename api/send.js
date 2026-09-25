// POST /api/send — central mail relay for the Issue2PR agent workflow.
//
// Sender credentials live ONLY in this deployment's environment, so caller
// repos need no mail secrets of their own.
//
// AUTH (layered; strongest available wins, each optional):
//   1. GitHub OIDC — caller sends `Authorization: Bearer <id-token>`, verified
//      against GitHub's JWKS. Yields a TRUSTED repo/owner/actor, no shared
//      secret. Require it with REQUIRE_OIDC=1.
//   2. RELAY_TOKEN — shared token via `X-Relay-Token`, used only when no OIDC.
//      Travels in caller config, so a speed-bump, not a real secret.
//   3. Open — if neither REQUIRE_OIDC nor RELAY_TOKEN is set.
//
// RATE LIMIT (optional): set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//   to cap sends per repo per UTC day (RATE_LIMIT_PER_DAY, default 50).
//
// PROVIDER (pick one; Resend preferred for public / own-domain sending):
//   - Resend: RESEND_API_KEY + MAIL_FROM
//   - Gmail : MAIL_USERNAME + MAIL_PASSWORD (App Password)  [fallback]

const nodemailer = require("nodemailer");

const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = OIDC_ISSUER + "/.well-known/jwks";

// Remote JWKS, cached across warm invocations.
let _jwks = null;

function clamp(v, n) {
  const s = v == null ? "" : String(v);
  return s.length > n ? s.slice(0, n) : s;
}

// Verify a GitHub Actions OIDC token. Returns trusted claims or throws.
async function verifyOidc(token) {
  const { jwtVerify, createRemoteJWKSet } = await import("jose");
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(JWKS_URL));
  const audience = process.env.OIDC_AUDIENCE || "issue2pr-mail-relay";
  const { payload } = await jwtVerify(token, _jwks, { issuer: OIDC_ISSUER, audience });

  const allowed = (process.env.OIDC_ALLOWED_OWNERS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length) {
    const owner = String(payload.repository_owner || "").toLowerCase();
    if (!allowed.includes(owner)) {
      const e = new Error("owner '" + owner + "' not in allowlist");
      e.code = "owner_not_allowed";
      throw e;
    }
  }
  return {
    repository: payload.repository,
    repository_owner: payload.repository_owner,
    actor: payload.actor,
    sub: payload.sub,
  };
}

// Per-repo daily rate limit via Upstash Redis REST. No-op if unconfigured.
async function rateLimit(repoKey) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: true, skipped: "no-store" };
  const limit = Number(process.env.RATE_LIMIT_PER_DAY || 50);
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = "rl:" + repoKey + ":" + day;
  const auth = { headers: { Authorization: "Bearer " + token } };
  const incr = await fetch(url + "/incr/" + encodeURIComponent(key), auth);
  const { result } = await incr.json();
  if (result === 1) {
    // First hit today: expire after 24h so the counter self-cleans.
    await fetch(url + "/expire/" + encodeURIComponent(key) + "/86400", auth);
  }
  return { ok: result <= limit, count: result, limit };
}

// Send via Resend (preferred when RESEND_API_KEY is set) or Gmail SMTP.
async function sendMail({ to, subject, text }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const from = process.env.MAIL_FROM;
    if (!from) throw new Error("RESEND_API_KEY set but MAIL_FROM missing");
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + resendKey, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error("resend " + r.status + ": " + detail.slice(0, 300));
    }
    return { provider: "resend" };
  }
  const user = process.env.SMTP_USER || process.env.MAIL_USERNAME;
  const pass = process.env.SMTP_PASS || process.env.MAIL_PASSWORD;
  // Generic SMTP (SendGrid, Brevo, Mailgun, Gmail, ...). SMTP_HOST wins; the
  // MAIL_USERNAME/MAIL_PASSWORD pair is a Gmail shortcut kept for compatibility.
  const host = process.env.SMTP_HOST || (process.env.MAIL_USERNAME ? "smtp.gmail.com" : "");
  const port = Number(process.env.SMTP_PORT || (process.env.SMTP_HOST ? 587 : 465));
  if (!host || !user || !pass) {
    throw new Error("no mail provider configured (set RESEND_API_KEY+MAIL_FROM, or SMTP_HOST/SMTP_USER/SMTP_PASS[/SMTP_FROM], or MAIL_USERNAME+MAIL_PASSWORD)");
  }
  const from = process.env.SMTP_FROM || process.env.MAIL_FROM || ("Issue2PR Agent <" + user + ">");
  const transport = nodemailer.createTransport({
    host, port, secure: port === 465, auth: { user, pass },
  });
  await transport.sendMail({ from, to, subject, text });
  return { provider: process.env.SMTP_HOST ? "smtp" : "gmail" };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  // ---- Auth (layered) ----
  const authz = req.headers["authorization"] || "";
  const bearer = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  const requireOidc = /^(1|true|yes)$/i.test(process.env.REQUIRE_OIDC || "");
  const relayToken = process.env.RELAY_TOKEN;
  let verified = null;

  if (bearer) {
    try {
      verified = await verifyOidc(bearer);
    } catch (err) {
      res.status(401).json({ error: "OIDC verification failed", detail: clamp(err && err.message || err, 200) });
      return;
    }
  }
  if (!verified) {
    if (requireOidc) {
      res.status(401).json({ error: "OIDC token required (Authorization: Bearer <github-oidc>)" });
      return;
    }
    if (relayToken && req.headers["x-relay-token"] !== relayToken) {
      res.status(401).json({ error: "bad or missing X-Relay-Token" });
      return;
    }
  }

  const body = typeof req.body === "object" && req.body ? req.body : {};
  const to = body.to;
  const repo = clamp(body.repo, 200);
  const outcome = clamp(body.outcome, 40);
  const sha = clamp(body.sha, 64);
  const changed = clamp(body.changed, 12);
  const summary = clamp(body.summary, 4000);

  // ---- Recipient validation ----
  if (!to || typeof to !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    res.status(400).json({ error: "missing or invalid 'to' address" });
    return;
  }
  // GitHub privacy noreply addresses have no MX record; sending only bounces.
  if (/@users\.noreply\.github\.com$/i.test(to)) {
    res.status(200).json({ ok: true, skipped: "github-noreply-undeliverable", to });
    return;
  }

  // ---- Rate limit (keyed on the TRUSTED repo when OIDC verified) ----
  const repoKey = ((verified && verified.repository) || repo || to).toLowerCase();
  try {
    const rl = await rateLimit(repoKey);
    if (!rl.ok) {
      res.status(429).json({ error: "rate limit exceeded", repo: repoKey, count: rl.count, limit: rl.limit });
      return;
    }
  } catch (err) {
    // Fail-open on limiter errors: better to send than hard-block a legit run.
    console.error("rate-limit error (continuing):", err && err.message || err);
  }

  // ---- Build + send ----
  const subject = "Agent run on " + (repo || "your repo") + " — " + (outcome || "done");
  const lines = [
    "Repo:    " + (repo || "(unknown)"),
    "Commit:  " + (sha || "(unknown)"),
    "Outcome: " + (outcome || "(unknown)") + "   (success = finished, failure = hit a limit)",
    "Files changed by agent: " + (changed !== "" ? changed : "(unknown)"),
  ];
  if (verified) lines.push("Verified sender: " + verified.repository + " (actor " + verified.actor + ")");
  lines.push("");
  lines.push(summary ? "Summary:\n" + summary : "If files were changed, a pull request was opened for review.");
  const text = lines.join("\n");

  try {
    const r = await sendMail({ to, subject, text });
    res.status(200).json({ ok: true, provider: r.provider, verified: verified ? verified.repository : null });
  } catch (err) {
    res.status(502).json({ error: "send failed", detail: clamp(err && err.message || err, 300) });
  }
};
