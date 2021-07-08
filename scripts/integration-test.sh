#!/usr/bin/env bash

# prevent souring of this script, only allow execution
$(return >/dev/null 2>&1)
test "$?" -eq "0" && { echo "This script should only be executed." >&2; exit 1; }

# exit on errors, undefined variables, ensure errors in pipes are not hidden
set -Eeuo pipefail

# set log id and use shared log function for readable logs
declare mydir
mydir=$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd -P)
declare HOPR_LOG_ID="hopr-connect-test"
source "${mydir}/../scripts/utils.sh"

usage() {
  msg
  msg "Usage: $0"
  msg
}

function cleanup {
  local EXIT_CODE=$?

  trap - SIGINT SIGTERM ERR EXIT

  # Cleaning up everything
  log "Stopping up processes"
  for pid in ${server_pid}; do
    log "${pid}"
    kill -9 ${pid}
  done

  exit $EXIT_CODE
}
trap cleanup SIGINT SIGTERM ERR EXIT

# return early with help info when requested
([ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]) && { usage; exit 0; }

declare exit_code=0

# check prerequisites
which yarn > /dev/null || exit_code=$?

if [[ "${exit_code}" != 0 ]]; then
    log "⛔️ yarn is not installed"
    exit 1
fi

declare yarn_version=$(yarn -v)
declare yarn_version_parsed=( ${yarn_version//./ } )
if [[ "${yarn_version_parsed[0]}" != "2" ]]; then
    log "⛔️ yarn v2.x.x required, ${yarn_version} found"
    exit 1
fi

# setup paths
declare tmp="/tmp"
declare server_pid
declare server_log="${tmp}/hopr-connect-server.log"

log "Running server..."

DEBUG=hopr-connect*,simple-peer \
yarn dlx \
ts-node \
    examples/server.ts \
    > "${server_log}" \
    2>&1 &

server_pid=$!
log "Server started with PID ${server_pid}"
