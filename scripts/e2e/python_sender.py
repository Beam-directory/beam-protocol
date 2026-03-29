"""Cross-check the Beam Python SDK against a live local directory."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys

from beam_directory import BeamClient, BeamIdentity
from beam_directory.types import AgentSearchQuery


async def main() -> int:
    directory_url = os.environ["BEAM_DIRECTORY_URL"]
    receiver_beam_id = os.environ["BEAM_RECEIVER_BEAM_ID"]
    org_name = os.environ.get("BEAM_SEARCH_ORG", "e2e")
    message = os.environ.get("BEAM_MESSAGE", "hello from python")
    suffix = secrets.token_hex(3)

    identity = BeamIdentity.generate(agent_name=f"python-sender-{suffix}", org_name=org_name)
    client = BeamClient(identity=identity, directory_url=directory_url)

    await client.register("Python Sender", capabilities=["conversation.message"])

    lookup = await client.directory.lookup(receiver_beam_id)
    if lookup is None:
        raise RuntimeError(f"Python lookup could not find {receiver_beam_id}")

    matches = await client.directory.search(
        AgentSearchQuery(org=org_name, capabilities=["conversation.message"], limit=20)
    )

    reply = await client.talk(receiver_beam_id, message)

    print(
        json.dumps(
            {
                "senderBeamId": client.beam_id,
                "lookupBeamId": lookup.beam_id,
                "searchMatches": [agent.beam_id for agent in matches],
                "reply": {
                    "message": reply["message"],
                    "structured": reply.get("structured"),
                    "threadId": reply.get("threadId"),
                },
            }
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as exc:  # pragma: no cover - failure path is consumed by the parent harness
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
