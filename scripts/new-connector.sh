#!/usr/bin/env bash
# Copy this connector to /workspace/connectors/<name>.
#
# Rewrites:
#   - the current package name (read from package.json)
#   - the placeholder token __CONNECTOR_NAME__
#
# Skips node_modules, dist, coverage, and .git.
# Refuses to overwrite an existing destination.
# This file is not rewritten, so the token above stays a real placeholder.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: npm run new -- <name>" >&2
  exit 1
fi

NAME="$1"
if [[ ! "$NAME" =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]]; then
  echo "error: name must be kebab-case, for example acme-search" >&2
  exit 1
fi

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="/workspace/connectors/${NAME}"

if [[ "$DEST" == "$SRC" ]]; then
  echo "error: destination is the source directory" >&2
  exit 1
fi

if [[ -e "$DEST" ]]; then
  echo "error: ${DEST} already exists; refusing to overwrite" >&2
  exit 1
fi

OLD_NAME="$(
  node --input-type=module -e '
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (typeof pkg.name !== "string" || pkg.name === "") {
  console.error("error: package.json is missing a name");
  process.exit(2);
}
process.stdout.write(pkg.name);
' "$SRC/package.json"
)"

if [[ "$NAME" == "$OLD_NAME" ]]; then
  echo "error: name matches the current package name (${OLD_NAME})" >&2
  exit 1
fi

mkdir -p "$DEST"
tar -C "$SRC" \
  --exclude node_modules \
  --exclude dist \
  --exclude coverage \
  --exclude .git \
  -cf - . | tar -C "$DEST" -xf -

while IFS= read -r -d '' file; do
  case "$file" in
    *.ts|*.tsx|*.js|*.mjs|*.cjs|*.json|*.md|*.yml|*.yaml|*.html|*.css|*.example|Dockerfile*|*.gitignore|*.prettierignore)
      ;;
    *)
      continue
      ;;
  esac
  node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const [file, oldName, name] = process.argv.slice(1);
const text = readFileSync(file, "utf8");
const next = text.split(oldName).join(name).split("__CONNECTOR_NAME__").join(name);
if (next !== text) writeFileSync(file, next);
' "$file" "$OLD_NAME" "$NAME"
done < <(find "$DEST" -type f ! -path '*/node_modules/*' ! -path '*/dist/*' -print0)

chmod +x "$DEST/scripts/new-connector.sh"
echo "created ${DEST}"
