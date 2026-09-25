// GET /api  — health check for the mail relay.
module.exports = (req, res) => {
  const provider = process.env.RESEND_API_KEY
    ? "resend"
    : (process.env.MAIL_USERNAME && process.env.MAIL_PASSWORD ? "gmail" : "none");
  const auth = /^(1|true|yes)$/i.test(process.env.REQUIRE_OIDC || "")
    ? "oidc-required"
    : (process.env.RELAY_TOKEN ? "relay-token" : "open");
  res.status(200).json({
    service: "issue2pr-mail-relay",
    ok: true,
    provider,
    configured: provider !== "none",
    auth,
    rate_limit: Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
    endpoint: "POST /api/send",
  });
};
