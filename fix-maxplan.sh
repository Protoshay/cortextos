#!/bin/bash
# Fix: comment out ANTHROPIC_API_KEY so Claude Code uses Max plan OAuth instead
echo "Commenting out API key in .bashrc, .profile, /etc/environment..."
sed -i 's/^export ANTHROPIC_API_KEY/# MAXPLAN: export ANTHROPIC_API_KEY/' /root/.bashrc
sed -i 's/^export ANTHROPIC_API_KEY/# MAXPLAN: export ANTHROPIC_API_KEY/' /root/.profile
sed -i 's/^ANTHROPIC_API_KEY/# MAXPLAN: ANTHROPIC_API_KEY/' /etc/environment
unset ANTHROPIC_API_KEY
echo "Done. API key removed from environment."
echo ""
echo "Now running: claude login"
echo "A URL will appear — open it in your browser and log in with your Max plan account."
echo ""
exec env -u ANTHROPIC_API_KEY claude login
