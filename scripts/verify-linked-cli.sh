#!/usr/bin/env bash
# Rebuild the staging-only CLI from the official repository and compare the package.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
commit=f4097e989d68f54ecbb781d19343350b761922e8
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git init -q "$work/source"
git -C "$work/source" fetch --quiet --depth=1 https://github.com/augmentworks-org/augmentworks-cli.git "$commit"
git -C "$work/source" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$work/source" rev-parse HEAD)" = "$commit"
mkdir "$work/pack"
(
  cd "$work/source"
  npm ci --ignore-scripts --no-audit --no-fund
  npm run build
  npm pack --silent --ignore-scripts --pack-destination "$work/pack"
)

# Comparing the tar streams includes file contents, names, order, modes and headers
# without depending on the version of the gzip encoder in the local Node build.
gzip -dc "$root/vendor/augmentworks-cli-f4097e989d68.tgz" > "$work/vendored.tar"
gzip -dc "$work/pack/augmentworks-cli-0.4.2.tgz" > "$work/rebuilt.tar"
cmp "$work/vendored.tar" "$work/rebuilt.tar"
printf 'Verified the linked CI package against %s.\n' "$commit"
