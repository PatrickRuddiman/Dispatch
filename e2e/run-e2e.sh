#!/usr/bin/env bash
# e2e/run-e2e.sh — End-to-end test for Dispatch + OpenCode integration.
#
# Scaffolds a minimal seed project in a temp directory, creates a markdown
# task file, runs `dispatch --spec` against it using the configured provider,
# then validates that a non-empty spec with task checkboxes was generated.
#
# Environment variables:
#   PROVIDER         Provider to use (default: opencode)
#   MODEL            Optional model override in "provider/model" format
#   DISPATCH_FLAGS   Additional flags to pass to dispatch
#   SPEC_TIMEOUT     Spec generation timeout in minutes (default: 10, max: 120)
#   ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, etc. — forwarded to provider
#
# Usage (via Docker — recommended):
#   docker build -t dispatch-e2e -f e2e/Dockerfile .
#   docker run --rm -e PROVIDER=opencode dispatch-e2e bash /dispatch/e2e/run-e2e.sh
#
# Usage (inside a running container):
#   bash /dispatch/e2e/run-e2e.sh
#
# Usage (locally, if dispatch and opencode are on PATH):
#   PROVIDER=opencode ./e2e/run-e2e.sh

set -euo pipefail

PROVIDER="${PROVIDER:-opencode}"
MODEL="${MODEL:-}"
DISPATCH_FLAGS="${DISPATCH_FLAGS:-}"
SPEC_TIMEOUT="${SPEC_TIMEOUT:-10}"

# ── Create a fresh temp directory for this run ─────────────────────────────
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> [e2e] Seed project: $WORK_DIR"
echo "==> [e2e] Provider:     $PROVIDER"
[[ -n "$MODEL" ]] && echo "==> [e2e] Model:        $MODEL"
[[ -n "${ANTHROPIC_API_KEY:-}" ]] && echo "==> [e2e] ANTHROPIC_API_KEY: set"
[[ -n "${OPENAI_API_KEY:-}" ]]    && echo "==> [e2e] OPENAI_API_KEY: set"
[[ -n "${GITHUB_TOKEN:-}" ]]      && echo "==> [e2e] GITHUB_TOKEN: set"

# ── Scaffold a minimal Express.js app ──────────────────────────────────────
cat > "$WORK_DIR/package.json" <<'EOF'
{
  "name": "seed-app",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "express": "^4.18.0"
  }
}
EOF

cat > "$WORK_DIR/index.js" <<'EOF'
const express = require('express');
const app = express();

app.get('/', (_req, res) => res.json({ message: 'Hello World' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
EOF

# ── Initialize a git repository ────────────────────────────────────────────
cd "$WORK_DIR"
git init -q
git add -A
git commit -q -m "chore: initial seed project"

# ── Write the task markdown file ───────────────────────────────────────────
mkdir -p .dispatch/tasks
cat > .dispatch/tasks/add-health-endpoint.md <<'EOF'
# Add Health Endpoint

Add a `GET /health` endpoint to the Express app that returns `{ "status": "ok" }` with HTTP 200.

The endpoint should be simple and stateless — no authentication or database access required.
EOF

# ── Optional: write model override into .dispatch/config.json ──────────────
if [[ -n "$MODEL" ]]; then
  mkdir -p .dispatch
  cat > .dispatch/config.json <<EOF
{
  "providerModels": {
    "$PROVIDER": {
      "strong": "$MODEL",
      "fast": "$MODEL"
    }
  }
}
EOF
  echo "==> [e2e] Wrote model override to .dispatch/config.json"
fi

# ── Build the dispatch command ──────────────────────────────────────────────
DISPATCH_ARGS=(
  --spec ".dispatch/tasks/add-health-endpoint.md"
  --source md
  --provider "$PROVIDER"
  --spec-timeout "$SPEC_TIMEOUT"
)

if [[ -n "$DISPATCH_FLAGS" ]]; then
  # shellcheck disable=SC2206
  DISPATCH_ARGS+=($DISPATCH_FLAGS)
fi

echo "==> [e2e] Running: dispatch ${DISPATCH_ARGS[*]}"
echo "==> [e2e] Spec timeout: ${SPEC_TIMEOUT} minutes"
echo ""

# Run dispatch; capture exit code without triggering set -e
set +e
dispatch "${DISPATCH_ARGS[@]}"
DISPATCH_EXIT=$?
set -e

if [[ $DISPATCH_EXIT -ne 0 ]]; then
  echo ""
  echo "FAIL: dispatch exited with code $DISPATCH_EXIT"
  exit 1
fi

# ── Validate the output ─────────────────────────────────────────────────────
echo ""
echo "==> [e2e] Validating output..."

SPEC_FILES=()
while IFS= read -r -d '' f; do
  SPEC_FILES+=("$f")
done < <(find .dispatch/specs -name "*.md" -print0 2>/dev/null || true)

if [[ ${#SPEC_FILES[@]} -eq 0 ]]; then
  echo "FAIL: No spec file found in .dispatch/specs/"
  exit 1
fi

echo "==> [e2e] Found ${#SPEC_FILES[@]} spec file(s):"
for f in "${SPEC_FILES[@]}"; do
  echo "         $f"
done

FIRST_SPEC="${SPEC_FILES[0]}"

if [[ ! -s "$FIRST_SPEC" ]]; then
  echo "FAIL: Spec file is empty: $FIRST_SPEC"
  exit 1
fi

if ! grep -qF '- [ ]' "$FIRST_SPEC"; then
  echo "FAIL: Spec file does not contain a task checkbox ('- [ ]'): $FIRST_SPEC"
  echo "--- Spec content ---"
  cat "$FIRST_SPEC"
  echo "--------------------"
  exit 1
fi

echo ""
echo "==> [e2e] Spec content:"
echo "---"
cat "$FIRST_SPEC"
echo "---"
echo ""
echo "==> [e2e] SUCCESS: spec generated with task checkboxes."
exit 0
