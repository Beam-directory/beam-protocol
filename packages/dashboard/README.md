# Beam Dashboard

React + Vite dashboard for the Beam Directory API.

## Environment

```bash
VITE_DIRECTORY_URL=http://localhost:3100
```

If `VITE_DIRECTORY_URL` is not set, the dashboard defaults to `http://localhost:3100`.

## Development

```bash
npm run dev --workspace=packages/dashboard
```

## Pages

- `/` overview with live stats from `GET /agents/stats`
- `/agents` real agent registry with search and filters
- `/agents/:beamId` agent profile page
- `/register` browser-side Ed25519 registration flow
- `/intents` recent intent history + live `/ws` feed
- `/settings` API connectivity and local key storage status
