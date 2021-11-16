#!/usr/bin/env bash
set -e

SCRIPT_PATH="$(dirname "${BASH_SOURCE[0]}")"
cd $SCRIPT_PATH

# Location that will be mounted as the /data volume in containers
# This is how we access the initial members and balances files from
# the containers and where generated chainspec files will be located.
DATA_PATH=${DATA_PATH:=~/tmp}

# Initial account balance for Alice
# Alice is the source of funds for all new accounts that are created in the tests.
ALICE_INITIAL_BALANCE=${ALICE_INITIAL_BALANCE:=100000000}

# The docker image tag to use for joystream/node as the starting chain
# that will be upgraded to the latest runtime.
RUNTIME=${RUNTIME:=latest}

mkdir -p ${DATA_PATH}

echo "{
  \"balances\":[
    [\"5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY\", ${ALICE_INITIAL_BALANCE}]
  ]
}" > ${DATA_PATH}/initial-balances.json

# Make Alice a member
# echo '
#   [{
#     "member_id":0,
#     "root_account":"5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
#     "controller_account":"5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
#     "handle":"alice",
#     "avatar_uri":"https://alice.com/avatar.png",
#     "about":"Alice",
#     "registered_at_time":0
#   }]
# ' > ${DATA_PATH}/initial-members.json

# Create a chain spec file
docker run --rm -v ${DATA_PATH}:/data --entrypoint ./chain-spec-builder joystream/node:${RUNTIME} \
  new \
  --authority-seeds Alice \
  --sudo-account  5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY \
  --deployment dev \
  --chain-spec-path /data/chain-spec.json \
  --initial-balances-path /data/initial-balances.json
# --initial-members-path /data/initial-members.json

# Convert the chain spec file to a raw chainspec file
docker run --rm -v ${DATA_PATH}:/data joystream/node:${RUNTIME} build-spec \
  --raw --disable-default-bootnode \
  --chain /data/chain-spec.json > ~/tmp/chain-spec-raw.json

# Start a chain with generated chain spec
export JOYSTREAM_NODE_TAG=${RUNTIME}
CONTAINER_ID=`docker-compose -f ../../docker-compose.yml run -d -v ${DATA_PATH}:/data --name joystream-node \
  -p 9944:9944 -p 9933:9933 joystream-node \
  --alice --validator --unsafe-ws-external --unsafe-rpc-external \
  --rpc-methods Unsafe --rpc-cors=all -l runtime \
  --chain /data/chain-spec-raw.json`

function cleanup() {
    docker logs ${CONTAINER_ID} --tail 15
    docker stop ${CONTAINER_ID}
    docker rm ${CONTAINER_ID}
    docker-compose -f ../../docker-compose.yml down -v
}

trap cleanup EXIT

sleep 3

# Display runtime version
yarn workspace api-scripts tsnode-strict src/status.ts | grep Runtime

# Start any other services we want
# docker-compose -f ../../docker-compose.yml up -d colossus-1

# Start a query-node
../../query-node/start.sh

# Execute tests

# We can load env config used to start docker services and pass them on to the
# tests. This could be useful to capture keys used or URLs.
# We just have to watchout for clashing env var names.
#set -a
#. ../../.env
#set +a

# First scenario..
./run-test-scenario.sh $1

# In between pickup generated keys from first scenario or bootstrap scene will all well known
# keys for roles and members..

# Second scenario..
# ./run-test-scenario.sh $2