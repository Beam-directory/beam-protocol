"""Compatibility fixtures for beam/1 parser behavior."""

from __future__ import annotations

import json
from pathlib import Path

from beam_directory.frames import validate_intent_frame, validate_result_frame
from beam_directory.types import IntentFrame, ResultFrame


FIXTURE_DIR = Path(__file__).resolve().parents[3] / "spec" / "fixtures" / "compatibility"


def load_fixture(name: str) -> dict:
    payload = json.loads((FIXTURE_DIR / name).read_text())
    if payload.get("timestamp") == "__NOW__":
        payload["timestamp"] = "2026-03-30T12:00:00.000Z"
    return payload


def test_forward_compatible_intent_fixture_is_accepted():
    fixture = load_fixture("intent-forward-compatible.json")
    frame = IntentFrame.from_dict(fixture)

    assert frame.payload["sku"] == "INV-240"
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
    assert validate_intent_frame(frame) == []


def test_forward_compatible_result_fixture_is_accepted():
    fixture = load_fixture("result-forward-compatible.json")
    frame = ResultFrame.from_dict(fixture)

    assert frame.payload["totalPriceEur"] == 44160
    assert validate_result_frame(frame) == []
