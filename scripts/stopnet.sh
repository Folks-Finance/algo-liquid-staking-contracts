#!/bin/bash
set -e
goal network stop -r net1
goal network delete -r net1

rm -f *.tx
rm -f *.msgp
rm -f *.rej
