"""Beam identity — Ed25519 key generation, signing, and verification."""

from __future__ import annotations

import base64
import re
import uuid
from typing import Optional

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_der_private_key,
    load_der_public_key,
)

from .types import AgentRegistration, BeamIdentityData, BeamIdString

_AGENT_RE = re.compile(r"^[a-z0-9_-]+$")
_CONSUMER_BEAM_ID_PATTERN = re.compile(r"^([a-z0-9_-]+)@beam\.directory$")
_ORG_BEAM_ID_PATTERN = re.compile(r"^([a-z0-9_-]+)@([a-z0-9_-]+)\.beam\.directory$")


class BeamIdentity:
    def __init__(
        self,
        beam_id: BeamIdString,
        private_key: Ed25519PrivateKey,
        public_key: Ed25519PublicKey,
    ) -> None:
        self._beam_id = beam_id
        self._private_key = private_key
        self._public_key = public_key
        self._public_key_base64 = base64.b64encode(
            public_key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
        ).decode()

    @property
    def beam_id(self) -> BeamIdString:
        return self._beam_id

    @property
    def public_key_base64(self) -> str:
        return self._public_key_base64

    @classmethod
    def generate(cls, agent_name: str, org_name: Optional[str] = None) -> "BeamIdentity":
        if not _AGENT_RE.match(agent_name):
            raise ValueError("agent_name must match [a-z0-9_-]+")
        if org_name is not None and not _AGENT_RE.match(org_name):
            raise ValueError("org_name must match [a-z0-9_-]+")

        private_key = Ed25519PrivateKey.generate()
        public_key = private_key.public_key()
        beam_id: BeamIdString
        if org_name:
            beam_id = f"{agent_name}@{org_name}.beam.directory"
        else:
            beam_id = f"{agent_name}@beam.directory"
        return cls(beam_id, private_key, public_key)

    @classmethod
    def from_data(cls, data: BeamIdentityData) -> "BeamIdentity":
        private_key_bytes = base64.b64decode(data.private_key_base64)
        public_key_bytes = base64.b64decode(data.public_key_base64)

        private_key = load_der_private_key(private_key_bytes, password=None)
        public_key = load_der_public_key(public_key_bytes)

        if not isinstance(private_key, Ed25519PrivateKey):
            raise ValueError("Expected Ed25519 private key")
        if not isinstance(public_key, Ed25519PublicKey):
            raise ValueError("Expected Ed25519 public key")

        return cls(data.beam_id, private_key, public_key)

    def export(self) -> BeamIdentityData:
        private_bytes = self._private_key.private_bytes(
            Encoding.DER, PrivateFormat.PKCS8, NoEncryption()
        )
        return BeamIdentityData(
            beam_id=self._beam_id,
            public_key_base64=self._public_key_base64,
            private_key_base64=base64.b64encode(private_bytes).decode(),
        )

    def sign(self, data: str) -> str:
        signature = self._private_key.sign(data.encode("utf-8"))
        return base64.b64encode(signature).decode()

    @staticmethod
    def verify(data: str, signature_base64: str, public_key_base64: str) -> bool:
        try:
            public_key_bytes = base64.b64decode(public_key_base64)
            public_key = load_der_public_key(public_key_bytes)
            if not isinstance(public_key, Ed25519PublicKey):
                return False
            signature = base64.b64decode(signature_base64)
            public_key.verify(signature, data.encode("utf-8"))
            return True
        except Exception:
            return False

    @staticmethod
    def parse_beam_id(beam_id: str) -> Optional[dict[str, str]]:
        consumer_match = _CONSUMER_BEAM_ID_PATTERN.match(beam_id)
        if consumer_match:
            return {"agent": consumer_match.group(1), "kind": "consumer"}

        org_match = _ORG_BEAM_ID_PATTERN.match(beam_id)
        if org_match:
            return {
                "agent": org_match.group(1),
                "org": org_match.group(2),
                "kind": "organization",
            }

        return None

    @staticmethod
    def generate_nonce() -> str:
        return str(uuid.uuid4())

    def to_registration(
        self,
        display_name: str,
        capabilities: Optional[list[str]] = None,
    ) -> AgentRegistration:
        parsed = self.parse_beam_id(self._beam_id)
        if not parsed:
            raise ValueError(f"Invalid Beam ID: {self._beam_id}")
        return AgentRegistration(
            beam_id=self._beam_id,
            display_name=display_name,
            capabilities=capabilities or [],
            public_key=self._public_key_base64,
            org=parsed.get("org"),
        )

    def __repr__(self) -> str:
        return f"BeamIdentity(beam_id={self._beam_id!r})"
