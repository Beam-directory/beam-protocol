"""Runtime helpers shared by the Beam CrewAI wrapper classes."""

from __future__ import annotations

import asyncio
import threading
from typing import Any


def run_sync(coro: Any) -> Any:
    """Run an async coroutine from sync code, even if an event loop is already running."""

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    result: dict[str, Any] = {}
    error: dict[str, BaseException] = {}

    def _runner() -> None:
        try:
            result["value"] = asyncio.run(coro)
        except BaseException as exc:
            error["value"] = exc

    thread = threading.Thread(target=_runner, daemon=True)
    thread.start()
    thread.join()

    if "value" in error:
        raise error["value"]

    return result.get("value")

