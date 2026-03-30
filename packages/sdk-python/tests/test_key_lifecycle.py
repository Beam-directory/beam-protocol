import json

import pytest

from beam_directory.client import BeamClient, _canonicalize_json
from beam_directory.identity import BeamIdentity


@pytest.mark.asyncio
async def test_rotate_keys_signs_canonical_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    current_identity = BeamIdentity.generate("rotator", "acme")
    next_identity = BeamIdentity.generate("rotator", "acme")
    client = BeamClient(identity=current_identity, directory_url="https://api.beam.directory")
    captured: dict[str, object] = {}

    async def fake_request(method: str, path: str, *, params=None, json=None):  # type: ignore[no-untyped-def]
        captured["method"] = method
        captured["path"] = path
        captured["json"] = json
        return {
            "beamId": current_identity.beam_id,
            "publicKey": next_identity.public_key_base64,
            "keyState": {
                "active": {
                    "beamId": current_identity.beam_id,
                    "publicKey": next_identity.public_key_base64,
                    "createdAt": 1,
                    "revokedAt": None,
                    "status": "active",
                },
                "revoked": [],
                "keys": [],
                "total": 1,
            },
        }

    monkeypatch.setattr(client, "_request", fake_request)

    result = await client.rotate_keys(next_identity)

    payload = captured["json"]
    assert isinstance(payload, dict)
    assert payload["new_public_key"] == next_identity.public_key_base64
    assert BeamIdentity.verify(
        _canonicalize_json(
            {
                "action": "keys.rotate",
                "beamId": current_identity.beam_id,
                "newPublicKey": next_identity.public_key_base64,
                "timestamp": payload["timestamp"],
            }
        ),
        str(payload["signature"]),
        current_identity.public_key_base64,
    )
    assert result.key_state is not None
    assert result.key_state.active is not None
    assert result.key_state.active.public_key == next_identity.public_key_base64


@pytest.mark.asyncio
async def test_list_and_revoke_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    identity = BeamIdentity.generate("guardian", "acme")
    retired_identity = BeamIdentity.generate("guardian", "acme")
    client = BeamClient(identity=identity, directory_url="https://api.beam.directory")
    responses = iter(
        [
            {
                "keyState": {
                    "active": {
                        "beamId": identity.beam_id,
                        "publicKey": identity.public_key_base64,
                        "createdAt": 1,
                        "revokedAt": None,
                        "status": "active",
                    },
                    "revoked": [
                        {
                            "beamId": identity.beam_id,
                            "publicKey": retired_identity.public_key_base64,
                            "createdAt": 0,
                            "revokedAt": 2,
                            "status": "revoked",
                        }
                    ],
                    "keys": [],
                    "total": 2,
                }
            },
            {
                "beamId": identity.beam_id,
                "revoked": True,
                "revokedKey": {
                    "beamId": identity.beam_id,
                    "publicKey": retired_identity.public_key_base64,
                    "createdAt": 0,
                    "revokedAt": 2,
                    "status": "revoked",
                },
                "keyState": {
                    "active": {
                        "beamId": identity.beam_id,
                        "publicKey": identity.public_key_base64,
                        "createdAt": 1,
                        "revokedAt": None,
                        "status": "active",
                    },
                    "revoked": [
                        {
                            "beamId": identity.beam_id,
                            "publicKey": retired_identity.public_key_base64,
                            "createdAt": 0,
                            "revokedAt": 2,
                            "status": "revoked",
                        }
                    ],
                    "keys": [],
                    "total": 2,
                },
            },
        ]
    )
    captured: list[dict[str, object]] = []

    async def fake_request(method: str, path: str, *, params=None, json=None):  # type: ignore[no-untyped-def]
        captured.append({"method": method, "path": path, "json": json})
        return next(responses)

    monkeypatch.setattr(client, "_request", fake_request)

    key_state = await client.list_keys()
    result = await client.revoke_key(retired_identity.public_key_base64)

    assert key_state.revoked[0].public_key == retired_identity.public_key_base64
    revoke_payload = captured[1]["json"]
    assert isinstance(revoke_payload, dict)
    assert BeamIdentity.verify(
        _canonicalize_json(
            {
                "action": "keys.revoke",
                "beamId": identity.beam_id,
                "publicKey": retired_identity.public_key_base64,
                "timestamp": revoke_payload["timestamp"],
            }
        ),
        str(revoke_payload["signature"]),
        identity.public_key_base64,
    )
    assert result.revoked is True
    assert result.revoked_key is not None
    assert result.revoked_key.public_key == retired_identity.public_key_base64
