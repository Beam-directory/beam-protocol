# Manual KYC review of a company person

Use this when an organization adds a person who will be responsible for its agents. Beam has no outside KYC provider. The review is a person at Beam checking evidence by hand and recording the result. It is not an ID-document check by a provider, and the public check says so.

## What the review decides

One question: does this person exist, and may they act for this organization? If yes, the operator records `verified`. Only then can the person sign mandates for agents (`POST /agents/:beamId/mandates` returns `KYC_REQUIRED` otherwise).

## Before you start

- The organization's domain is verified (`GET /orgs/:name` shows `verified: true`).
- The person record exists in that organization and has a public key. Check `GET /orgs/:name/people` with the org API key.
- The org has requested the review: `kycStatus` is `pending` and `kycProvider` is `manual` (`POST /orgs/:name/people/:id/kyc` with `{"provider":"manual"}`).
- You have an operator or admin session for the directory.
- If you are the person under review, write that in the note. A second operator should review when one is available.

## Evidence to check

Check all of these. Look at them; do not upload or store copies in Beam.

1. **Company.** A current commercial register extract (Handelsregister, Companies House, or equal). Legal name, register number and seat match the organization.
2. **Authority.** The person is listed there as a legal representative of the company or as holder of Prokura. Otherwise, a signed authorization from someone who is listed.
3. **Identity.** Name on the extract matches the person record. If you do not know the person, confirm by a video call with a photo ID held to the camera, or in person.
4. **Contact.** The person's email is on the verified domain (for COPPEN: `@coppen.de`). Send a mail to it and get a reply.
5. **Key.** The person tells you the key fingerprint on a second channel (call or in person). It must equal the fingerprint of `publicKey` in the person record. The script prints it as `ed25519:…`.

If any point fails, do not verify. Record `rejected` with the reason, or wait.

## What to write in the note

The note is stored in the audit log (`org.person.kyc_reviewed`) with your operator email. It is not public. Write facts, short, no copies of documents, no ID numbers.

Template:

```
Manual KYC. Register: <court> <register no.>, extract dated <date>, lists <name> as <role>.
Identity: <how> on <date>. Email reply from <address> on <date>.
Key fingerprint <ed25519:…> confirmed by <channel>. Reviewer: <your name>.
```

Example:

```
Manual KYC. Register: HRB 68658, extract dated 2026-10-08, lists Tobias Kub as Prokurist (Einzelprokura).
Identity: known in person. Email reply from tobias@coppen.de on 2026-10-09.
Key fingerprint ed25519:0123456789abcdef confirmed by phone. Reviewer: Jane Doe. Self-review, no second operator yet.
```

## Record the result

```
POST /admin/people/<personId>/kyc
Authorization: Bearer <operator session>
{"status": "verified", "note": "<note>"}
```

Use `"rejected"` with the reason if the evidence does not hold. `scripts/production/coppen-trust-chain.mjs` makes this call for COPPEN with the note from its config, only with `--apply`.

## After the review

- `GET /agents/<beamId>/trust-assertion` shows `person.kycStatus: "verified"` once the agent has this person as responsible person.
- If the person's public key changes later, the directory sets KYC back to `pending` and revokes their active mandates. Repeat point 5 and record a new review.
- If the person leaves, the org offboards them (`POST /orgs/:name/people/:id/offboard`). That revokes their mandates and suspends their agents.
