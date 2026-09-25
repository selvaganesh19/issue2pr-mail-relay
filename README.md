# issue2pr-mail-relay

Central mail relay for the [Issue2PR](https://github.com/selvaganesh19/Issues2PR)
agent workflow. The Gmail sender credentials live only in this deployment's
environment, so repositories that use the reusable workflow need **no mail
secrets of their own** — they just call this endpoint.

## Endpoints

- `GET  /api`       — health check (reports whether creds are configured).
- `POST /api/send`  — send a run-result email.

### POST /api/send

JSON body:

| field     | required | meaning                                  |
|-----------|----------|------------------------------------------|
| `to`      | yes      | recipient email (the pusher)             |
| `repo`    | no       | `owner/name`                             |
| `outcome` | no       | agent step outcome                       |
| `sha`     | no       | commit SHA                               |
| `changed` | no       | number of files changed                  |
| `summary` | no       | free-text run summary                    |

Header `X-Relay-Token` is required only if the deployment sets `RELAY_TOKEN`.

## Deploy to Vercel

1. Import this repo at https://vercel.com/new.
2. Framework preset: **Other** (no build step needed).
3. Add Environment Variables:
   - `MAIL_USERNAME` — your Gmail address (the sender).
   - `MAIL_PASSWORD` — a Gmail **App Password** (needs 2-Step Verification).
   - `RELAY_TOKEN` — *(optional)* a shared token to reduce casual abuse.
4. Deploy. Your endpoint is `https://<project>.vercel.app/api/send`.

## Notes

- Uses Gmail SMTP over SSL (`smtp.gmail.com:465`).
- `RELAY_TOKEN`, if set, travels in public workflow YAML, so treat it as a
  speed-bump against bots, not a real secret. For stronger protection put the
  relay behind an allowlist or a per-install token issued by a server.
