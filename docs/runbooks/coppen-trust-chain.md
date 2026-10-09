# COPPEN trust chain: steps for Tobias

This connects `jarvis`, `clara` and `fischer` at `coppen.beam.directory` to Tobias Kub as the responsible person, with a mandate signed by Tobias. After it, the public check shows a person and what each agent may do, instead of "what this agent may do is not set".

Only Tobias runs the write step (`--apply`). Tobias's private key is made on his own computer, stays in one file there, and signs there. It is never printed, sent, mailed or committed. The directory only ever sees the public key and the signatures.

## What gets set

| | Value |
| --- | --- |
| Organization | `coppen` (domain `coppen.de`, already verified) |
| Responsible person | Tobias Kub, `tobias@coppen.de`, role `Geschäftsführer` |
| Agents | `jarvis@`, `clara@`, `fischer@coppen.beam.directory` |
| Each agent may | `read`, `schedule.commit` (confirm appointments), `file.send` (send files) |
| Each agent may not | `order`. That is the scope for placing orders and submitting payments. The script refuses it. |
| Mandate validity | 90 days. Expires at 00:00 UTC, 90 days after the day you run `--apply`. |

Config: `scripts/production/coppen-trust-chain.config.json`. Script: `scripts/production/coppen-trust-chain.mjs`.

## Before you start

- The PR with this runbook is merged. No directory deploy is needed: production runs directory 1.8.0, which has every route the script calls.
- Node.js 20 or newer (`node -v`). No `npm install` is needed; the script uses only Node built-ins.
- The COPPEN org API key (`beam_org_…`), or the claim file `claim-organization.mjs` saved for `coppen`.
- An email address with operator or admin rights in the production directory, for the KYC step.

## Steps

All commands run in a terminal on your Mac, in the repository folder.

### 1. Get the reviewed script

```bash
git clone https://github.com/Beam-directory/beam-protocol.git   # skip if you have it
cd beam-protocol
git checkout main && git pull
```

### 2. Make a private folder outside the repository

```bash
mkdir -p ~/.beam && chmod 700 ~/.beam
```

### 3. Create your person key (only once)

```bash
node scripts/production/coppen-trust-chain.mjs keygen --out ~/.beam/tobias-kub-person-key.json
```

It prints your public key and a fingerprint like `ed25519:0123456789abcdef`. Write the fingerprint down. The file has mode 600 and the script refuses to overwrite it.

Back up this one file offline (password manager or an encrypted USB stick). If it is lost, you can still revoke with the org API key, but a new key means a new KYC review and new mandates.

### 4. Check the config

Open `scripts/production/coppen-trust-chain.config.json` and check the email, the role and the KYC note. The KYC note goes into the audit log under your operator email. It must say what you really checked; see `docs/runbooks/manual-kyc.md`.

If you change anything, edit a copy outside the repository and use that path in the next steps:

```bash
cp scripts/production/coppen-trust-chain.config.json ~/.beam/coppen-trust-chain.json
```

### 5. Put the org API key in a private file

Copy the `beam_org_…` key from your password manager, then:

```bash
(umask 077 && pbpaste > ~/.beam/coppen-org-key.txt)
```

If you have the claim file from `claim-organization.mjs`, you can pass that file instead; the script reads its `apiKey`.

### 6. Dry run against production (reads only)

```bash
node scripts/production/coppen-trust-chain.mjs \
  --config scripts/production/coppen-trust-chain.config.json \
  --key ~/.beam/tobias-kub-person-key.json \
  --org-credential ~/.beam/coppen-org-key.txt
```

This sends only `GET` requests. Every write appears as `WOULD …` with its body. It ends with `DRY RUN finished. No write call was sent.`

Check:

- Step `[1/6]`: `org coppen, domain coppen.de, verified`.
- Step `[2/6]`: whether a person with `tobias@coppen.de` already exists. If one exists with a different key, the script stops. Use that key, or decide to replace it with `--replace-person-key` (KYC goes back to pending).
- Step `[5/6]`: three `WOULD PUT …/responsible-person` and three `WOULD POST …/mandates` with `read, schedule.commit, file.send`.
- Step `[6/6]`: the three agents show `person: null, mandate: null` today, each with `signature valid (pinned key)`.

### 7. Get an operator session (for the KYC step)

```bash
curl -sS -X POST https://api.beam.directory/admin/auth/magic-link \
  -H 'content-type: application/json' \
  -d '{"email":"<your operator email>"}'
```

You get a mail with a link ending in `/auth/callback?token=…`. Do not open the link; it works once. Copy only the part after `token=`, then:

```bash
read -rs "T?token: "    # zsh (macOS default). In bash: read -rsp 'token: ' T
(umask 077 && curl -sS -X POST https://api.beam.directory/admin/auth/verify \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$T\"}" > ~/.beam/admin-session.json)
unset T
```

`~/.beam/admin-session.json` now holds the session token. The script reads its `token`.

### 8. Apply

```bash
node scripts/production/coppen-trust-chain.mjs \
  --config scripts/production/coppen-trust-chain.config.json \
  --key ~/.beam/tobias-kub-person-key.json \
  --org-credential ~/.beam/coppen-org-key.txt \
  --admin-token-file ~/.beam/admin-session.json \
  --apply
```

Order: create the person with your public key, request manual KYC, record the KYC review with your note, then for each agent set you as responsible person and post the mandate signed on your Mac. Then it reads every assertion back and checks its signature against the pinned directory key.

It ends with `DONE: every agent has person and mandate in a verified assertion.` and exit code 0. If it stops on an error, run it again: finished steps show `SKIP`.

### 9. Check in public

- `https://beam.directory/verify?agent=jarvis@coppen.beam.directory` (and `clara`, `fischer`): "Yes, this agent belongs to coppen (coppen.de) and may: read, confirm appointments, send files", plus "On behalf of: Geschäftsführer".
- The new "May not: order or pay." line and the person check text appear once the public site from this PR is deployed.

### 10. Clean up

```bash
rm ~/.beam/admin-session.json ~/.beam/coppen-org-key.txt
```

Keep `~/.beam/tobias-kub-person-key.json` and its offline backup.

## Later

- **Renew.** Run step 8 again within 14 days before the expiry date. Mandates that expire later are skipped; the others get a new one.
- **Revoke one mandate.** Dry run first, then add `--apply`. The mandate id is in the step 8 output (for example `coppen-jarvis-20261010`).

  ```bash
  node scripts/production/coppen-trust-chain.mjs revoke \
    --config scripts/production/coppen-trust-chain.config.json \
    --key ~/.beam/tobias-kub-person-key.json \
    --org-credential ~/.beam/coppen-org-key.txt \
    --agent jarvis@coppen.beam.directory --jti coppen-jarvis-20261010
  ```

- **Re-issue on the same day after a revoke.** The same signed mandate cannot be posted twice (`MANDATE_REPLAY`). Add `--issue-tag r2` to step 8.
- **Change agents or scopes.** Edit the config and run steps 6 and 8. If an agent already has a mandate with other scopes, the script warns and prints the revoke command for the old one.

## What the script never does

- Send a write call without `--apply`.
- Print or send the private key, the org API key, the operator session or a mandate signature.
- Grant `order` (orders, payments).
- Narrow your person rights, or replace your key without `--replace-person-key`.
- Talk to any host other than `https://api.beam.directory` or `localhost`.
