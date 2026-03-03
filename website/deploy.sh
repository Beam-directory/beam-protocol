#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Deploy beam.directory to Cloudflare Pages
#
# Prerequisites:
#   npm install -g wrangler
#   wrangler login
#
# Usage:
#   ./deploy.sh                     # deploy to production
#   ./deploy.sh --preview           # deploy to preview branch
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_NAME="beam-directory"
BRANCH="${1:-production}"

echo "🚀 Deploying beam.directory to Cloudflare Pages..."
echo "   Project: $PROJECT_NAME"
echo "   Branch:  $BRANCH"
echo ""

# Check wrangler is available
if ! command -v wrangler &>/dev/null; then
  echo "❌ wrangler CLI not found. Install it:"
  echo "   npm install -g wrangler"
  exit 1
fi

# Deploy
if [ "$BRANCH" = "--preview" ]; then
  wrangler pages deploy . \
    --project-name="$PROJECT_NAME" \
    --branch="preview"
else
  wrangler pages deploy . \
    --project-name="$PROJECT_NAME" \
    --branch="main"
fi

echo ""
echo "✅ Deployed! Visit https://beam.directory"
