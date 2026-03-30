"""Compatibility fixtures for beam/1 parser behavior."""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from beam_directory import frames as frame_module
from beam_directory.frames import validate_intent_frame, validate_result_frame
from beam_directory.types import IntentFrame, ResultFrame


FIXTURE_DIR = Path(__file__).resolve().parents[3] / "spec" / "fixtures" / "compatibility"
ARCHIVED_FIXTURE_DIR = FIXTURE_DIR / "releases"


def load_fixture(name: str) -> dict:
    payload = json.loads((FIXTURE_DIR / name).read_text())
    if payload.get("timestamp") == "__NOW__":
        payload["timestamp"] = "2026-03-30T12:00:00.000Z"
    return payload


def load_archived_fixture(release: str, name: str) -> dict:
    return json.loads((ARCHIVED_FIXTURE_DIR / release / name).read_text())


class _FrozenDateTime(datetime):
    frozen: datetime

    @classmethod
    def now(cls, tz=None):
        if tz is None:
            return cls.frozen.replace(tzinfo=None)
        return cls.frozen.astimezone(tz)


@contextmanager
def freeze_frame_clock(timestamp: str):
    _FrozenDateTime.frozen = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(timezone.utc)
    with patch.object(frame_module, "datetime", _FrozenDateTime):
        yield


def test_forward_compatible_intent_fixture_is_accepted():
    fixture = load_fixture("intent-forward-compatible.json")
    frame = IntentFrame.from_dict(fixture)

    assert frame.payload["sku"] == "INV-240"
    with freeze_frame_clock(frame.timestamp):
        assert validate_intent_frame(frame) == []


def test_legacy_params_fixture_maps_to_payload():
    fixture = load_fixture("intent-legacy-params.json")
    frame = IntentFrame.from_dict(fixture)

    assert frame.params == {
        "sku": "INV-240",
        "quantity": 240,
        "shipTo": "Mannheim, DE",
    }
    assert frame.to_dict()["payload"] == frame.params
    with freeze_frame_clock(frame.timestamp):
        assert validate_intent_frame(frame) == []


def test_forward_compatible_result_fixture_is_accepted():
    fixture = load_fixture("result-forward-compatible.json")
    frame = ResultFrame.from_dict(fixture)

    assert frame.payload["totalPriceEur"] == 44160
    assert validate_result_frame(frame) == []


def test_archived_v0_6_0_intent_fixture_validates_with_signature():
    fixture = load_archived_fixture("v0.6.0", "intent-forward-compatible.json")
    frame = IntentFrame.from_dict(fixture["frame"])

    with freeze_frame_clock(fixture["frame"]["timestamp"]):
        assert validate_intent_frame(frame, fixture["signedBy"]["publicKeyBase64"]) == []


def test_archived_v0_6_0_result_fixture_validates_with_signature():
    fixture = load_archived_fixture("v0.6.0", "result-forward-compatible.json")
    frame = ResultFrame.from_dict(fixture["frame"])

    assert frame.payload["totalPriceEur"] == 44160
    assert validate_result_frame(frame, fixture["signedBy"]["publicKeyBase64"]) == []


def test_archived_v0_6_1_async_intent_fixture_validates_with_signature():
    fixture = load_archived_fixture("v0.6.1", "intent-async-preflight.json")
    frame = IntentFrame.from_dict(fixture["frame"])

    with freeze_frame_clock(fixture["frame"]["timestamp"]):
        assert validate_intent_frame(frame, fixture["signedBy"]["publicKeyBase64"]) == []


def test_archived_v0_6_1_async_result_fixture_validates_with_signature():
    fixture = load_archived_fixture("v0.6.1", "result-async-accepted.json")
    frame = ResultFrame.from_dict(fixture["frame"])

    assert frame.payload["acknowledgement"] == "accepted"
    assert frame.payload["terminal"] is False
    assert validate_result_frame(frame, fixture["signedBy"]["publicKeyBase64"]) == []
