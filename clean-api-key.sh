#!/bin/bash
# One-shot cleanup: remove stale ANTHROPIC_API_KEY from everywhere,
# restart PM2 daemon with clean env so only CLAUDE_CODE_OAUTH_TOKEN remains.
# This script runs independently of any agent session.

set -e

echo "[$(date -u)] Starting API key cleanup..."

# 1. Remove ANTHROPIC_API_KEY from shell profiles (comment out any remaining)
sed -i '/^export ANTHROPIC_API_KEY/s/^/# CLEANED: /' /root/.bashrc 2>/dev/null || true
sed -i '/^export ANTHROPIC_API_KEY/s/^/# CLEANED: /' /root/.profile 2>/dev/null || true
sed -i '/^ANTHROPIC_API_KEY/s/^/# CLEANED: /' /etc/environment 2>/dev/null || true

# 2. Unset from current shell
unset ANTHROPIC_API_KEY 2>/dev/null || true

# 3. Delete PM2's saved env snapshot for the daemon so it doesn't carry stale vars
pm2 delete cortextos-daemon 2>/dev/null || true

# 4. Wait for processes to stop
sleep 2

# 5. Re-start daemon fresh without ANTHROPIC_API_KEY in the environment
cd /root/cortextos
env -u ANTHROPIC_API_KEY pm2 start ecosystem.config.js --only cortextos-daemon

echo "[$(date -u)] Daemon restarted with clean env. Waiting for agents to come back..."
sleep 10

echo "[$(date -u)] Done. Verify with: pm2 env cortextos-daemon | grep -E 'ANTHROPIC|OAUTH'"
