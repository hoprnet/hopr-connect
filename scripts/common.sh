

# setup paths
# find usable tmp dir
declare tmp="/tmp"
[[ -d "${tmp}" && -h "${tmp}" ]] && tmp="/var/tmp"
[[ -d "${tmp}" && -h "${tmp}" ]] && { msg "Neither /tmp or /var/tmp can be used for writing logs"; exit 1; }


declare flow_log="${tmp}/hopr-connect-flow.log"

declare alice_log="${tmp}/hopr-connect-alice.log"
declare alice_pipe="${tmp}/hopr-connect-alice-pipe.log"
declare alice_port=11090

declare bob_log="${tmp}/hopr-connect-bob.log"
declare bob_pipe="${tmp}/hopr-connect-bob-pipe.log"
declare bob_port=11091

declare charly_log="${tmp}/hopr-connect-charly.log"
declare charly_port=11092

declare dave_log="${tmp}/hopr-connect-dave.log"
declare dave_port=11093

declare ed_log="${tmp}/hopr-connect-ed.log"
declare ed_port=11094

function free_ports {
    for port in ${alice_port} ${bob_port} ${charly_port} ${dave_port} ${ed_port}; do
        if lsof -i ":${port}" -s TCP:LISTEN > /dev/null; then
          lsof -i ":${port}" -s TCP:LISTEN -t | xargs -I {} -n 1 kill {} 
        fi
    done
}

function cleanup {
  local EXIT_CODE=$?

  trap - SIGINT SIGTERM ERR EXIT

  free_ports

  exit $EXIT_CODE
}
trap cleanup SIGINT SIGTERM ERR EXIT

function start_node {
    declare filename=${1}
    declare log_file=${2}
    declare script=${3}
    declare rest_args=${@:4}

    DEBUG=hopr-connect*,simple-peer \
    yarn dlx \
    ts-node \
        "${filename}" \
        > "${log_file}" \
        ${rest_args} \
        --script "${script}" \
        2>&1 &
    declare pid=$!
    log "node started with PID ${pid}"
    log "args: ${rest_args}"
    log "script: "
    log "${script}"
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

log "alice logs -> ${alice_log}"
log "alice msgs -> ${alice_pipe}"
log "bob logs -> ${bob_log}"
log "bob msgs -> ${bob_pipe}"
log "charly logs -> ${charly_log}"
log "dave logs -> ${dave_log}"
log "ed logs -> ${ed_log}"
log "common flow log -> ${flow_log}"

function remove_logs {
  for file in "${alice_log}" "${bob_log}" "${charly_log}" "${dave_log}" "${ed_log}" "${alice_pipe}" "${bob_pipe}"; do 
    rm -Rf ${file}
  done  
}

function ensure_ports {
  for port in ${alice_port} ${bob_port} ${charly_port} ${dave_port}; do
    ensure_port_is_free ${port}
  done
}

function setup {
  log "Setting up new test run"

  free_ports
  remove_logs
  ensure_ports

  log "Test run setup finished"
}

function teardown {
  log "Tearing down test run"

  free_ports
  
  log "Test run teardown finished"
}
