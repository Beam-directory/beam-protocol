# Beam Dashboard

Bloomberg-terminal-style dashboard for the Beam Directory protocol.

## Stack

- **Frontend:** React + Vite + TailwindCSS
- **Backend:** [Convex](https://convex.dev) (reactive queries, mutations, HTTP actions)
- **Charts:** Recharts
- **Icons:** Lucide React

## Design

- Dark mode only · accent `#F75C03` · dense professional UI
- Font: Inter (UI) + JetBrains Mono (data)

## Getting Started

### 1. Create a Convex project

```bash
npx convex dev
```

This will:
- Prompt you to log in to Convex
- Create a new project
- Generate `convex/_generated/` files
- Write `VITE_CONVEX_URL` to `.env.local`

### 2. Run the dashboard

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

### 3. Deploy

```bash
# Deploy Convex backend
npx convex deploy

# Build frontend
npm run build
# Then deploy `dist/` to Netlify / Vercel / Cloudflare Pages
```

## Pages

| Route | Description |
|-------|-------------|
| `/` | Overview: KPIs, intent volume chart, trust distribution |
| `/agents` | Agent registry with search, filter, trust bars |
| `/intents` | Live intent log with latency chart |
| `/settings` | API key management, org verification |

## Convex Schema

| Table | Purpose |
|-------|---------|
| `organizations` | Org registry (name, plan, verified, stripe) |
| `agents` | Registered beam IDs with trust scores |
| `intents` | Intent log (from/to, latency, success/error) |
| `apiKeys` | Hashed API keys per org |
| `waitlist` | Landing page email signups |

## Waitlist HTTP Endpoint

The Convex deployment exposes a CORS-friendly HTTP action at:

```
POST https://YOUR_DEPLOYMENT.convex.site/waitlist
Content-Type: application/json

{ "email": "user@example.com", "source": "landing" }
```

To connect the landing page, set `window.BEAM_CONVEX_URL` in `website/index.html`:

```html
<script>
  window.BEAM_CONVEX_URL = 'https://YOUR_DEPLOYMENT.convex.site';
</script>
```

## Environment Variables

```bash
# .env.local
VITE_CONVEX_URL=https://your-deployment.convex.cloud
```
