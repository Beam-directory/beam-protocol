"""Intent and Result frame creation and validation for the Beam Protocol."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from .identity import BeamIdentity
from .types import BeamIdString, IntentFrame, ResultFrame

MAX_FRAME_SIZE = 1024        # bytes
REPLAY_WINDOW_MS = 300_000  # 5 minutes


def _canonical_json(data: dict[str, Any]) -> str:
    """Produce deterministic JSON (sorted keys, no spaces)."""
    return json.dumps(data, sort_keys=True, separators=(",", ":"))


def _intent_signature_payload(
    *,
    from_id: BeamIdString,
    to_id: BeamIdString,
    intent: str,
    payload: dict[str, Any],
    timestamp: str,
    nonce: str,
) -> str:
    """Match the TypeScript SDK's on-wire signature payload exactly."""
    return json.dumps(
        {
            "type": "intent",
            "from": from_id,
            "to": to_id,
            "intent": intent,
            "payload": payload,
            "timestamp": timestamp,
            "nonce": nonce,
        },
        separators=(",", ":"),
    )


def create_intent_frame(
    intent: str,
    from_id: BeamIdString,
    to_id: BeamIdString,
    params: Optional[dict[str, Any]] = None,
    identity: Optional[BeamIdentity] = None,
) -> IntentFrame:
    """
    Create a signed IntentFrame.

    If *identity* is provided, the frame is signed. Signature covers a
    canonical JSON serialisation of all fields except *signature* itself.
    """
    frame = IntentFrame(
        v="1",
        intent=intent,
        from_id=from_id,
        to_id=to_id,
        params=params or {},
        nonce=BeamIdentity.generate_nonce(),
        timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    )

    if identity is not None:
        frame.signature = identity.sign(
            _intent_signature_payload(
                from_id=frame.from_id,
                to_id=frame.to_id,
                intent=frame.intent,
                payload=frame.params,
                timestamp=frame.timestamp,
                nonce=frame.nonce,
            )
        )

    return frame


def create_result_frame(
    success: bool,
    nonce: str,
    payload: Optional[dict[str, Any]] = None,
    error: Optional[str] = None,
    error_code: Optional[str] = None,
    latency: Optional[int] = None,
    identity: Optional[BeamIdentity] = None,
) -> ResultFrame:
    """Create a ResultFrame (optionally signed)."""
    frame = ResultFrame(
        v="1",
        success=success,
        nonce=nonce,
        timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        payload=payload,
        error=error,
        error_code=error_code,
        latency=latency,
    )

    if identity is not None:
        canonical = _canonical_json(frame.to_dict())
        frame.signature = identity.sign(canonical)

    return frame


def validate_intent_frame(
    frame: IntentFrame,
    public_key_base64: Optional[str] = None,
) -> list[str]:
    """
    Validate an IntentFrame. Returns a list of error strings (empty = valid).

    If *public_key_base64* is given, also verifies the signature.
    """
    errors: list[str] = []

    if frame.v != "1":
        errors.append(f"Unknown frame version: {frame.v!r}")

    if not frame.intent:
        errors.append("intent is required")

    if not frame.from_id:
        errors.append("from_id is required")
    elif BeamIdentity.parse_beam_id(frame.from_id) is None:
        errors.append(f"Invalid from_id: {frame.from_id!r}")

    if not frame.to_id:
        errors.append("to_id is required")
    elif BeamIdentity.parse_beam_id(frame.to_id) is None:
        errors.append(f"Invalid to_id: {frame.to_id!r}")

    if not frame.nonce:
        errors.append("nonce is required")

    if not frame.timestamp:
        errors.append("timestamp is required")
    else:
        try:
            ts = datetime.fromisoformat(frame.timestamp.replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            age_ms = abs((now - ts).total_seconds() * 1000)
            if age_ms > REPLAY_WINDOW_MS:
                errors.append(f"Frame timestamp out of replay window ({age_ms:.0f}ms)")
        except ValueError:
            errors.append(f"Invalid timestamp: {frame.timestamp!r}")

    # Size check — use canonical form
    size = len(_canonical_json(frame.to_dict()).encode("utf-8"))
    if size > MAX_FRAME_SIZE:
        errors.append(f"Frame too large: {size} bytes (max {MAX_FRAME_SIZE})")

    # Signature check
    if public_key_base64 and frame.signature:
        if not BeamIdentity.verify(
            _intent_signature_payload(
                from_id=frame.from_id,
                to_id=frame.to_id,
                intent=frame.intent,
                payload=frame.params,
                timestamp=frame.timestamp,
                nonce=frame.nonce,
            ),
            frame.signature,
            public_key_base64,
        ):
            errors.append("Signature verification failed")

    return errors


def validate_result_frame(frame: ResultFrame, public_key_base64: Optional[str] = None) -> list[str]:
    """Validate a ResultFrame. Returns list of errors (empty = valid)."""
    errors: list[str] = []

    if frame.v != "1":
        errors.append(f"Unknown frame version: {frame.v!r}")

    if not frame.nonce:
        errors.append("nonce is required")

    if not frame.timestamp:
        errors.append("timestamp is required")

    if not frame.success and not frame.error:
        errors.append("error message required when success=False")

    if public_key_base64:
        if not frame.signature:
            errors.append("signature is required when public_key_base64 is provided")
        else:
            unsigned = frame.to_dict()
            unsigned.pop("signature", None)
            if not BeamIdentity.verify(_canonical_json(unsigned), frame.signature, public_key_base64):
                errors.append("Signature verification failed")

    return errors
