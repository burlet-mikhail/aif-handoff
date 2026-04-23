#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

AIF_BUILD="/home/helm-server/aif-handoff"
AIF_PROD="/opt/aif-handoff"

echo "==> Pulling latest changes..."
$SSH_CMD "cd ${AIF_BUILD} && git pull origin main"

echo "==> Installing dependencies..."
$SSH_CMD "cd ${AIF_BUILD} && npm ci"

echo "==> Building..."
$SSH_CMD "cd ${AIF_BUILD} && npm run build"

echo "==> Deploying frontend..."
$SSH_CMD "
    rm -rf ${AIF_PROD}/web/*
    cp -a ${AIF_BUILD}/packages/web/dist/. ${AIF_PROD}/web/
"

echo "==> Restarting services..."
$SSH_CMD "sudo systemctl restart aif-api aif-agent"

echo "==> Done."
