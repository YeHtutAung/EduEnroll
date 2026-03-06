#!/bin/bash
# ─── KuuNyi Production Deploy Script ──────────────────────────────────────
#
# Promotes staging to production after verifying the pre-deploy checklist.
# Usage: bash DEPLOY.sh
#
# This script:
#   1. Asks 3 confirmation questions
#   2. Merges staging → main
#   3. Pushes to origin
#   4. Runs `vercel --prod` to deploy to production
#   5. Returns to dev branch
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  KuuNyi — Production Deploy"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Ensure we're in the repo root
if [ ! -f "package.json" ]; then
  echo "ERROR: Run this script from the project root."
  exit 1
fi

# Check staging branch exists and is up to date
CURRENT=$(git branch --show-current)
echo "Current branch: ${CURRENT}"
echo ""

echo "Pre-deploy checklist:"
echo ""

read -p "  1. Have you tested on staging Vercel preview URL? (y/n) " confirm1
read -p "  2. Did security-audit.sh pass on staging? (y/n) " confirm2
read -p "  3. Did you test enrollment flow on phone? (y/n) " confirm3

echo ""

if [ "$confirm1" = "y" ] && [ "$confirm2" = "y" ] && [ "$confirm3" = "y" ]; then
  echo "All checks passed. Promoting to production..."
  echo ""

  git checkout main
  git merge staging --no-edit
  git push origin main

  echo ""
  echo "Deploying to production via Vercel CLI..."
  vercel --prod --yes
  echo "Production deploy complete."

  echo ""

  git checkout dev
  echo "Switched back to dev branch."
else
  echo "Deploy cancelled. Fix issues and try again."
  exit 1
fi
