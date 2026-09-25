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
| `RESEND_API_KEY` + `MAIL_FROM` | **Provider (preferred).** Send via Resend from your own verified domain. `MAIL_FROM` e.g. `Issue2PR <agent@yourdomain.com>`. |
| `MAIL_USERNAME` + `MAIL_PASSWORD` | **Provider (fallback).** Gmail SMTP; `MAIL_PASSWORD` is a Gmail App Password. Used only when `RESEND_API_KEY` is unset. |
| `REQUIRE_OIDC` | `1` to **require** a valid GitHub OIDC token on every call. Recommended for public use. |
| `OIDC_AUDIENCE` | Expected `aud` claim. Default `issue2pr-mail-relay` (the workflow requests this audience). |
| `OIDC_ALLOWED_OWNERS` | Optional CSV allowlist of repo owners, e.g. `selvaganesh19,acme`. Empty = any owner with a valid token. |
| `RELAY_TOKEN` | Optional shared token (`X-Relay-Token`). Only checked when a call has no OIDC token. Travels in caller config, so a speed-bump, not a real secret. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Enable per-repo rate limiting. |
| `RATE_LIMIT_PER_DAY` | Max sends per repo per UTC day. Default `50`. |

## Deploy to Vercel

1. Import this repo at https://vercel.com/new. Framework preset: **Other**.
2. Add environment variables (at minimum one provider — see table).
3. Deploy. Your endpoint is `https://<project>.vercel.app/api/send`.
## Recommended setups

**Just you / a few known repos** — simplest:
- Provider: Gmail (`MAIL_USERNAME` + `MAIL_PASSWORD`).
- Auth: leave open, or set `RELAY_TOKEN` and add a matching repo secret.

**Open public use** — hardened:
1. **Provider = Resend on your own domain.** Do not use personal Gmail for a
   public service; it will get rate-limited or suspended. Sign up at resend.com,
   add your domain, set the SPF/DKIM/DMARC DNS records it gives you, create an
   API key. Set `RESEND_API_KEY` + `MAIL_FROM` (an address at your domain).
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

## Notes

- Gmail path uses SMTP over SSL (`smtp.gmail.com:465`).
- Rate limiting fails **open**: if Upstash is unreachable the mail still sends,
  so a limiter outage never blocks a legitimate run.
- Body fields from callers are length-clamped; `from`/`subject` are fixed
  server-side so callers cannot spoof the sender identity.
