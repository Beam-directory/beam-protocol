from urllib.parse import parse_qs, urlparse

import pytest

from beam_directory.client import BeamClient
from beam_directory.frames import create_result_frame, validate_result_frame
from beam_directory.identity import BeamIdentity
from beam_directory.types import AgentRecord, IntentFrame


def test_agent_record_preserves_one_time_api_key() -> None:
    record = AgentRecord.from_dict({
        "beamId": "receiver@acme.beam.directory",
        "displayName": "Receiver",
        "capabilities": ["agent.ping"],
        "publicKey": "public-key",
        "apiKey": "bk_receiver.secret",
    })

    assert record.api_key == "bk_receiver.secret"


@pytest.mark.asyncio
async def test_register_adopts_api_key_for_authenticated_transports(monkeypatch: pytest.MonkeyPatch) -> None:
    identity = BeamIdentity.generate("receiver", "acme")
    client = BeamClient(identity=identity, directory_url="https://api.beam.directory")
    record = AgentRecord(
        beam_id=identity.beam_id,
        display_name="Receiver",
        capabilities=["agent.ping"],
        public_key=identity.public_key_base64,
        api_key="bk_receiver.secret",
    )

    async def fake_register(_registration):  # type: ignore[no-untyped-def]
        return record

    monkeypatch.setattr(client.directory, "register", fake_register)

    registered = await client.register("Receiver", ["agent.ping"])

    assert registered.api_key == "bk_receiver.secret"
    assert client.api_key == "bk_receiver.secret"
    assert client._request_headers()["Authorization"] == "Bearer bk_receiver.secret"
    parsed = urlparse(client._websocket_url("bwt_test_ticket"))
    assert parsed.scheme == "wss"
    assert parse_qs(parsed.query) == {
        "beamId": [identity.beam_id],
        "ticket": ["bwt_test_ticket"],
    }


@pytest.mark.asyncio
async def test_websocket_ticket_is_requested_with_api_key_and_validated(monkeypatch: pytest.MonkeyPatch) -> None:
    identity = BeamIdentity.generate("receiver", "acme")
    client = BeamClient(
        identity=identity,
        directory_url="https://api.beam.directory",
        api_key="bk_receiver.secret",
    )
    calls = []

    async def fake_request(method, path, **_kwargs):  # type: ignore[no-untyped-def]
        calls.append((method, path, client._request_headers()))
        return {"ticket": "bwt_short_lived"}

    monkeypatch.setattr(client, "_request", fake_request)

    assert await client._request_websocket_ticket() == "bwt_short_lived"
    assert calls == [(
        "POST",
        f"/agents/{identity.beam_id}/ws-ticket",
        {"Content-Type": "application/json", "Authorization": "Bearer bk_receiver.secret"},
    )]


@pytest.mark.asyncio
async def test_websocket_listening_fails_closed_without_api_key() -> None:
    identity = BeamIdentity.generate("receiver", "acme")
    client = BeamClient(identity=identity, directory_url="https://api.beam.directory")

    with pytest.raises(RuntimeError, match="requires the agent API key"):
        await client.connect()


@pytest.mark.asyncio
async def test_intent_handler_result_is_signed_by_authenticated_responder() -> None:
    identity = BeamIdentity.generate("receiver", "acme")
    client = BeamClient(identity=identity, directory_url="https://api.beam.directory")
    intent = IntentFrame(
        v="1",
        intent="agent.ping",
        from_id="sender@partner.beam.directory",
        to_id=identity.beam_id,
        params={"message": "hello"},
        nonce="security-test-nonce",
        timestamp="2026-08-23T08:00:00.000Z",
    )

    @client.on_intent("agent.ping")
    async def handler(frame: IntentFrame):
        return create_result_frame(
            success=True,
            nonce=frame.nonce,
            payload={"ok": True},
        )

    result = await client.handle_intent(intent)

    assert result.signature
    assert validate_result_frame(result, identity.public_key_base64) == []
