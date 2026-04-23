#!/usr/bin/env bash
set -euo pipefail

export SERVER_USER="${SERVER_USER:-helm-server}"
export SERVER_HOST="${SERVER_HOST:-178.104.168.5}"
export SERVER_PORT="${SERVER_PORT:-29504}"
export SSH_KEY="${SSH_KEY:-$HOME/.ssh/helm-server}"

SSH_OPTS="-p ${SERVER_PORT}"
if [[ -n "$SSH_KEY" ]]; then
    SSH_OPTS="-i ${SSH_KEY} -o StrictHostKeyChecking=no ${SSH_OPTS}"
fi
export SSH_OPTS

export SSH_TARGET="${SERVER_USER}@${SERVER_HOST}"
export SSH_CMD="ssh ${SSH_OPTS} ${SSH_TARGET}"
export RSYNC_SSH="ssh ${SSH_OPTS}"
