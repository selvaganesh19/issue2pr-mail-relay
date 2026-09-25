// GET /api  — health check for the mail relay.
module.exports = (req, res) => {
  res.status(200).json({
    service: "issue2pr-mail-relay",
    ok: true,
    configured: Boolean(process.env.MAIL_USERNAME && process.env.MAIL_PASSWORD),
    endpoint: "POST /api/send",
  });
};
