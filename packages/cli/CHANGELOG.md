# beam-protocol-cli changelog

npm has 1.6.0. 1.7.0 was tagged but never published to npm. This file lists the CLI changes since 1.6.0, taken from `git log v1.6.0.. -- packages/cli`.

The CLI depends on `beam-protocol-sdk` with the same minor version (`^1.8.0` for CLI 1.8.0). Publish the SDK first.

## 1.8.0 (tag v1.8.0, 2026-10-08)

- `beam send` prints "Intent held for approval" with the approval id when the directory answers HTTP 202 `APPROVAL_REQUIRED`. It no longer reports the intent as delivered.
- depends on `beam-protocol-sdk` `^1.8.0`

## 1.7.0 (tag v1.7.0, 2026-10-02, not on npm)

### Breaking
- `beam register` for an organization agent requires `BEAM_ORG_API_KEY` in the environment.

### Changed
- `beam register` stores the one-time agent API key in `.beam/identity.json`. The file is written with mode 0600.
- `browse`, `delegate`, `keys revoke`, `keys rotate`, `profile update`, `report`, `send`, `stats`, `talk`, `verify check` and `verify domain` send that API key.
- depends on `beam-protocol-sdk` `^1.7.0`
