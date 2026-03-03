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

_BEAM_ID_PATTERN = re.compile(r"^([a-z0-9_-]+)@([a-z0-9_-]+)\.beam\.directory$")


class BeamIdentity:
    """
    A Beam identity wrapping an Ed25519 keypair.

    Usage::

        identity = BeamIdentity.generate(agent_name="jarvis", org_name="coppen")
        data = identity.export()          # BeamIdentityData (serialisable)
        identity2 = BeamIdentity.from_data(data)

        sig = identity.sign("hello")
        ok = BeamIdentity.verify("hello", sig, identity.public_key_base64)
    """

    def __init__(
        self,
        beam_id: BeamIdString,
        private_key: Ed25519PrivateKey,
        public_key: Ed25519PublicKey,
    ) -> None:
        self._beam_id = beam_id
        self._private_key = private_key
        self._public_key = public_key
        # Cache base64 representations
        self._public_key_base64 = base64.b64encode(
            public_key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
        ).decode()

    # ── Properties ────────────────────────────────────────────────────────────

    @property
    def beam_id(self) -> BeamIdString:
        return self._beam_id

    @property
    def public_key_base64(self) -> str:
        """SPKI DER encoded public key, base64."""
        return self._public_key_base64

    # ── Factory methods ────────────────────────────────────────────────────────

    @classmethod
    def generate(cls, agent_name: str, org_name: str) -> "BeamIdentity":
        """Generate a new Ed25519 keypair and derive a Beam ID."""
        if not re.match(r"^[a-z0-9_-]+$", agent_name):
            raise ValueError("agent_name must match [a-z0-9_-]+")
        if not re.match(r"^[a-z0-9_-]+$", org_name):
            raise ValueError("org_name must match [a-z0-9_-]+")

        private_key = Ed25519PrivateKey.generate()
        public_key = private_key.public_key()
        beam_id: BeamIdString = f"{agent_name}@{org_name}.beam.directory"
        return cls(beam_id, private_key, public_key)

    @classmethod
    def from_data(cls, data: BeamIdentityData) -> "BeamIdentity":
        """Reconstruct an identity from serialised key data."""
        private_key_bytes = base64.b64decode(data.private_key_base64)
        public_key_bytes = base64.b64decode(data.public_key_base64)

        private_key = load_der_private_key(private_key_bytes, password=None)
        public_key = load_der_public_key(public_key_bytes)

        if not isinstance(private_key, Ed25519PrivateKey):
            raise ValueError("Expected Ed25519 private key")
        if not isinstance(public_key, Ed25519PublicKey):
            raise ValueError("Expected Ed25519 public key")

        return cls(data.beam_id, private_key, public_key)

    # ── Serialisation ──────────────────────────────────────────────────────────

    def export(self) -> BeamIdentityData:
        """Export identity data (including private key) for storage."""
        private_bytes = self._private_key.private_bytes(
            Encoding.DER, PrivateFormat.PKCS8, NoEncryption()
        )
        return BeamIdentityData(
            beam_id=self._beam_id,
            public_key_base64=self._public_key_base64,
            private_key_base64=base64.b64encode(private_bytes).decode(),
        )

    # ── Signing & Verification ─────────────────────────────────────────────────

    def sign(self, data: str) -> str:
        """Sign a string with the private key, return base64 signature."""
        signature = self._private_key.sign(data.encode("utf-8"))
        return base64.b64encode(signature).decode()

    @staticmethod
    def verify(data: str, signature_base64: str, public_key_base64: str) -> bool:
        """Verify an Ed25519 signature. Returns False on any error."""
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

    # ── Utilities ─────────────────────────────────────────────────────────────

    @staticmethod
    def parse_beam_id(beam_id: str) -> Optional[dict[str, str]]:
        """Parse a Beam ID into agent + org parts. Returns None if invalid."""
        m = _BEAM_ID_PATTERN.match(beam_id)
        if not m:
            return None
        return {"agent": m.group(1), "org": m.group(2)}

    @staticmethod
    def generate_nonce() -> str:
        """Generate a UUID v4 nonce for replay protection."""
        return str(uuid.uuid4())

    def to_registration(
        self,
        display_name: str,
        capabilities: Optional[list[str]] = None,
    ) -> AgentRegistration:
        """Create an AgentRegistration from this identity."""
        parsed = self.parse_beam_id(self._beam_id)
        if not parsed:
            raise ValueError(f"Invalid Beam ID: {self._beam_id}")
        return AgentRegistration(
            beam_id=self._beam_id,
            display_name=display_name,
            capabilities=capabilities or [],
            public_key=self._public_key_base64,
            org=parsed["org"],
        )

    def __repr__(self) -> str:
        return f"BeamIdentity(beam_id={self._beam_id!r})"
