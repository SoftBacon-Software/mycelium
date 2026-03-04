#!/usr/bin/env bash
#
# release.sh — Merge master into stable and tag for customer deployment.
#
# Usage:
#   ./scripts/release.sh              # Auto-generates tag from date (v2026.03.04)
#   ./scripts/release.sh v1.2.0       # Use explicit tag
#   ./scripts/release.sh --dry-run    # Preview what would happen
#
# What it does:
#   1. Ensures master and stable are up to date
#   2. Merges master into stable (fast-forward when possible)
#   3. Tags the merge point
#   4. Pushes stable + tag to origin
#   5. Railway auto-deploys all customer instances tracking stable
#
# Rollback:
#   git checkout stable && git revert HEAD && git push origin stable
#   Or: Railway dashboard → Deployments → Redeploy previous

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

DRY_RUN=false
TAG=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    v*) TAG="$arg" ;;
    *) echo -e "${RED}Unknown argument: $arg${NC}"; exit 1 ;;
  esac
done

# Auto-generate tag if not provided
if [ -z "$TAG" ]; then
  DATE_TAG="v$(date +%Y.%m.%d)"
  # Append incrementing suffix if tag already exists
  if git rev-parse "$DATE_TAG" >/dev/null 2>&1; then
    i=2
    while git rev-parse "${DATE_TAG}.${i}" >/dev/null 2>&1; do
      ((i++))
    done
    TAG="${DATE_TAG}.${i}"
  else
    TAG="$DATE_TAG"
  fi
fi

echo -e "${YELLOW}=== Mycelium Release ===${NC}"
echo "Tag: $TAG"
echo "Dry run: $DRY_RUN"
echo ""

# Ensure we're in the repo root
if [ ! -f "package.json" ]; then
  echo -e "${RED}Run this from the mycelium repo root.${NC}"
  exit 1
fi

# Ensure working tree is clean
if [ -n "$(git status --porcelain)" ]; then
  echo -e "${RED}Working tree is dirty. Commit or stash changes first.${NC}"
  exit 1
fi

# Fetch latest
echo "Fetching origin..."
git fetch origin

# Ensure master is up to date
CURRENT=$(git branch --show-current)
git checkout master --quiet
LOCAL_MASTER=$(git rev-parse master)
REMOTE_MASTER=$(git rev-parse origin/master)
if [ "$LOCAL_MASTER" != "$REMOTE_MASTER" ]; then
  echo "Pulling master..."
  git pull origin master --quiet
fi

# Create stable if it doesn't exist
if ! git show-ref --verify --quiet refs/heads/stable; then
  if git show-ref --verify --quiet refs/remotes/origin/stable; then
    echo "Tracking existing remote stable branch..."
    git checkout -b stable origin/stable --quiet
  else
    echo -e "${YELLOW}Creating stable branch from master...${NC}"
    git checkout -b stable --quiet
    if [ "$DRY_RUN" = false ]; then
      git push -u origin stable
      echo -e "${GREEN}Created and pushed stable branch.${NC}"
    else
      echo "[dry-run] Would create and push stable branch."
    fi
  fi
else
  git checkout stable --quiet
  # Pull latest stable if remote exists
  if git show-ref --verify --quiet refs/remotes/origin/stable; then
    git pull origin stable --quiet
  fi
fi

# Show what will be merged
BEHIND=$(git rev-list --count stable..master)
if [ "$BEHIND" -eq 0 ]; then
  echo -e "${GREEN}stable is already up to date with master. Nothing to release.${NC}"
  git checkout "$CURRENT" --quiet
  exit 0
fi

echo ""
echo -e "${YELLOW}Commits to release ($BEHIND):${NC}"
git log --oneline stable..master
echo ""

if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}[dry-run] Would merge master into stable, tag $TAG, and push.${NC}"
  git checkout "$CURRENT" --quiet
  exit 0
fi

# Merge master into stable
echo "Merging master into stable..."
git merge master --no-edit --quiet

# Tag
echo "Tagging $TAG..."
git tag -a "$TAG" -m "Release $TAG"

# Push
echo "Pushing stable + tag..."
git push origin stable --quiet
git push origin "$TAG" --quiet

echo ""
echo -e "${GREEN}=== Released $TAG ===${NC}"
echo -e "${GREEN}$BEHIND commits merged to stable.${NC}"
echo -e "${GREEN}Railway will auto-deploy all customer instances.${NC}"
echo ""
echo "To rollback:"
echo "  git checkout stable && git revert HEAD && git push origin stable"

# Return to original branch
git checkout "$CURRENT" --quiet
