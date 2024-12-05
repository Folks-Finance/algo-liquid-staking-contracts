#!/bin/bash
set -e
echo "### Creating private network"
goal network create -n tn50e -t networktemplate.json -r net1
echo
echo "### Updating config"
echo '{ "GossipFanout": 0, "DNSBootstrapID": "", "EnableProfiler": true, "EnableDeveloperAPI": true, "EnableExperimentalAPI": true, "DisableNetworking": true }' > net1/Primary/config.json
echo
echo "### Updating token"
echo 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' > net1/Primary/algod.token
echo
echo "### Starting private network"
goal network start -r net1
echo
echo "### Checking node status"
goal network status -r net1
echo
echo "### Importing root keys"
NODEKEY=$(goal account list -d net1/Primary -w unencrypted-default-wallet | awk '{print $2}')
echo "Imported ${NODEKEY}"
echo
echo "### Import account and fund it fully"
MAIN=$(goal account import -d net1/Primary -w unencrypted-default-wallet -m "adapt mule code swamp target refuse inspire violin winner fashion reopen evoke crouch work swim segment subway hybrid donate orbit guess govern cost abstract vault" | awk '{print $2}')
echo "Imported $MAIN"
goal clerk send -d net1/Primary -w unencrypted-default-wallet -f "$NODEKEY" -t "$MAIN" -a 0 -c "$MAIN"
