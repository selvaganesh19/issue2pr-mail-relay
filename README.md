# issue2pr-mail-relay

Central mail relay for the [Issue2PR](https://github.com/selvaganesh19/Issues2PR)
agent workflow. The sender credentials live only in this deployment's
environment, so repositories that use the reusable workflow need **no mail
secrets of their own** — they just call this endpoint.

It supports three optional hardening layers so the same relay works both for a
couple of private repos and for open public use:

- **GitHub OIDC auth** — verify the calling workflow cryptographically, no shared secret.
- **Per-repo rate limiting** — cap sends per repo per day (Upstash Redis).
- **Pluggable provider** — Resend (own domain) or Gmail SMTP.

## Endpoints

- `GET  /api`       — health check (reports provider, auth mode, rate-limit state).
- `POST /api/send`  — send a run-result email.

### POST /api/send

JSON body:

| field     | required | meaning                     |
|-----------|----------|-----------------------------|
| `to`      | yes      | recipient email             |
| `repo`    | no       | `owner/name`                |
| `outcome` | no       | agent step outcome          |
| `sha`     | no       | commit SHA                  |
| `changed` | no       | number of files changed     |
| `summary` | no       | free-text run summary       |

Auth headers (see below): `Authorization: Bearer <github-oidc>` and/or
`X-Relay-Token: <token>`.

## Environment variables

All optional except a provider. Set only what you need.

| var | purpose |
|-----|---------|
| `RESEND_API_KEY` + `MAIL_FROM` | **Provider.** Send via Resend from your own verified domain. `MAIL_FROM` e.g. `Issue2PR <agent@yourdomain.com>`. Needs a domain. |
| `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` (+ `SMTP_PORT`, `SMTP_FROM`) | **Provider.** Any SMTP service — SendGrid, Brevo, Mailgun, Gmail. Works with **single-sender verification, no domain required.** Port defaults to 587. `SMTP_FROM` is the verified sender address. |
| `MAIL_USERNAME` + `MAIL_PASSWORD` | **Provider (Gmail shortcut).** Gmail SMTP; `MAIL_PASSWORD` is a Gmail App Password. Used only when `RESEND_API_KEY` and `SMTP_HOST` are unset. |
| `REQUIRE_OIDC` | `1` to **require** a valid GitHub OIDC token on every call. Recommended for public use. |
| `OIDC_AUDIENCE` | Expected `aud` claim. Default `issue2pr-mail-relay` (the workflow requests this audience). |
| `OIDC_ALLOWED_OWNERS` | Optional CSV allowlist of repo owners, e.g. `selvaganesh19,acme`. Empty = any owner with a valid token. |
| `RELAY_TOKEN` | Optional shared token (`X-Relay-Token`). Only checked when a call has no OIDC token. Travels in caller config, so a speed-bump, not a real secret. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Enable per-repo rate limiting. |
| `RATE_LIMIT_PER_DAY` | Max sends per repo per UTC day. Default `50`. |

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fselvaganesh19%2Fissue2pr-mail-relay)

1. Import this repo at https://vercel.com/new. Framework preset: **Other**.
2. Add environment variables (at minimum one provider — see table).
3. Deploy. Your endpoint is `https://<project>.vercel.app/api/send`.
## Recommended setups

**Just you / a few known repos** — simplest:
- Provider: Gmail (`MAIL_USERNAME` + `MAIL_PASSWORD`).
- Auth: leave open, or set `RELAY_TOKEN` and add a matching repo secret.

**Open public use** — hardened:
1. **Provider.** Do not use personal Gmail for a public service; it will get
   rate-limited or suspended.
   - *No domain?* Use **SendGrid** or **Brevo** with **single-sender
     verification** — verify one email address (your existing inbox), no DNS or
     domain needed. Set `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`.
     Their infra owns the sending reputation, so your personal account is not at
     risk. Free tiers: SendGrid ~100/day, Brevo ~300/day.
   - *Have (or willing to buy) a domain?* Use **Resend** with domain DKIM for the
     best deliverability and volume: `RESEND_API_KEY` + `MAIL_FROM`.
2. **Auth = OIDC.** Set `REQUIRE_OIDC=1`. The workflow already mints a GitHub
   OIDC token (audience `issue2pr-mail-relay`) and sends it; the relay verifies
   it against GitHub's JWKS and trusts the `repository`/`actor` claims instead of
   caller-supplied fields. No shared secret, nothing to leak in YAML. Optionally
   restrict with `OIDC_ALLOWED_OWNERS`.
3. **Rate limit.** Create a free Upstash Redis database (upstash.com), copy its
   REST URL + token into `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
   Tune `RATE_LIMIT_PER_DAY`. This caps blast radius per repo.

Callers stay config-free: OIDC needs only `permissions: id-token: write` in the
caller workflow (already set in the reusable workflow and the sample caller) —
no secret to distribute.

## Deploy your own instance (send from YOUR mail)

The relay is open source (MIT). Anyone can run their own copy so run-result
emails are sent **from their own mail identity and sending quota**, not a shared
one. Callers never hold mail secrets either way — the relay owns the sender.

1. **Fork / clone** this repo (or click *Deploy with Vercel* above).
2. **Deploy to Vercel** (Framework preset: Other). See `.env.example` for every
   variable.
3. **Set one provider** in Vercel env (Resend, generic SMTP, or Gmail — see the
   table above). For anything beyond personal testing, authenticate an owned
   domain (below) so mail is not spam-filtered.
4. **(Optional) Harden**: `REQUIRE_OIDC=1` + `OIDC_ALLOWED_OWNERS=<your-user>`,
   plus Upstash rate limiting.
5. **Point your caller at it** — pass `relay_url` in your caller workflow:
   ```yaml
   jobs:
     agent:
       uses: selvaganesh19/Issues2PR/.github/workflows/agent.yml@main
       secrets: inherit
       with:
         notify_email: you@example.com
         relay_url: https://<your-project>.vercel.app/api/send
   ```
   Every run then emails from *your* relay.

### Brevo tips

- SMTP host `smtp-relay.brevo.com`, port `587`. `SMTP_USER` = your Brevo
  **login email**; `SMTP_PASS` = an **SMTP key** (`xsmtpsib-...`, from
  **SMTP & API → SMTP**) — *not* your account password and *not* an API key.
- **Do not send from a freemail `From`** (`@gmail.com`, `@yahoo.com`, …). Under
  the 2024 Gmail/Yahoo/Microsoft rules Brevo cannot DKIM-sign as gmail.com, so
  the mail fails DMARC alignment and is spam-filtered or dropped. Sending to your
  *own* Gmail from your own Gmail is the worst case (looks like spoofing).
- **Authenticate a domain** (cheap, ~$1–3/yr): Brevo → **Senders, Domains &
  Dedicated IPs → Domains → Authenticate a domain**, add the DKIM/DMARC DNS
  records at your registrar, then set `SMTP_FROM=agent@yourdomain`. This is the
  only reliable path to the inbox. The auto-generated `*.brevosend.com` sender is
  **not** stable — Brevo blocks it after a few sends pending validation.
- Free tier ~300 emails/day.

### Upstash Redis (rate limit) tips

- Optional. Without it the relay sends with no per-repo cap.
- Create a free database at upstash.com, copy its **REST URL** + **REST token**
  into `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
- `RATE_LIMIT_PER_DAY` caps sends per repo per UTC day (default 50) — bounds
  blast radius if your relay is public.
- Fails **open**: if Upstash is unreachable the mail still sends, so a limiter
  outage never blocks a legitimate run.

## Notes

- Gmail path uses SMTP over SSL (`smtp.gmail.com:465`).
- Rate limiting fails **open**: if Upstash is unreachable the mail still sends,
  so a limiter outage never blocks a legitimate run.
- Body fields from callers are length-clamped; `from`/`subject` are fixed
  server-side so callers cannot spoof the sender identity.
