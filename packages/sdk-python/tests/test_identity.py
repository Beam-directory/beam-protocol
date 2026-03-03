"""Tests for BeamIdentity — Ed25519 key generation, signing, verification."""

import pytest
from beam_directory.identity import BeamIdentity
from beam_directory.types import BeamIdentityData


class TestBeamIdGeneration:
    def test_generate_produces_valid_beam_id(self):
        identity = BeamIdentity.generate(agent_name="jarvis", org_name="coppen")
        assert identity.beam_id == "jarvis@coppen.beam.directory"

    def test_generate_provides_public_key(self):
        identity = BeamIdentity.generate(agent_name="test", org_name="org")
        assert identity.public_key_base64
        assert len(identity.public_key_base64) > 40  # reasonable base64 length

    def test_generate_invalid_agent_name_raises(self):
        with pytest.raises(ValueError):
            BeamIdentity.generate(agent_name="Invalid Agent!", org_name="org")

    def test_generate_invalid_org_name_raises(self):
        with pytest.raises(ValueError):
            BeamIdentity.generate(agent_name="agent", org_name="My Org")

    def test_each_generate_produces_unique_keys(self):
        id1 = BeamIdentity.generate("a", "org")
        id2 = BeamIdentity.generate("a", "org")
        assert id1.public_key_base64 != id2.public_key_base64


class TestExportImport:
    def test_export_round_trips(self):
        original = BeamIdentity.generate("jarvis", "coppen")
        data = original.export()

        assert isinstance(data, BeamIdentityData)
        assert data.beam_id == "jarvis@coppen.beam.directory"
        assert data.public_key_base64 == original.public_key_base64
        assert data.private_key_base64  # non-empty

    def test_from_data_restores_identity(self):
        original = BeamIdentity.generate("jarvis", "coppen")
        data = original.export()
        restored = BeamIdentity.from_data(data)

        assert restored.beam_id == original.beam_id
        assert restored.public_key_base64 == original.public_key_base64

    def test_from_data_can_sign(self):
        original = BeamIdentity.generate("jarvis", "coppen")
        data = original.export()
        restored = BeamIdentity.from_data(data)

        sig = restored.sign("test message")
        assert BeamIdentity.verify("test message", sig, original.public_key_base64)

    def test_to_dict_from_dict_round_trip(self):
        identity = BeamIdentity.generate("agent", "org")
        data = identity.export()
        d = data.to_dict()
        data2 = BeamIdentityData.from_dict(d)
        assert data2.beam_id == data.beam_id
        assert data2.public_key_base64 == data.public_key_base64


class TestSigning:
    def setup_method(self):
        self.identity = BeamIdentity.generate("signer", "testorg")

    def test_sign_and_verify(self):
        msg = "hello world"
        sig = self.identity.sign(msg)
        assert BeamIdentity.verify(msg, sig, self.identity.public_key_base64)

    def test_verify_wrong_message_fails(self):
        sig = self.identity.sign("correct message")
        assert not BeamIdentity.verify("wrong message", sig, self.identity.public_key_base64)

    def test_verify_wrong_key_fails(self):
        other = BeamIdentity.generate("other", "org")
        sig = self.identity.sign("test")
        assert not BeamIdentity.verify("test", sig, other.public_key_base64)

    def test_verify_tampered_signature_fails(self):
        sig = self.identity.sign("test")
        tampered = sig[:-4] + "XXXX"
        assert not BeamIdentity.verify("test", tampered, self.identity.public_key_base64)

    def test_verify_invalid_key_returns_false(self):
        assert not BeamIdentity.verify("test", "invalidsig", "invalidkey")


class TestParseBeamId:
    def test_valid_beam_id(self):
        result = BeamIdentity.parse_beam_id("jarvis@coppen.beam.directory")
        assert result == {"agent": "jarvis", "org": "coppen"}

    def test_valid_with_hyphens(self):
        result = BeamIdentity.parse_beam_id("my-agent@my-org.beam.directory")
        assert result == {"agent": "my-agent", "org": "my-org"}

    def test_valid_with_underscores(self):
        result = BeamIdentity.parse_beam_id("my_agent@my_org.beam.directory")
        assert result == {"agent": "my_agent", "org": "my_org"}

    def test_invalid_no_at(self):
        assert BeamIdentity.parse_beam_id("jarvis.coppen.beam.directory") is None

    def test_invalid_wrong_domain(self):
        assert BeamIdentity.parse_beam_id("jarvis@coppen.example.com") is None

    def test_invalid_uppercase(self):
        assert BeamIdentity.parse_beam_id("Jarvis@Coppen.beam.directory") is None


class TestNonce:
    def test_generate_nonce_is_uuid4(self):
        import re
        nonce = BeamIdentity.generate_nonce()
        assert re.match(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            nonce
        )

    def test_generate_nonce_unique(self):
        nonces = {BeamIdentity.generate_nonce() for _ in range(100)}
        assert len(nonces) == 100
