#!/usr/bin/env bash

# prevent souring of this script, only allow execution
$(return >/dev/null 2>&1)
test "$?" -eq "0" && { echo "This script should only be executed." >&2; exit 1; }
          
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

# setup paths
declare tmp="/tmp"
declare server_log="${tmp}/hopr-connect-server.log"
declare server_pid

declare client0_log="${tmp}/hopr-connect-client0.log"
declare client0_pid

declare client1_log="${tmp}/hopr-connect-client1.log"
declare client1_pid

function free_ports {
    for port in 9090 9091 9092; do
        if lsof -i ":${port}" -s TCP:LISTEN; then
        lsof -i ":${port}" -s TCP:LISTEN -t | xargs -I {} -n 1 kill {}
        fi
    done
}

function cleanup {
  local EXIT_CODE=$?

  trap - SIGINT SIGTERM ERR EXIT

  # Cleaning up everything
  log "Stopping up processes"
  for pid in ${server_pid} ${client0_pid} ${client1_pid}; do
    kill -9 ${pid}
    log "killed ${pid}"    
  done

  free_ports

  exit $EXIT_CODE
}
trap cleanup SIGINT SIGTERM ERR EXIT

function start_node() {
    declare filename=${1}
    declare log_file=${2}
    declare rest_args=${@:3}

    DEBUG=hopr-connect*,simple-peer \
    yarn dlx \
    ts-node \
        "${filename}" \
        > "${log_file}" \
        ${rest_args} \
        2>&1 &
    declare pid=$!
    log "${filename} ${rest_args} started with PID ${pid}"
    echo ${pid}
}

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

free_ports

# check ports are free
ensure_port_is_free 9090
ensure_port_is_free 9091
ensure_port_is_free 9092

log "Test started"

# remove logs
rm -Rf "${server_log}"
rm -Rf "${client1_log}"
rm -Rf "${client0_log}"

# run nodes
server_pid=$(start_node examples/server.ts "${server_log}")
client1_pid=$(start_node examples/client.ts ${client1_log} 1)
client0_pid=$(start_node examples/client.ts ${client0_log} 0)

wait_for_regex_in_file ${client1_log} "Received message <test>"
wait_for_regex_in_file ${client0_log} "Received <Echoing <test>>"

log "Test succesful"