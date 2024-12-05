# algo-liquid-staking-contracts

## Overview
This repository contains the PyTeal implementation for the Folks Finance ALGO Liquid Staking protocol. 

Please refer to the [protocol design document](https://docs.google.com/document/d/1w-0ZmpWGTGrFl46PNhjmguEKj3ChnnFnMM3X_is1R9M/edit?usp=sharing ) for a comprehensive report on the design and implementation details of the protocol.

## Requirements
* Linux or macOS
* Python 3
* Goal

## Setup
To install all required packages, run:
```
python3 -m venv venv
source venv/bin/activate
python3 -m pip install -r requirements.txt
```
```
npm install
```

## Smart Contracts
The `contracts` folder contains the following:
* `contracts/common` contains common checks, inner transactions and a math library.
* `contracts/testing` contains all the smart contracts relating to testing. These are not deployed.
* `contracts/xlgo` contains all the smart contracts relating to the newest version of ALGO Liquid Staking. These will be deployed.

## Testing
Make sure port 8080 is free as the private network setup for testing will use this port. 

Run all tests from root directory using:
```
PYTHONPATH="./contracts" jest --runInBand
```
or single test file using:
```
PYTHONPATH="./contracts" jest <PATH_TO_TEST_FILE>
```

Each test file creates a private network in dev mode, sequentially submits transactions to it, and then tears it down. Therefore it is not possible to run the tests in parallel so `--runInBand` option is passed. Port 8080 must be available for the private network to use.
