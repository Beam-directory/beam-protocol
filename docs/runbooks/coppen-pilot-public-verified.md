# COPPEN pilot: make one agent public and verified

Prepared on 2 October 2026. Do not run the write steps until PR #209 is merged and the directory plus beam.directory are deployed. This runbook does not change production by itself.

## Recommendation

Use `coppen-assistant@coppen.beam.directory`. Do not create a second agent, and do not switch the „Beispiel prüfen“ link to `jarvis@coppen.beam.directory` or `clara@coppen.beam.directory`.

A read-only check of `https://api.beam.directory` on 2 October 2026 showed:

| Field | `coppen-assistant@coppen.beam.directory` | `jarvis` / `clara` |
| --- | --- | --- |
| Org | `coppen` | `coppen` |
| Personal | no | no |
| Visibility | **unlisted** | public |
| Tier | **business** | basic |
| Verified | **yes** | no |
| Domain check | **`coppen.de`, status `verified`** (23 Aug 2026) | not started |
| Business check | **COPPEN GmbH, DE, HRB 68658, status `verified`** (23 Aug 2026) | none |
| In public search | no, because it is unlisted | yes, but not a verified company seal |

`coppen.beam.directory` is the Beam namespace. The domain proof that matters for the seal is `coppen.de`, and that proof is already stored. No new DNS record is required unless someone starts a fresh domain challenge.

`GET /agents/coppen-assistant@coppen.beam.directory/seal.svg` is 404 in production today because that route ships in PR #209 and is not deployed. After deploy it stays 404 until visibility is `public`.

## What is already done

- Organization namespace `coppen` exists. The agent is already registered in it.
- Domain control for `coppen.de` is already `verified`.
- Handelsregister review is already `verified` for COPPEN GmbH, HRB 68658.
- Verification tier is already `business`, `verified` is set, and the agent is not flagged or personal.

## What is still missing

Set `visibility` from `unlisted` to `public` after this PR is deployed. That is the only write. The public seal requires all of: `visibility=public`, not personal, not flagged, org present, and tier `verified`, `business`, or `enterprise` (or `verified=1`). This agent already meets every condition except visibility.

## Who does which step

1. **Tobias, or another directory admin.** Decides that this agent may appear in the public directory. Signs in to the operator dashboard so the browser holds an admin session. The dashboard has no “make public” button, so the visibility change is the API call below, with that session’s bearer token or `beam_admin_session` cookie.
2. **Whoever holds the agent API key** (`bk_…` for this Beam ID) can make the same visibility call instead of an admin. Do not rotate or copy that key into chat, email, or this file.
3. **DNS / COPPEN.** No action if the existing `coppen.de` check stays `verified`. A new `POST /agents/:beamId/verify/domain` would mint a new token and must not be done for this pilot.
4. **No one** runs payment, sends mail, or edits production secrets as part of this runbook.

## Data to have in hand

- Beam ID: `coppen-assistant@coppen.beam.directory`
- Display name already stored: `COPPEN Collaboration Assistant`
- Org: `coppen`
- Domain: `coppen.de`
- Register: country `DE`, number `HRB 68658`, legal name `COPPEN GmbH`
- Desired visibility: `public`
- Desired tier: leave `business` (do not downgrade)

Do not record the DNS challenge token. Production currently returns it from `GET /agents/:beamId/domain-status` for this unlisted agent. PR #209 stops that for anyone who is not the owner or a directory admin.

## Steps after deploy

Base URL: `https://api.beam.directory`. Replace `<admin-session>` with the bearer token from the signed-in admin session. Do not commit it.

1. Confirm the deployed directory is the PR #209 build (the seal route exists and an anonymous lookup of an unlisted id returns 404).
2. Publish the agent:

```text
PATCH /agents/coppen-assistant%40coppen.beam.directory/visibility
Authorization: Bearer <admin-session>
Content-Type: application/json

{"visibility":"public"}
```

An agent API key may send `x-api-key` instead of the admin bearer token. The body stays the same. No signature is required for an admin session or the matching agent key.

3. Do not call `POST /agents/:beamId/verify/domain`, `POST /orgs/coppen/verify`, or `POST /agents/:beamId/business-review` again. Those checks are already verified. Repeating domain verification would demand a new TXT record at `_beam-verify.coppen.de`.

## How to verify afterwards

All of these are anonymous GETs:

- `GET /agents/coppen-assistant%40coppen.beam.directory` returns 200, `visibility` is `public`, `verification_tier` is `business`, and the body has no `email`.
- `GET /agents/coppen-assistant%40coppen.beam.directory/domain-status` returns `domain` `coppen.de`, `status` `verified`, and `dnsRecord` is null. The challenge token must not appear.
- `GET /agents/coppen-assistant%40coppen.beam.directory/business-status` returns legal name `COPPEN GmbH`, `HRB 68658`, and status `verified`.
- `GET /agents/coppen-assistant%40coppen.beam.directory/seal.svg` returns `image/svg+xml` and does not contain an email address.
- `GET /agents/search?org=coppen&limit=20` includes this Beam ID.
- `https://beam.directory/agents/coppen-assistant%40coppen.beam.directory` shows the seal, „Diesen Agenten prüfen“, and the embed snippet.
- `https://beam.directory/` „Beispiel prüfen“ opens that same profile.

`jarvis@coppen.beam.directory` and `clara@coppen.beam.directory` can stay public. They are not the verified company seal.
