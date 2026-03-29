# Beam Dashboard

React + Vite dashboard for the Beam Directory API.

## Environment

```bash
VITE_API_URL=http://localhost:3100
VITE_BEAM_BUS_URL=http://localhost:8420
```

If `VITE_API_URL` is not set, the dashboard defaults to `https://api.beam.directory`.
If `VITE_BEAM_BUS_URL` is not set, the dashboard defaults to `http://localhost:8420`.

## Development

```bash
npm run dev --workspace=packages/dashboard
```

For a full local operator stack, use the hosted quickstart in [`ops/quickstart`](../../ops/quickstart) and then open `http://localhost:5173/login`.

## Pages

- `/` overview with live stats from `GET /agents/stats`
- `/agents` real agent registry with search and filters
- `/agents/:beamId` agent profile page
- `/register` browser-side Ed25519 registration flow
- `/intents` recent intent history + live `/ws` feed
- `/audit`, `/federation`, `/errors`, `/alerts`, `/dead-letter` operator observability views
- `/settings` API connectivity and local key storage status
