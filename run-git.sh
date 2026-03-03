#!/bin/bash
set -e

echo "=== Step 1: git status ==="
git status

echo ""
echo "=== Step 2: git add ==="
git add src/datasources/azdevops.ts src/tests/azdevops-datasource.test.ts

echo ""
echo "=== Step 3: git commit ==="
git commit -m "$(cat <<'EOF'
fix: add error handling for JSON.parse in Azure DevOps datasource

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"

echo ""
echo "=== Step 4: git status ==="
git status
