# @beam-protocol/directory

Beam Protocol Directory Server — agent registration, discovery, intent routing, and federation.

## Quick Start
```bash
npm install
npm run build
npm start
```

## Environment Variables
- `PORT` — Server port (default: 3100)
- `DB_PATH` — SQLite database path (default: ./beam-directory.db)
- `BEAM_ADMIN_KEY` — Admin API key for management endpoints

## Features
- Agent registration with Ed25519 keys
- WebSocket real-time intent routing
- HTTP relay for intent delivery
- Federation between directories
- API key authentication
- Beam Shield (PII detection, content filtering)
- Email verification
- Domain verification

## License
AGPL-3.0-or-later
