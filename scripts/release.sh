#!/usr/bin/env bash

# prevent souring of this script, only allow execution
$(return >/dev/null 2>&1)
test "$?" -eq "0" && { echo "This script should only be executed." >&2; exit 1; }

# exit on errors, undefined variables, ensure errors in pipes are not hidden
set -Eeuo pipefail

declare mydir

mydir=$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd -P)

declare new_version
new_version=$(HOPR_PACKAGE=hoprd ${mydir}/get-package-version.sh)

git tag v${new_version}

git push --tags