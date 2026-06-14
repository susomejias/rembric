#!/usr/bin/env bash
# Read-only validation of the node-workspace release model.
# Builds a throwaway branch off origin/main, simulates a shared-asset change,
# runs `release-please release-pr --dry-run` (NO PRs, NO tags, NO mutation of
# main), prints the proposed PRs, then tells you how to tear the branch down.
#
# Requires: gh (authenticated), node, pnpm. Run from the repo root.
set -euo pipefail

REPO="susomejias/rembric"
BRANCH="test/rp-node-workspace"
REF_DIR="openspec/changes/migrate-plugin-release-to-node-workspace/reference"
RP_VERSION="16"

command -v gh >/dev/null || { echo "gh CLI required"; exit 1; }
TOKEN="$(gh auth token)"

echo "==> fetching origin/main"
git fetch origin main

echo "==> creating throwaway branch ${BRANCH} off origin/main"
git branch -D "$BRANCH" 2>/dev/null || true
git checkout -b "$BRANCH" origin/main

# Seed the two new client manifest entries at whatever apps/plugin is on main
# right now (so the cascade computes from the real, current base).
SEED="$(node -p "require('./apps/plugin/package.json').version")"
echo "==> seeding claude/codex components at ${SEED} (current apps/plugin version on main)"

echo "==> applying proposed release-please config"
cp "${REF_DIR}/release-please-config.json" release-please-config.json

echo "==> rewriting .release-please-manifest.json (add claude/codex at SEED)"
node -e '
  const fs = require("fs");
  const seed = process.argv[1];
  const m = JSON.parse(fs.readFileSync(".release-please-manifest.json", "utf8"));
  m["apps/plugin/.claude-plugin"] = seed;
  m["apps/plugin/.codex-plugin"] = seed;
  fs.writeFileSync(".release-please-manifest.json", JSON.stringify(m, null, 2) + "\n");
' "$SEED"

echo "==> writing client package.json files (release-graph nodes; NOT pnpm members)"
node -e '
  const fs = require("fs");
  const seed = process.argv[1];
  const mk = (name) => JSON.stringify({
    name, version: seed, private: true,
    dependencies: { "@rembric/plugin": "workspace:*" }
  }, null, 2) + "\n";
  fs.writeFileSync("apps/plugin/.claude-plugin/package.json", mk("@rembric/plugin-claude-code"));
  fs.writeFileSync("apps/plugin/.codex-plugin/package.json",  mk("@rembric/plugin-codex"));
' "$SEED"

echo "==> GATE: pnpm-lock.yaml must be untouched (clients are not workspace members)"
pnpm install --lockfile-only >/dev/null 2>&1 || true
if ! git diff --quiet pnpm-lock.yaml; then
  echo "!! pnpm-lock.yaml CHANGED — clients leaked into the workspace. Investigate before trusting the dry-run."
  git checkout -- pnpm-lock.yaml
fi

echo "==> synthetic shared-asset change (to exercise the cascade)"
printf '\n# dry-run probe %s\n' "$SEED" >> apps/plugin/README.md
git add -A
git commit -q -m "fix(plugin): dry-run probe — synthetic shared-asset change"

echo "==> pushing throwaway branch (delete it after; see teardown below)"
git push -u origin "$BRANCH" --force-with-lease

echo
echo "============================================================"
echo "DRY-RUN (read-only — creates NO PRs, NO tags):"
echo "============================================================"
npx --yes "release-please@${RP_VERSION}" release-pr \
  --token="$TOKEN" \
  --repo-url="$REPO" \
  --target-branch="$BRANCH" \
  --dry-run --debug

echo
echo "WHAT TO CHECK in the output above:"
echo "  1. TWO separate would-be PRs: 'claude-code-plugin <v>' AND 'codex-plugin <v>',"
echo "     each a +patch from ${SEED}, each title carrying a version (NOT one combined PR)."
echo "  2. A 'plugin-shared <v>' PR for the shared bump."
echo "  3. NO grouped/version-less title, NO node-workspace error about an unresolved"
echo "     '@rembric/plugin' dependency (that would mean the graph didn't resolve)."
echo
echo "TEARDOWN when done (removes all trace):"
echo "  git checkout main && git branch -D ${BRANCH}"
echo "  git push origin --delete ${BRANCH}"
