#!/bin/sh
# Fetch the published legislation records (the repository's data branch) into
# studenttrustee/data/legislation/ for local development and the test suite.
#   sh tools/pull-data.sh
set -e
cd "$(dirname "$0")/.."
DEST=studenttrustee/data/legislation
REMOTE=$(git remote get-url origin)
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --depth 1 origin data
  git -C "$DEST" reset --hard FETCH_HEAD
else
  rm -rf "$DEST"
  git clone --depth 1 --branch data "$REMOTE" "$DEST"
fi
echo "legislation data: $(git -C "$DEST" log -1 --format='%s (%cd)')"
