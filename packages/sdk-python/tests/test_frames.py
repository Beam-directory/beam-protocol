"""Tests for IntentFrame and ResultFrame creation and validation."""

import json
import time

import pytest
from beam_directory.frames import (
    MAX_FRAME_SIZE,
    REPLAY_WINDOW_MS,
    create_intent_frame,
    create_result_frame,
    validate_intent_frame,
    validate_result_frame,
)
from beam_directory.identity import BeamIdentity


@pytest.fixture
def identity():
    return BeamIdentity.generate("sender", "testorg")


@pytest.fixture
def recipient_id():
    return "recipient@other.beam.directory"


class TestCreateIntentFrame:
    def test_creates_valid_frame(self, identity, recipient_id):
        frame = create_intent_frame(
            intent="query",
            from_id=identity.beam_id,
            to_id=recipient_id,
            params={"q": "hello"},
            identity=identity,
        )
        assert frame.v == "1"
        assert frame.intent == "query"
        assert frame.from_id == identity.beam_id
        assert frame.to_id == recipient_id
        assert frame.params == {"q": "hello"}
        assert frame.nonce
        assert frame.timestamp
        assert frame.signature

    def test_creates_unsigned_frame_without_identity(self, identity, recipient_id):
        frame = create_intent_frame(
            intent="ping",
            from_id=identity.beam_id,
            to_id=recipient_id,
        )
        assert frame.signature is None

    def test_signature_verifies(self, identity, recipient_id):
        frame = create_intent_frame(
            intent="greet",
            from_id=identity.beam_id,
            to_id=recipient_id,
            identity=identity,
        )
        errors = validate_intent_frame(frame, identity.public_key_base64)
        assert not errors

    def test_to_dict_has_correct_keys(self, identity, recipient_id):
        frame = create_intent_frame("test", identity.beam_id, recipient_id)
        d = frame.to_dict()
        assert "v" in d
        assert "intent" in d
        assert "from" in d
        assert "to" in d
        assert "payload" in d
        assert "params" not in d
        assert "nonce" in d
        assert "timestamp" in d

    def test_to_dict_uses_payload_wire_format_for_signature(self, identity, recipient_id):
        frame = create_intent_frame(
            intent="greet",
            from_id=identity.beam_id,
            to_id=recipient_id,
            params={"message": "hello"},
            identity=identity,
        )

        signed_payload = json.dumps(
            {
                "type": "intent",
                "from": frame.from_id,
                "to": frame.to_id,
                "intent": frame.intent,
                "payload": frame.params,
                "timestamp": frame.timestamp,
                "nonce": frame.nonce,
            },
            separators=(",", ":"),
        )

        assert BeamIdentity.verify(signed_payload, frame.signature, identity.public_key_base64)

    def test_from_dict_accepts_payload_key(self, recipient_id):
        identity = BeamIdentity.generate("sender", "testorg")
        frame = create_intent_frame(
            intent="query",
            from_id=identity.beam_id,
            to_id=recipient_id,
            params={"q": "hello"},
        )

        restored = type(frame).from_dict(
            {
                "v": frame.v,
                "intent": frame.intent,
                "from": frame.from_id,
                "to": frame.to_id,
                "payload": {"q": "hello"},
                "nonce": frame.nonce,
                "timestamp": frame.timestamp,
            }
        )

        assert restored.params == {"q": "hello"}


class TestCreateResultFrame:
    def test_creates_success_frame(self):
        frame = create_result_frame(
            success=True,
            nonce="test-nonce",
            payload={"answer": 42},
        )
        assert frame.v == "1"
        assert frame.success is True
        assert frame.nonce == "test-nonce"
        assert frame.payload == {"answer": 42}
        assert frame.error is None

    def test_creates_error_frame(self):
        frame = create_result_frame(
            success=False,
            nonce="test-nonce",
            error="Something went wrong",
            error_code="INTERNAL_ERROR",
        )
        assert frame.success is False
        assert frame.error == "Something went wrong"
        assert frame.error_code == "INTERNAL_ERROR"

    def test_includes_latency(self):
        frame = create_result_frame(success=True, nonce="n", latency=42)
        assert frame.latency == 42


class TestValidateIntentFrame:
    def setup_method(self):
        self.identity = BeamIdentity.generate("sender", "org")
        self.frame = create_intent_frame(
            intent="test",
            from_id=self.identity.beam_id,
            to_id="recv@other.beam.directory",
            identity=self.identity,
        )

    def test_valid_frame_has_no_errors(self):
        errors = validate_intent_frame(self.frame, self.identity.public_key_base64)
        assert errors == []

    def test_wrong_version_fails(self):
        self.frame.v = "99"
        errors = validate_intent_frame(self.frame)
        assert any("version" in e for e in errors)

    def test_missing_intent_fails(self):
        self.frame.intent = ""
        errors = validate_intent_frame(self.frame)
        assert any("intent" in e for e in errors)

    def test_invalid_from_id_fails(self):
        self.frame.from_id = "not-a-beam-id"
        errors = validate_intent_frame(self.frame)
        assert any("from_id" in e for e in errors)

    def test_invalid_to_id_fails(self):
        self.frame.to_id = "bad-id"
        errors = validate_intent_frame(self.frame)
        assert any("to_id" in e for e in errors)

    def test_expired_timestamp_fails(self):
        self.frame.timestamp = "2020-01-01T00:00:00Z"
        errors = validate_intent_frame(self.frame)
        assert any("replay" in e.lower() for e in errors)

    def test_bad_signature_fails(self):
        self.frame.signature = "invalidsignature=="
        errors = validate_intent_frame(self.frame, self.identity.public_key_base64)
        assert any("signature" in e.lower() for e in errors)


class TestValidateResultFrame:
    def test_valid_success_frame(self):
        frame = create_result_frame(True, "nonce-123")
        assert validate_result_frame(frame) == []

    def test_valid_error_frame(self):
        frame = create_result_frame(False, "nonce-123", error="oops")
        assert validate_result_frame(frame) == []

    def test_error_frame_without_message_fails(self):
        frame = create_result_frame(False, "nonce-123")
        errors = validate_result_frame(frame)
        assert errors  # must have error message

    def test_missing_nonce_fails(self):
        frame = create_result_frame(True, "")
        errors = validate_result_frame(frame)
        assert any("nonce" in e for e in errors)
