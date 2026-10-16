#!/usr/bin/env bash
set -euo pipefail

# Configuration-only deployments also reinstall dependencies, so they need the
# same swap as application deployments. Both hooks ship in one bundle.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hooks/prebuild" && pwd)/00_ensure_swap.sh"
