# prevent souring of this script, only allow execution
$(return >/dev/null 2>&1)
test "$?" -eq "0" && { echo "This script should only be executed." >&2; exit 1; }
          
# set log id and use shared log function for readable logs
declare mydir
mydir=$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd -P)
declare HOPR_LOG_ID="hopr-connect-test"
source "${mydir}/../utils.sh"

# exit on errors, undefined variables, ensure errors in pipes are not hidden
set -Eeuo pipefail

source "${mydir}/../common.sh"

setup "stupid-messages"

# run alice (client)
# should be able to send 'test from alice' to bob through relay charly
start_node tests/node.ts \
    "${alice_log}" \
    "[ 
      {
        'cmd': 'wait',
        'waitForSecs': 2
      },
      {
        'cmd': 'msg',
        'targetPort': '${bob_port}',
        'targetIdentityName': 'bob',
        'msg': 'test from alice'
      },
      {
        'cmd': 'wait',
        'waitForSecs': 2
      }     
    ]" \
    --port ${alice_port} \
    --pipeFile "${alice_pipe}" \
    --identityName 'alice' \
    --noDirectConnections false \
    --noWebRTCUpgrade true \

start_stupid_node tests/stupid-node.ts \
    "${bob_log}" \
    --port ${bob_port} \
    --badAnswer \

wait_for_regex_in_file "${alice_log}" "dialProtocol to bob failed"
wait_for_regex_in_file "${alice_log}" "all tasks executed. exit code 1"

# TODO put into different test case

# Wait some time
# sleep 1

# start_node tests/node.ts \
#     "${alice_log}" \
#     "[ 
#       {
#         'cmd': 'wait',
#         'waitForSecs': 7
#       }   
#     ]" \
#     --port ${alice_port} \
#     --pipeFile "${alice_pipe}" \
#     --identityName 'alice' \
#     --noDirectConnections false \
#     --noWebRTCUpgrade true \

# sleep 3

# start_stupid_node tests/node.ts \
#     "${bob_log}" \
#     --port ${alice_port} \
#     --badDial

# wait_for_regex_in_file "${alice_log}" "all tasks executed. exit code 0"
