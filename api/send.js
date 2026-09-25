// POST /api/send — central mail relay for the Issue2PR agent workflow.
//
// Any repo using the reusable workflow calls this endpoint. The Gmail
// credentials live ONLY in this Vercel deployment's environment variables, so
// caller repos need no secrets of their own.
//
// Required Vercel env vars:
//   MAIL_USERNAME  - Gmail address used as the sender
//   MAIL_PASSWORD  - Gmail App Password (16-char, requires 2-Step Verification)
// Optional:
//   RELAY_TOKEN    - if set, callers must send a matching X-Relay-Token header.
//                    Keep it lightweight; it only deters casual abuse since the
//                    token travels in public workflow YAML.

const nodemailer = require("nodemailer");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  // Optional shared-token gate.
  const expected = process.env.RELAY_TOKEN;
  if (expected && req.headers["x-relay-token"] !== expected) {
    res.status(401).json({ error: "bad or missing X-Relay-Token" });
    return;
  }

  const body = typeof req.body === "object" && req.body ? req.body : {};
  const { to, repo, outcome, sha, changed, summary } = body;

  // Basic recipient validation.
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    res.status(400).json({ error: "missing or invalid 'to' address" });
    return;
  }

  const user = process.env.MAIL_USERNAME;
  const pass = process.env.MAIL_PASSWORD;
  if (!user || !pass) {
    res.status(500).json({ error: "relay not configured (missing MAIL_USERNAME/MAIL_PASSWORD)" });
    return;
  }

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const subject = `Agent run on ${repo || "your repo"} — ${outcome || "done"}`;
  const text = [
    `Repo:    ${repo || "(unknown)"}`,
    `Commit:  ${sha || "(unknown)"}`,
    `Outcome: ${outcome || "(unknown)"}   (success = finished, failure = hit a limit)`,
    `Files changed by agent: ${changed != null ? changed : "(unknown)"}`,
    ``,
    summary ? `Summary:\n${summary}` : `If files were changed, a pull request was opened for review.`,
  ].join("\n");

  try {
    await transport.sendMail({
      from: `Issue2PR Agent <${user}>`,
      to,
      subject,
      text,
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: "send failed", detail: String(err && err.message || err) });
  }
};
