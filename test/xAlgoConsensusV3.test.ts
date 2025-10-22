import {
  ABIContract,
  Account,
  Algodv2,
  AtomicTransactionComposer,
  decodeAddress,
  decodeUint64,
  encodeUint64,
  generateAccount,
  getApplicationAddress,
  getMethodByName,
  IntDecoding,
  makeApplicationCallTxnFromObject,
  makeApplicationCreateTxn,
  makeApplicationUpdateTxn,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
  makeBasicAccountTransactionSigner,
  makePaymentTxnWithSuggestedParamsFromObject,
  modelsv2,
  OnApplicationComplete,
} from "algosdk";
import { mulScale, mulScaleRoundUp, ONE_16_DP, ONE_4_DP } from "folks-finance-js-sdk";
import { sha256 } from "js-sha256";
import { prepareOptIntoAssetTxn } from "./transactions/common";
import {
  parseXAlgoConsensusGlobalState,
  prepareAddProposerForXAlgoConsensus,
  prepareBurnFromXAlgoConsensus,
  prepareClaimDelayedMintFromXAlgoConsensus,
  prepareClaimXAlgoConsensusFee,
  prepareDelayedMintFromXAlgoConsensus,
  prepareImmediateMintFromXAlgoConsensus,
  prepareInitialiseXAlgoConsensusV2,
  prepareInitialiseXAlgoConsensusV3,
  preparePauseXAlgoConsensusMinting,
  prepareRegisterXAlgoConsensusOffline,
  prepareRegisterXAlgoConsensusOnline,
  prepareScheduleXAlgoConsensusSCUpdate,
  prepareUpdateXAlgoConsensusAdmin,
  prepareUpdateXAlgoConsensusFee,
  prepareUpdateXAlgoConsensusPremium,
  prepareUpdateXAlgoConsensusMaxProposerBalance,
  prepareUpdateXAlgoConsensusSC,
  prepareSetXAlgoConsensusProposerAdmin,
  prepareSubscribeXAlgoConsensusProposerToXGov,
  prepareUnsubscribeXAlgoConsensusProposerFromXGov,
  prepareXAlgoConsensusDummyCall,
  prepareCreateXAlgoConsensusV2,
  prepareMintFromXAlgoConsensus,
} from "./transactions/xAlgoConsensus";
import { getABIContract } from "./utils/abi";
import { getAlgoBalance, getAssetBalance } from "./utils/account";
import { getRandomBytes } from "./utils/bytes";
import {
  compilePyTeal,
  compileTeal,
  enc,
  getAppGlobalState,
  getParsedValueFromState,
  parseUint64s,
} from "./utils/contracts";
import { fundAccountWithAlgo } from "./utils/fund";
import { privateAlgodClient, startPrivateNetwork, stopPrivateNetwork } from "./utils/privateNetwork";
import { advanceBlockRounds, advancePrevBlockTimestamp } from "./utils/time";
import { getParams, submitGroupTransaction, submitTransaction } from "./utils/transaction";

jest.setTimeout(1000000);

describe("Algo Consensus V3", () => {
  let algodClient: Algodv2;
  let prevBlockTimestamp: bigint;
  let user1: Account = generateAccount();
  let user2: Account = generateAccount();
  let proposer0: Account = generateAccount();
  let proposer1: Account = generateAccount();
  let admin: Account = generateAccount();
  let registerAdmin: Account = generateAccount();
  let xGovAdmin: Account = generateAccount();
  let proposerAdmin: Account = generateAccount();
  let xAlgoAppId: number, xAlgoId: number;
  let xAlgoConsensusABI: ABIContract;

  let xGovRegistryAppId: number;
  let xGovRegistryABI: ABIContract;
  let xGovFee: bigint;

  const timeDelay = BigInt(86400);
  const minProposerBalance = BigInt(5e6);
  const maxProposerBalance = BigInt(500e6);
  const premium = BigInt(0.001e16); // 0.1%
  const fee = BigInt(0.1e4); // 10%

  const nonce = Uint8Array.from([0, 0]);
  const secondNonce = Uint8Array.from([0, 1]);
  const resizeProposerBoxCost = BigInt(16000);
  const updateSCBoxCost = BigInt(32100);
  const delayMintBoxCost = BigInt(36100);

  async function getXAlgoRate() {
    const atc = new AtomicTransactionComposer();
    atc.addMethodCall({
      sender: user1.addr,
      signer: makeBasicAccountTransactionSigner(user1),
      appID: xAlgoAppId,
      method: getMethodByName(xAlgoConsensusABI.methods, "get_xalgo_rate"),
      methodArgs: [],
      suggestedParams: await getParams(algodClient),
    });
    const simReq = new modelsv2.SimulateRequest({
      txnGroups: [],
      allowUnnamedResources: true,
    });
    const { methodResults } = await atc.simulate(algodClient, simReq);
    const { returnValue } = methodResults[0];
    const [algoBalance, xAlgoCirculatingSupply, balances]: [bigint, bigint, Uint8Array] = returnValue as any;
    const proposersBalances = parseUint64s(Buffer.from(balances).toString("base64"));
    return { algoBalance, xAlgoCirculatingSupply, proposersBalances };
  }

  beforeAll(async () => {
    await startPrivateNetwork();
    algodClient = privateAlgodClient();
    algodClient.setIntEncoding(IntDecoding.MIXED);

    // initialise accounts with algo
    await fundAccountWithAlgo(algodClient, user1.addr, 1000e6, await getParams(algodClient));
    await fundAccountWithAlgo(algodClient, user2.addr, 1000e6, await getParams(algodClient));
    await fundAccountWithAlgo(algodClient, admin.addr, 1000e6, await getParams(algodClient));
    await fundAccountWithAlgo(algodClient, registerAdmin.addr, 1000e6, await getParams(algodClient));
    await fundAccountWithAlgo(algodClient, xGovAdmin.addr, 1000e6, await getParams(algodClient));
    await fundAccountWithAlgo(algodClient, proposerAdmin.addr, 1000e6, await getParams(algodClient));

    // advance time well past current time so we are dealing with deterministic time using offsets
    prevBlockTimestamp = await advancePrevBlockTimestamp(algodClient, 1000);

    // deploy xgov registry
    const approval = await compileTeal(compilePyTeal("contracts/testing/xgov_registry"));
    const clear = await compileTeal(compilePyTeal("contracts/common/clear_program", 10));
    const tx = makeApplicationCreateTxn(
      user1.addr,
      await getParams(algodClient),
      OnApplicationComplete.NoOpOC,
      approval,
      clear,
      0,
      0,
      1,
      0,
    );
    const txId = await submitTransaction(algodClient, tx, user1.sk);
    const txInfo = await algodClient.pendingTransactionInformation(txId).do();
    xGovRegistryAppId = txInfo["application-index"];
    xGovRegistryABI = getABIContract("contracts/testing/xgov_registry");
    xGovFee = BigInt(getParsedValueFromState(await getAppGlobalState(algodClient, xGovRegistryAppId), "xgov_fee") || 0);
  });

  afterAll(() => {
    stopPrivateNetwork();
  });

  describe("creation", () => {
    test("succeeds in updating from x algo consensus v2 to x algo consensus v3", async () => {
      // deploy algo consensus v2
      const { tx: createTx, abi } = await prepareCreateXAlgoConsensusV2(
        admin.addr,
        admin.addr,
        registerAdmin.addr,
        xGovAdmin.addr,
        maxProposerBalance,
        premium,
        fee,
        await getParams(algodClient),
      );
      xAlgoConsensusABI = abi;
      let txId = await submitTransaction(algodClient, createTx, admin.sk);
      let txInfo = await algodClient.pendingTransactionInformation(txId).do();
      xAlgoAppId = txInfo["application-index"];

      // fund minimum balance
      await fundAccountWithAlgo(algodClient, proposer0.addr, BigInt(0.1e6), await getParams(algodClient));
      await fundAccountWithAlgo(algodClient, getApplicationAddress(xAlgoAppId), 0.6034e6);

      // initialise algo consensus v2
      const initTxns = prepareInitialiseXAlgoConsensusV2(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        proposer0.addr,
        await getParams(algodClient),
      );
      [, txId] = await submitGroupTransaction(algodClient, initTxns, [proposer0.sk, admin.sk]);
      txInfo = await algodClient.pendingTransactionInformation(txId).do();
      xAlgoId = txInfo["inner-txns"][0]["asset-index"];

      // verify xAlgo was created
      const assetInfo = await algodClient.getAssetByID(xAlgoId).do();
      expect(assetInfo.params.creator).toEqual(getApplicationAddress(xAlgoAppId));
      expect(assetInfo.params.reserve).toEqual(getApplicationAddress(xAlgoAppId));
      expect(assetInfo.params.total).toEqual(BigInt(10e15));
      expect(assetInfo.params.decimals).toEqual(6);
      expect(assetInfo.params.name).toEqual("Governance xAlgo");
      expect(assetInfo.params["unit-name"]).toEqual("xALGO");

      // opt into xALGO
      let optInTx = prepareOptIntoAssetTxn(admin.addr, xAlgoId, await getParams(algodClient));
      await submitTransaction(algodClient, optInTx, admin.sk);
      optInTx = prepareOptIntoAssetTxn(user1.addr, xAlgoId, await getParams(algodClient));
      await submitTransaction(algodClient, optInTx, user1.sk);
      optInTx = prepareOptIntoAssetTxn(user2.addr, xAlgoId, await getParams(algodClient));
      await submitTransaction(algodClient, optInTx, user2.sk);

      // mint to get pool started
      const mintAmount = BigInt(100e6);
      const mintTxns = prepareMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user2.addr,
        mintAmount,
        proposer0.addr,
        await getParams(algodClient),
      );
      await submitGroupTransaction(
        algodClient,
        mintTxns,
        mintTxns.map(() => user2.sk),
      );

      // verify global state
      const state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.initialised).toEqual(true);
      expect(state.admin).toEqual(admin.addr);
      expect(state.registerAdmin).toEqual(registerAdmin.addr);
      expect(state.xGovAdmin).toEqual(xGovAdmin.addr);
      expect(state.xAlgoId).toEqual(xAlgoId);
      expect(state.timeDelay).toEqual(BigInt(86400));
      expect(state.numProposers).toEqual(BigInt(1));
      expect(state.maxProposerBalance).toEqual(maxProposerBalance);
      expect(state.fee).toEqual(fee);
      expect(state.premium).toEqual(premium);
      expect(state.lastProposersActiveBalance).toEqual(BigInt(mintAmount));
      expect(state.totalPendingStake).toEqual(BigInt(0));
      expect(state.totalUnclaimedFees).toEqual(BigInt(0));
      expect(state.canImmediateMint).toEqual(true);
      expect(state.canDelayMint).toEqual(false);

      // verify proposers box
      const proposersBox = await algodClient.getApplicationBoxByName(xAlgoAppId, enc.encode("pr")).do();
      const proposers = new Uint8Array(960);
      proposers.set(decodeAddress(proposer0.addr).publicKey, 0);
      expect(proposersBox.value).toEqual(proposers);

      // verify added proposer box
      const boxName = Uint8Array.from([...enc.encode("ap"), ...decodeAddress(proposer0.addr).publicKey]);
      const addedProposerBox = await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
      expect(addedProposerBox.value).toEqual(new Uint8Array(0));

      // verify balances
      const user2XAlgoBalance = await getAssetBalance(algodClient, user2.addr, xAlgoId);
      expect(user2XAlgoBalance).toEqual(mintAmount);

      // update to algo consensus v3
      const approval = await compileTeal(compilePyTeal("contracts/xalgo/consensus_v3"));
      const clear = await compileTeal(compilePyTeal("contracts/common/clear_program", 10));
      const updateTx = makeApplicationUpdateTxn(admin.addr, await getParams(algodClient), xAlgoAppId, approval, clear);
      await submitTransaction(algodClient, updateTx, admin.sk);
      xAlgoConsensusABI = getABIContract("contracts/xalgo/consensus_v3");
    });
  });

  describe("initialise", () => {
    test("succeeds", async () => {
      const oldState = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const algoBalance = (await getAlgoBalance(algodClient, proposer0.addr)) - BigInt(0.1e6);

      // initialise
      const proposerAddrs = [proposer0.addr];
      const tx = prepareInitialiseXAlgoConsensusV3(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, user1.sk);

      // verify global state
      const unformattedState = await getAppGlobalState(algodClient, xAlgoAppId);
      expect(getParsedValueFromState(unformattedState, "initialised")).toBeUndefined();
      expect(getParsedValueFromState(unformattedState, "min_proposer_balance")).toBeUndefined();
      expect(getParsedValueFromState(unformattedState, "total_active_stake")).toBeUndefined();
      expect(getParsedValueFromState(unformattedState, "total_rewards")).toBeUndefined();

      const state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.initialised).toEqual(true);
      expect(state.admin).toEqual(oldState.admin);
      expect(state.registerAdmin).toEqual(oldState.registerAdmin);
      expect(state.xGovAdmin).toEqual(oldState.xGovAdmin);
      expect(state.timeDelay).toEqual(oldState.timeDelay);
      expect(state.xAlgoId).toEqual(oldState.xAlgoId);
      expect(state.numProposers).toEqual(oldState.numProposers);
      expect(state.maxProposerBalance).toEqual(oldState.maxProposerBalance);
      expect(state.fee).toEqual(oldState.fee);
      expect(state.premium).toEqual(oldState.premium);
      expect(state.lastProposersActiveBalance).toEqual(oldState.lastProposersActiveBalance);
      expect(state.totalPendingStake).toEqual(oldState.totalPendingStake);
      expect(state.totalUnclaimedFees).toEqual(oldState.totalUnclaimedFees);
      expect(state.canImmediateMint).toEqual(oldState.canImmediateMint);
      expect(state.canDelayMint).toEqual(oldState.canDelayMint);
    });

    test("fails when already setup", async () => {
      const tx = prepareInitialiseXAlgoConsensusV3(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; !; assert"),
      });
    });
  });

  describe("Update admin", () => {
    test("fails for invalid admin type", async () => {
      const tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "total_rewards",
        admin.addr,
        user1.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("==; ||; assert"),
      });
    });

    test.each([{ length: 30 }, { length: 34 }])(`fails when address length is $length bytes`, async ({ length }) => {
      const adminType = "admin";
      const newAdminAddr = getRandomBytes(length);
      const tx = makeApplicationCallTxnFromObject({
        from: admin.addr,
        appIndex: xAlgoAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        appArgs: [
          getMethodByName(xAlgoConsensusABI.methods, "update_admin").getSelector(),
          Uint8Array.from([...encodeUint64(adminType.length).slice(0, 2), ...enc.encode(adminType)]),
          newAdminAddr,
        ],
        suggestedParams: await getParams(algodClient),
      });
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("// 32; ==; assert"),
      });
    });

    test("admins can update admins", async () => {
      // admin updating admin
      let tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "admin",
        admin.addr,
        user1.addr,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.admin).toEqual(user1.addr);

      // restore old admin
      tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "admin",
        user1.addr,
        admin.addr,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, user1.sk);
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.admin).toEqual(admin.addr);

      // admin updating register admin
      tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "register_admin",
        admin.addr,
        user1.addr,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.registerAdmin).toEqual(user1.addr);

      // register admin updating register admin
      tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "register_admin",
        user1.addr,
        registerAdmin.addr,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, user1.sk);
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.registerAdmin).toEqual(registerAdmin.addr);

      // admin updating xgov admin
      tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "xgov_admin",
        admin.addr,
        user1.addr,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.xGovAdmin).toEqual(user1.addr);

      // xgov admin updating xgov admin
      tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "xgov_admin",
        user1.addr,
        xGovAdmin.addr,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, user1.sk);
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.xGovAdmin).toEqual(xGovAdmin.addr);
    });

    test("non-admin cannot update admins", async () => {
      const state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);

      // user updating register admin
      expect(state.registerAdmin).not.toEqual(user1.addr);
      let tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "register_admin",
        user1.addr,
        admin.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("===; ||; assert"),
      });

      // user updating xgov admin
      expect(state.registerAdmin).not.toEqual(user1.addr);
      tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "xgov_admin",
        user1.addr,
        admin.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("===; ||; assert"),
      });

      // user updating admin
      expect(state.admin).not.toEqual(user1.addr);
      tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "admin",
        user1.addr,
        admin.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("===; ||; assert"),
      });

      // register admin updating admin
      expect(state.admin).not.toEqual(registerAdmin.addr);
      tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "admin",
        registerAdmin.addr,
        registerAdmin.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, registerAdmin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("===; ||; assert"),
      });

      // xgov admin updating admin
      expect(state.admin).not.toEqual(xGovAdmin.addr);
      tx = prepareUpdateXAlgoConsensusAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        "admin",
        xGovAdmin.addr,
        xGovAdmin.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, xGovAdmin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("===; ||; assert"),
      });
    });
  });

  describe("add proposer", () => {
    beforeAll(async () => {
      // fund proposer with min balance
      await fundAccountWithAlgo(algodClient, proposer1.addr, BigInt(0.1e6), await getParams(algodClient));
    });

    test("fails for non register admin", async () => {
      // fails for user address
      let txns = prepareAddProposerForXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        proposer1.addr,
        await getParams(algodClient),
      );
      await expect(submitGroupTransaction(algodClient, txns, [proposer1.sk, user1.sk])).rejects.toMatchObject({
        message: expect.stringContaining("callsub label47; assert"),
      });

      // fails even for admin
      txns = prepareAddProposerForXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        proposer1.addr,
        await getParams(algodClient),
      );
      await expect(submitGroupTransaction(algodClient, txns, [proposer1.sk, admin.sk])).rejects.toMatchObject({
        message: expect.stringContaining("callsub label47; assert"),
      });
    });

    test("fails if proposer is not rekeyed", async () => {
      // not rekeyed to anything
      let txns = prepareAddProposerForXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        registerAdmin.addr,
        proposer1.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, txns[1], registerAdmin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("global CurrentApplicationAddress; ==; assert"),
      });

      // rekeyed to wrong address
      txns = prepareAddProposerForXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        registerAdmin.addr,
        proposer1.addr,
        await getParams(algodClient),
      );
      txns[0].reKeyTo = decodeAddress(user1.addr);
      await expect(submitGroupTransaction(algodClient, txns, [proposer1.sk, registerAdmin.sk])).rejects.toMatchObject({
        message: expect.stringContaining("global CurrentApplicationAddress; ==; assert"),
      });
    });

    test("fails when proposer has already been added", async () => {
      const txns = prepareAddProposerForXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        registerAdmin.addr,
        proposer0.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, txns[1], registerAdmin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("box_create; assert"),
      });
    });

    test("succeeds for register admin for second proposer", async () => {
      const minBalance = BigInt(16100);
      await fundAccountWithAlgo(
        algodClient,
        getApplicationAddress(xAlgoAppId),
        minBalance,
        await getParams(algodClient),
      );

      // balances before
      const proposerAlgoBalanceB = await getAlgoBalance(algodClient, proposer0.addr);
      const appAlgoBalanceB = await getAlgoBalance(algodClient, getApplicationAddress(xAlgoAppId));
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const { lastProposersActiveBalance: oldLastProposersActiveBalance } = state;

      // register
      const txns = prepareAddProposerForXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        registerAdmin.addr,
        proposer1.addr,
        await getParams(algodClient),
      );
      const [, txId] = await submitGroupTransaction(algodClient, txns, [proposer1.sk, registerAdmin.sk]);
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.lastProposersActiveBalance).toEqual(oldLastProposersActiveBalance);

      // balances after
      const { proposersBalances } = await getXAlgoRate();
      const proposerAlgoBalanceA = await getAlgoBalance(algodClient, proposer0.addr);
      const appAlgoBalanceA = await getAlgoBalance(algodClient, getApplicationAddress(xAlgoAppId));
      expect(proposersBalances.length).toEqual(2);
      expect(proposersBalances[1]).toEqual(BigInt(0.1e6));
      expect(proposerAlgoBalanceA).toEqual(proposerAlgoBalanceB);
      expect(appAlgoBalanceA).toEqual(appAlgoBalanceB);
      expect(txInfo["inner-txns"]).toBeUndefined();

      // verify proposers box
      const proposersBox = await algodClient.getApplicationBoxByName(xAlgoAppId, enc.encode("pr")).do();
      const proposers = new Uint8Array(960);
      proposers.set(decodeAddress(proposer0.addr).publicKey, 0);
      proposers.set(decodeAddress(proposer1.addr).publicKey, 32);
      expect(proposersBox.value).toEqual(proposers);

      // verify added proposer box
      const boxName = Uint8Array.from([...enc.encode("ap"), ...decodeAddress(proposer1.addr).publicKey]);
      const addedProposerBox = await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
      expect(addedProposerBox.value).toEqual(new Uint8Array(0));
    });
  });

  describe("update max proposer", () => {
    test("fails for non-admin", async () => {
      const tx = prepareUpdateXAlgoConsensusMaxProposerBalance(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        maxProposerBalance,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; ==; assert"),
      });
    });

    test("succeeds for admin", async () => {
      const tempMaxProposerBalance = BigInt(1e12);

      // admin updating proposer balance range
      let tx = prepareUpdateXAlgoConsensusMaxProposerBalance(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        tempMaxProposerBalance,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.maxProposerBalance).toEqual(tempMaxProposerBalance);

      // restore old proposer balance range
      tx = prepareUpdateXAlgoConsensusMaxProposerBalance(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        maxProposerBalance,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.maxProposerBalance).toEqual(maxProposerBalance);
    });
  });

  describe("update premium", () => {
    test("fails for non-admin", async () => {
      const tx = prepareUpdateXAlgoConsensusPremium(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        premium,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; ==; assert"),
      });
    });

    test("fails when premium is greater than 1%", async () => {
      const premium = BigInt(0.01e16) + BigInt(1);
      const tx = prepareUpdateXAlgoConsensusPremium(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        premium,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("100000000000000; <=; assert"),
      });
    });

    test("succeeds for admin", async () => {
      // update premium
      const tempPremium = BigInt(0.0025e16);
      let tx = prepareUpdateXAlgoConsensusPremium(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        tempPremium,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.premium).toEqual(tempPremium);

      // restore old premium
      tx = prepareUpdateXAlgoConsensusPremium(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        premium,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.premium).toEqual(premium);
    });
  });

  describe("pause minting", () => {
    test("fails for non-admin", async () => {
      const tx = preparePauseXAlgoConsensusMinting(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        "can_immediate_mint",
        false,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; ==; assert"),
      });
    });

    test("fails for invalid minting type", async () => {
      const tx = preparePauseXAlgoConsensusMinting(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        "initialised",
        false,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("==; ||; assert"),
      });
    });

    test("succeeds for admin", async () => {
      const { canImmediateMint, canDelayMint } = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);

      // update pause minting
      let tx = preparePauseXAlgoConsensusMinting(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        "can_immediate_mint",
        canImmediateMint,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      tx = preparePauseXAlgoConsensusMinting(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        "can_delay_mint",
        canDelayMint,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.canImmediateMint).toEqual(!canImmediateMint);
      expect(state.canDelayMint).toEqual(!canDelayMint);

      // restore pause minting
      tx = preparePauseXAlgoConsensusMinting(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        "can_immediate_mint",
        !canImmediateMint,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      tx = preparePauseXAlgoConsensusMinting(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        "can_delay_mint",
        !canDelayMint,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.canImmediateMint).toEqual(canImmediateMint);
      expect(state.canDelayMint).toEqual(canDelayMint);
    });
  });

  describe("set proposer admin", () => {
    test.each([{ length: 30 }, { length: 34 }])(`fails when address length is $length bytes`, async ({ length }) => {
      const newAdminAddr = getRandomBytes(length);
      const tx = makeApplicationCallTxnFromObject({
        from: registerAdmin.addr,
        appIndex: xAlgoAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        appArgs: [
          getMethodByName(xAlgoConsensusABI.methods, "set_proposer_admin").getSelector(),
          encodeUint64(0),
          newAdminAddr,
        ],
        boxes: [
          { appIndex: xAlgoAppId, name: enc.encode("pr") },
          {
            appIndex: xAlgoAppId,
            name: Uint8Array.from([...enc.encode("ap"), ...decodeAddress(proposer0.addr).publicKey]),
          },
        ],
        suggestedParams: await getParams(algodClient),
      });
      await expect(submitTransaction(algodClient, tx, registerAdmin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("// 32; ==; assert"),
      });
    });

    test("succeeds for register admin", async () => {
      const boxName = Uint8Array.from([...enc.encode("ap"), ...decodeAddress(proposer0.addr).publicKey]);
      let addedProposerBox = await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
      expect(addedProposerBox.value).toEqual(new Uint8Array(0));

      // fund box
      await fundAccountWithAlgo(
        algodClient,
        getApplicationAddress(xAlgoAppId),
        resizeProposerBoxCost,
        await getParams(algodClient),
      );

      // immediate if no existing proposer admin
      let tx = prepareSetXAlgoConsensusProposerAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        registerAdmin.addr,
        0,
        proposer0.addr,
        user1.addr,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, registerAdmin.sk);
      addedProposerBox = await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
      expect(addedProposerBox.value).toEqual(
        Uint8Array.from([...encodeUint64(prevBlockTimestamp), ...decodeAddress(user1.addr).publicKey]),
      );

      // delay if existing proposer admin
      tx = prepareSetXAlgoConsensusProposerAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        registerAdmin.addr,
        0,
        proposer0.addr,
        proposerAdmin.addr,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, registerAdmin.sk);
      addedProposerBox = await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
      expect(addedProposerBox.value).toEqual(
        Uint8Array.from([
          ...encodeUint64(prevBlockTimestamp + timeDelay),
          ...decodeAddress(proposerAdmin.addr).publicKey,
        ]),
      );
    });

    test("fails for pending proposer admin", async () => {
      const tx = prepareSetXAlgoConsensusProposerAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        proposerAdmin.addr,
        0,
        proposer0.addr,
        proposerAdmin.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, proposerAdmin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("extract_uint64; >; assert"),
      });
    });

    test("succeeds for proposer admin", async () => {
      const boxName = Uint8Array.from([...enc.encode("ap"), ...decodeAddress(proposer0.addr).publicKey]);

      // proceed to timestamp
      const ts = decodeUint64(
        (await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do()).value.subarray(0, 8),
        "bigint",
      );
      const offset = Number(ts - prevBlockTimestamp) + 1;
      prevBlockTimestamp = await advancePrevBlockTimestamp(algodClient, offset);

      // succeeds with immediate effect
      let tx = prepareSetXAlgoConsensusProposerAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        proposerAdmin.addr,
        0,
        proposer0.addr,
        user1.addr,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, proposerAdmin.sk);
      let addedProposerBox = await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
      expect(addedProposerBox.value).toEqual(
        Uint8Array.from([...encodeUint64(prevBlockTimestamp), ...decodeAddress(user1.addr).publicKey]),
      );

      // restore old admin
      prevBlockTimestamp = await advancePrevBlockTimestamp(algodClient, 1);
      tx = prepareSetXAlgoConsensusProposerAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        0,
        proposer0.addr,
        proposerAdmin.addr,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, user1.sk);
      addedProposerBox = await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
      expect(addedProposerBox.value).toEqual(
        Uint8Array.from([...encodeUint64(prevBlockTimestamp), ...decodeAddress(proposerAdmin.addr).publicKey]),
      );
    });

    test("fails for non register or proposer admin", async () => {
      prevBlockTimestamp = await advancePrevBlockTimestamp(algodClient, 1);

      // fails for user address
      let tx = prepareSetXAlgoConsensusProposerAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        0,
        proposer0.addr,
        user1.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("extract 8 32; ==; assert"),
      });

      // fails even for admin
      tx = prepareSetXAlgoConsensusProposerAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        0,
        proposer0.addr,
        admin.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("extract 8 32; ==; assert"),
      });
    });

    test("fails when proposer does not exist", async () => {
      const proposerIndex = 2;
      const tx = prepareSetXAlgoConsensusProposerAdmin(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        proposerIndex,
        proposer1.addr,
        admin.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; <; assert"),
      });
    });
  });

  describe("register online", () => {
    const registerFeeAmount = BigInt(2e6);
    const voteKey = Buffer.from("G/lqTV6MKspW6J8wH2d8ZliZ5XZVZsruqSBJMwLwlmo=", "base64");
    const selKey = Buffer.from("LrpLhvzr+QpN/bivh6IPpOaKGbGzTTB5lJtVfixmmgk=", "base64");
    const stateProofKey = Buffer.from(
      "Nn0fiJDZH2wyLqxNzrOC3WPF8Vz3AH8JU1IGI2H2xdcnRiqw7YuWkohuKHpC1EJMAe6ZVbUS/S2rPeCRAolfRQ==",
      "base64",
    );
    const voteFirstRound = 1;
    const voteLastRound = 5000;
    const voteKeyDilution = 1500;

    test("fails for non proposer admin", async () => {
      // fails for user address
      let txns = prepareRegisterXAlgoConsensusOnline(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        registerFeeAmount,
        0,
        proposer0.addr,
        voteKey,
        selKey,
        stateProofKey,
        voteFirstRound,
        voteLastRound,
        voteKeyDilution,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("extract 8 32; ==; assert"),
      });

      // fails even for register admin
      txns = prepareRegisterXAlgoConsensusOnline(
        xAlgoConsensusABI,
        xAlgoAppId,
        registerAdmin.addr,
        registerFeeAmount,
        0,
        proposer0.addr,
        voteKey,
        selKey,
        stateProofKey,
        voteFirstRound,
        voteLastRound,
        voteKeyDilution,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => registerAdmin.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("extract 8 32; ==; assert"),
      });

      // fails even for admin
      txns = prepareRegisterXAlgoConsensusOnline(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        registerFeeAmount,
        0,
        proposer0.addr,
        voteKey,
        selKey,
        stateProofKey,
        voteFirstRound,
        voteLastRound,
        voteKeyDilution,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => admin.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("extract 8 32; ==; assert"),
      });
    });

    test("fails when you don't send algo", async () => {
      // send algo to unknown
      let txns = prepareRegisterXAlgoConsensusOnline(
        xAlgoConsensusABI,
        xAlgoAppId,
        proposerAdmin.addr,
        registerFeeAmount,
        0,
        proposer0.addr,
        voteKey,
        selKey,
        stateProofKey,
        voteFirstRound,
        voteLastRound,
        voteKeyDilution,
        await getParams(algodClient),
      );
      txns[0].to = decodeAddress(proposerAdmin.addr);
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => proposerAdmin.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("frame_dig -1; ==; assert"),
      });

      // send algo to wrong proposer
      txns = prepareRegisterXAlgoConsensusOnline(
        xAlgoConsensusABI,
        xAlgoAppId,
        proposerAdmin.addr,
        registerFeeAmount,
        0,
        proposer0.addr,
        voteKey,
        selKey,
        stateProofKey,
        voteFirstRound,
        voteLastRound,
        voteKeyDilution,
        await getParams(algodClient),
      );
      txns[0].to = decodeAddress(proposer1.addr);
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => proposerAdmin.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("frame_dig -1; ==; assert"),
      });
    });

    test("fails when proposer does not exist", async () => {
      const proposerIndex = 2;
      const txns = prepareRegisterXAlgoConsensusOnline(
        xAlgoConsensusABI,
        xAlgoAppId,
        proposerAdmin.addr,
        registerFeeAmount,
        proposerIndex,
        proposer0.addr,
        voteKey,
        selKey,
        stateProofKey,
        voteFirstRound,
        voteLastRound,
        voteKeyDilution,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => proposerAdmin.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; <; assert"),
      });
    });

    test("succeeds for proposer admin", async () => {
      const txns = prepareRegisterXAlgoConsensusOnline(
        xAlgoConsensusABI,
        xAlgoAppId,
        proposerAdmin.addr,
        registerFeeAmount,
        0,
        proposer0.addr,
        voteKey,
        selKey,
        stateProofKey,
        voteFirstRound,
        voteLastRound,
        voteKeyDilution,
        await getParams(algodClient),
      );
      const [, txId] = await submitGroupTransaction(
        algodClient,
        txns,
        txns.map(() => proposerAdmin.sk),
      );
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();

      // check key registration
      const innerRegisterOnlineTx = txInfo["inner-txns"][0]["txn"]["txn"];
      expect(innerRegisterOnlineTx.type).toEqual("keyreg");
      expect(innerRegisterOnlineTx.snd).toEqual(Uint8Array.from(decodeAddress(proposer0.addr).publicKey));
      expect(innerRegisterOnlineTx.votekey).toEqual(Uint8Array.from(voteKey));
      expect(innerRegisterOnlineTx.selkey).toEqual(Uint8Array.from(selKey));
      expect(innerRegisterOnlineTx.sprfkey).toEqual(Uint8Array.from(stateProofKey));
      expect(innerRegisterOnlineTx.votefst).toEqual(voteFirstRound);
      expect(innerRegisterOnlineTx.votelst).toEqual(voteLastRound);
      expect(innerRegisterOnlineTx.votekd).toEqual(voteKeyDilution);
      expect(innerRegisterOnlineTx.fee).toEqual(Number(registerFeeAmount));
    });
  });

  describe("register offline", () => {
    test("fails for non register admin", async () => {
      // fails for user address
      let tx = prepareRegisterXAlgoConsensusOffline(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        0,
        proposer0.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("extract 8 32; ==; assert"),
      });

      // fails even for admin
      tx = prepareRegisterXAlgoConsensusOffline(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        0,
        proposer0.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("extract 8 32; ==; assert"),
      });
    });

    test("fails when proposer does not exist", async () => {
      const proposerIndex = 2;
      const tx = prepareRegisterXAlgoConsensusOffline(
        xAlgoConsensusABI,
        xAlgoAppId,
        registerAdmin.addr,
        proposerIndex,
        proposer0.addr,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, registerAdmin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; <; assert"),
      });
    });

    test("succeeds for register and proposer admin", async () => {
      for (const sender of [registerAdmin, proposerAdmin]) {
        const tx = prepareRegisterXAlgoConsensusOffline(
          xAlgoConsensusABI,
          xAlgoAppId,
          sender.addr,
          0,
          proposer0.addr,
          await getParams(algodClient),
        );
        const txId = await submitTransaction(algodClient, tx, sender.sk);
        const txInfo = await algodClient.pendingTransactionInformation(txId).do();

        // check key registration
        const innerRegisterOnlineTx = txInfo["inner-txns"][0]["txn"]["txn"];
        expect(innerRegisterOnlineTx.type).toEqual("keyreg");
        expect(innerRegisterOnlineTx.snd).toEqual(Uint8Array.from(decodeAddress(proposer0.addr).publicKey));
        expect(innerRegisterOnlineTx.votekey).toBeUndefined();
        expect(innerRegisterOnlineTx.selkey).toBeUndefined();
        expect(innerRegisterOnlineTx.sprfkey).toBeUndefined();
        expect(innerRegisterOnlineTx.votefst).toBeUndefined();
        expect(innerRegisterOnlineTx.votelst).toBeUndefined();
        expect(innerRegisterOnlineTx.votekd).toBeUndefined();
        expect(innerRegisterOnlineTx.fee).toBeUndefined();
      }
    });
  });

  describe("subscribe to xgov", () => {
    test("fails for non xgov admin", async () => {
      // fails for user address
      let txns = prepareSubscribeXAlgoConsensusProposerToXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        xGovFee,
        0,
        proposer0.addr,
        xGovRegistryAppId,
        admin.addr,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; ==; assert"),
      });

      // fails even for admin
      txns = prepareSubscribeXAlgoConsensusProposerToXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        xGovFee,
        0,
        proposer0.addr,
        xGovRegistryAppId,
        admin.addr,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => admin.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; ==; assert"),
      });
    });

    test("fails when proposer does not exist", async () => {
      const proposerIndex = 2;
      const txns = prepareSubscribeXAlgoConsensusProposerToXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        xGovAdmin.addr,
        xGovFee,
        proposerIndex,
        proposer0.addr,
        xGovRegistryAppId,
        admin.addr,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => xGovAdmin.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; <; assert"),
      });
    });

    test("fails when don't send xgov fee", async () => {
      // send algo to unknown
      let txns = prepareSubscribeXAlgoConsensusProposerToXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        xGovAdmin.addr,
        xGovFee,
        0,
        proposer0.addr,
        xGovRegistryAppId,
        admin.addr,
        await getParams(algodClient),
      );
      txns[0].to = decodeAddress(xGovAdmin.addr);
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => xGovAdmin.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("frame_dig -1; ==; assert"),
      });

      // send algo to proposer
      txns = prepareSubscribeXAlgoConsensusProposerToXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        xGovAdmin.addr,
        xGovFee,
        0,
        proposer0.addr,
        xGovRegistryAppId,
        admin.addr,
        await getParams(algodClient),
      );
      txns[0].to = decodeAddress(proposer0.addr);
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => xGovAdmin.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("frame_dig -1; ==; assert"),
      });

      // send less algo than needed
      txns = prepareSubscribeXAlgoConsensusProposerToXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        xGovAdmin.addr,
        xGovFee - BigInt(1),
        0,
        proposer0.addr,
        xGovRegistryAppId,
        admin.addr,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => xGovAdmin.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("load 24; ==; assert"),
      });

      // send more algo than needed
      txns = prepareSubscribeXAlgoConsensusProposerToXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        xGovAdmin.addr,
        xGovFee + BigInt(1),
        0,
        proposer0.addr,
        xGovRegistryAppId,
        admin.addr,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => xGovAdmin.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("load 24; ==; assert"),
      });
    });

    test("succeeds for xgov admin", async () => {
      const txns = prepareSubscribeXAlgoConsensusProposerToXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        xGovAdmin.addr,
        xGovFee,
        0,
        proposer0.addr,
        xGovRegistryAppId,
        admin.addr,
        await getParams(algodClient),
      );
      const [, txId] = await submitGroupTransaction(
        algodClient,
        txns,
        txns.map(() => xGovAdmin.sk),
      );
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const { txn: transfer } = txInfo["inner-txns"][0].txn;
      const { txn: subscribe } = txInfo["inner-txns"][1].txn;

      // check inner txns
      expect(txInfo["inner-txns"].length).toEqual(2);
      expect(transfer.type).toEqual("pay");
      expect(transfer.amt).toEqual(Number(xGovFee));
      expect(transfer.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(transfer.rcv).toEqual(decodeAddress(getApplicationAddress(xGovRegistryAppId)).publicKey);
      expect(subscribe.type).toEqual("appl");
      expect(subscribe.apid).toEqual(xGovRegistryAppId);
      expect(subscribe.apaa).toEqual([
        xGovRegistryABI.getMethodByName("subscribe_xgov").getSelector(),
        decodeAddress(admin.addr).publicKey,
      ]);
    });
  });

  describe("unsubscribe from xgov", () => {
    test("fails for non xgov admin", async () => {
      // fails for user address
      let tx = prepareUnsubscribeXAlgoConsensusProposerFromXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        0,
        proposer0.addr,
        xGovRegistryAppId,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; ==; assert"),
      });

      // fails even for admin
      tx = prepareUnsubscribeXAlgoConsensusProposerFromXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        0,
        proposer0.addr,
        xGovRegistryAppId,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; ==; assert"),
      });
    });

    test("fails when proposer does not exist", async () => {
      const proposerIndex = 2;
      const tx = prepareUnsubscribeXAlgoConsensusProposerFromXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        xGovAdmin.addr,
        proposerIndex,
        proposer0.addr,
        xGovRegistryAppId,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, xGovAdmin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; <; assert"),
      });
    });

    test("succeeds for xgov admin", async () => {
      const tx = prepareUnsubscribeXAlgoConsensusProposerFromXGov(
        xAlgoConsensusABI,
        xAlgoAppId,
        xGovAdmin.addr,
        0,
        proposer0.addr,
        xGovRegistryAppId,
        await getParams(algodClient),
      );
      const txId = await submitTransaction(algodClient, tx, xGovAdmin.sk);
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const { txn: unsubscribe } = txInfo["inner-txns"][0].txn;

      // check inner txn
      expect(txInfo["inner-txns"].length).toEqual(1);
      expect(unsubscribe.type).toEqual("appl");
      expect(unsubscribe.apid).toEqual(xGovRegistryAppId);
      expect(unsubscribe.apaa).toEqual([
        xGovRegistryABI.getMethodByName("unsubscribe_xgov").getSelector(),
        decodeAddress(proposer0.addr).publicKey,
      ]);
    });
  });

  describe("immediate mint", () => {
    test("fails when immediate mint is paused", async () => {
      // pause immediate mint
      let tx = preparePauseXAlgoConsensusMinting(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        "can_immediate_mint",
        true,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      const state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.canImmediateMint).toEqual(false);

      // immediate mint
      const mintAmount = BigInt(10e6);
      const minReceived = BigInt(0);
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = prepareImmediateMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user1.addr,
        user1.addr,
        mintAmount,
        minReceived,
        proposerAddrs,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('"can_immediate_mint"; app_global_get; assert'),
      });

      // resume immediate mint
      tx = preparePauseXAlgoConsensusMinting(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        "can_immediate_mint",
        false,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
    });

    test.each([{ length: 30 }, { length: 34 }])(`fails when address length is $length bytes`, async ({ length }) => {
      const receiverAddr = getRandomBytes(length);
      const params = await getParams(algodClient);
      const txns = [
        makePaymentTxnWithSuggestedParamsFromObject({
          from: user1.addr,
          to: getApplicationAddress(xAlgoAppId),
          amount: BigInt(10e6),
          suggestedParams: params,
        }),
        makeApplicationCallTxnFromObject({
          from: user1.addr,
          appIndex: xAlgoAppId,
          onComplete: OnApplicationComplete.NoOpOC,
          appArgs: [
            getMethodByName(xAlgoConsensusABI.methods, "immediate_mint").getSelector(),
            receiverAddr,
            encodeUint64(0),
          ],
          suggestedParams: params,
        }),
      ];
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("// 32; ==; assert"),
      });
    });

    test("fails when you don't send algo", async () => {
      const mintAmount = BigInt(10e6);
      const minReceived = BigInt(0);
      const proposerAddrs = [proposer0.addr, proposer1.addr];

      // send algo to unknown
      let txns = prepareImmediateMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user1.addr,
        user1.addr,
        mintAmount,
        minReceived,
        proposerAddrs,
        await getParams(algodClient),
      );
      txns[0].to = decodeAddress(user1.addr);
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("frame_dig -1; ==; assert"),
      });

      // send algo to proposer
      txns = prepareImmediateMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user1.addr,
        user1.addr,
        mintAmount,
        minReceived,
        proposerAddrs,
        await getParams(algodClient),
      );
      txns[0].to = decodeAddress(proposer0.addr);
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("frame_dig -1; ==; assert"),
      });
    });

    test("fails when proposer max balance is exceeded", async () => {
      const { algoBalance } = await getXAlgoRate();
      const mintAmount = maxProposerBalance * BigInt(2) - algoBalance;
      const minReceived = BigInt(0);
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = prepareImmediateMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user1.addr,
        user1.addr,
        mintAmount,
        minReceived,
        proposerAddrs,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; <=; assert"),
      });
    });

    test("fails when you receive less x algo than min received specified", async () => {
      const { algoBalance, xAlgoCirculatingSupply } = await getXAlgoRate();
      const mintAmount = BigInt(10e6);
      const minReceived =
        mulScale(mulScale(mintAmount, xAlgoCirculatingSupply, algoBalance), ONE_16_DP - premium, ONE_16_DP) + BigInt(1);

      // immediate mint
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = prepareImmediateMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user1.addr,
        user1.addr,
        mintAmount,
        minReceived,
        proposerAddrs,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("frame_dig -1; >=; assert"),
      });
    });

    test("succeeds and allocates to lowest balance proposer", async () => {
      // airdrop rewards
      const additionalRewards = BigInt(10e6);
      await fundAccountWithAlgo(algodClient, proposer0.addr, additionalRewards, await getParams(algodClient));
      const additionalRewardsFee = mulScale(additionalRewards, fee, ONE_4_DP);

      // calculate rate
      const {
        algoBalance: oldAlgoBalance,
        xAlgoCirculatingSupply: oldXAlgoCirculatingSupply,
        proposersBalances: oldProposersBalance,
      } = await getXAlgoRate();
      const mintAmount = BigInt(5e6);
      const minReceived = BigInt(0);
      const expectedReceived = mulScale(
        mulScale(mintAmount, oldXAlgoCirculatingSupply, oldAlgoBalance),
        ONE_16_DP - premium,
        ONE_16_DP,
      );

      // ensure allocation will go entirely to second proposer
      expect(oldProposersBalance[1] + mintAmount).toBeLessThan(oldProposersBalance[0]);

      // state before
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const {
        lastProposersActiveBalance: oldLastProposersActiveBalance,
        totalPendingStake: oldTotalPendingStake,
        totalUnclaimedFees: oldTotalUnclaimedFees,
      } = state;

      // immediate mint
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = prepareImmediateMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user1.addr,
        user1.addr,
        mintAmount,
        minReceived,
        proposerAddrs,
        await getParams(algodClient),
      );
      const [, txId] = await submitGroupTransaction(
        algodClient,
        txns,
        txns.map(() => user1.sk),
      );
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const { txn: algoTransfer } = txInfo["inner-txns"][0].txn;
      const { txn: xAlgoTransfer } = txInfo["inner-txns"][1].txn;

      // state after
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const { lastProposersActiveBalance, totalPendingStake, totalUnclaimedFees } = state;
      expect(lastProposersActiveBalance).toEqual(oldLastProposersActiveBalance + mintAmount + additionalRewards);
      expect(totalPendingStake).toEqual(oldTotalPendingStake);
      expect(totalUnclaimedFees).toEqual(oldTotalUnclaimedFees + additionalRewardsFee);

      // balances after
      const { algoBalance, xAlgoCirculatingSupply, proposersBalances } = await getXAlgoRate();
      expect(algoBalance).toEqual(oldAlgoBalance + mintAmount);
      expect(xAlgoCirculatingSupply).toEqual(oldXAlgoCirculatingSupply + expectedReceived);
      expect(proposersBalances[0]).toEqual(oldProposersBalance[0]);
      expect(proposersBalances[1]).toEqual(oldProposersBalance[1] + mintAmount);
      expect(txInfo["inner-txns"].length).toEqual(2);
      expect(algoTransfer.type).toEqual("pay");
      expect(algoTransfer.amt).toEqual(Number(mintAmount));
      expect(algoTransfer.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(algoTransfer.rcv).toEqual(decodeAddress(proposer1.addr).publicKey);
      expect(xAlgoTransfer.type).toEqual("axfer");
      expect(xAlgoTransfer.xaid).toEqual(Number(xAlgoId));
      expect(xAlgoTransfer.aamt).toEqual(Number(expectedReceived));
      expect(xAlgoTransfer.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(xAlgoTransfer.arcv).toEqual(decodeAddress(user1.addr).publicKey);
    });

    test("succeeds and splits between proposers", async () => {
      // airdrop rewards
      const additionalRewards = BigInt(10e6);
      await fundAccountWithAlgo(algodClient, proposer1.addr, additionalRewards, await getParams(algodClient));
      const additionalRewardsFee = mulScale(additionalRewards, fee, ONE_4_DP);

      // ensure allocation will go to both proposers
      const {
        algoBalance: oldAlgoBalance,
        xAlgoCirculatingSupply: oldXAlgoCirculatingSupply,
        proposersBalances: oldProposersBalance,
      } = await getXAlgoRate();
      expect(oldProposersBalance[0]).toBeGreaterThan(oldProposersBalance[1]);
      const excessMintAmount = BigInt(5e6);
      const diffMintAmount = oldProposersBalance[0] - oldProposersBalance[1];
      const mintAmount = diffMintAmount + excessMintAmount;

      // calculate rate
      const minReceived = BigInt(0);
      const expectedReceived = mulScale(
        mulScale(mintAmount, oldXAlgoCirculatingSupply, oldAlgoBalance),
        ONE_16_DP - premium,
        ONE_16_DP,
      );

      // state before
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const {
        lastProposersActiveBalance: oldLastProposersActiveBalance,
        totalPendingStake: oldTotalPendingStake,
        totalUnclaimedFees: oldTotalUnclaimedFees,
      } = state;

      // immediate mint
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = [
        prepareXAlgoConsensusDummyCall(xAlgoConsensusABI, xAlgoAppId, user1.addr, [], await getParams(algodClient)),
        ...prepareImmediateMintFromXAlgoConsensus(
          xAlgoConsensusABI,
          xAlgoAppId,
          xAlgoId,
          user1.addr,
          user1.addr,
          mintAmount,
          minReceived,
          proposerAddrs,
          await getParams(algodClient),
        ),
      ];
      const [, , txId] = await submitGroupTransaction(
        algodClient,
        txns,
        txns.map(() => user1.sk),
      );
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const { txn: algoTransfer0 } = txInfo["inner-txns"][0].txn;
      const { txn: algoTransfer1 } = txInfo["inner-txns"][1].txn;
      const { txn: xAlgoTransfer } = txInfo["inner-txns"][2].txn;

      // state after
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const { lastProposersActiveBalance, totalPendingStake, totalUnclaimedFees } = state;
      expect(lastProposersActiveBalance).toEqual(oldLastProposersActiveBalance + mintAmount + additionalRewards);
      expect(totalPendingStake).toEqual(oldTotalPendingStake);
      expect(totalUnclaimedFees).toEqual(oldTotalUnclaimedFees + additionalRewardsFee);

      // balances after
      const { algoBalance, xAlgoCirculatingSupply, proposersBalances } = await getXAlgoRate();
      expect(algoBalance).toEqual(oldAlgoBalance + mintAmount);
      expect(xAlgoCirculatingSupply).toEqual(oldXAlgoCirculatingSupply + expectedReceived);
      expect(proposersBalances[0]).toEqual(oldProposersBalance[0] + excessMintAmount / BigInt(2) + BigInt(1));
      expect(proposersBalances[1]).toEqual(
        oldProposersBalance[1] + diffMintAmount + excessMintAmount / BigInt(2) - BigInt(1),
      );
      expect(txInfo["inner-txns"].length).toEqual(3);
      expect(algoTransfer0.type).toEqual("pay");
      expect(algoTransfer0.amt).toEqual(Number(excessMintAmount / BigInt(2) + BigInt(1)));
      expect(algoTransfer0.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(algoTransfer0.rcv).toEqual(decodeAddress(proposer0.addr).publicKey);
      expect(algoTransfer1.type).toEqual("pay");
      expect(algoTransfer1.amt).toEqual(Number(diffMintAmount + excessMintAmount / BigInt(2) - BigInt(1)));
      expect(algoTransfer1.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(algoTransfer1.rcv).toEqual(decodeAddress(proposer1.addr).publicKey);
      expect(xAlgoTransfer.type).toEqual("axfer");
      expect(xAlgoTransfer.xaid).toEqual(Number(xAlgoId));
      expect(xAlgoTransfer.aamt).toEqual(Number(expectedReceived));
      expect(xAlgoTransfer.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(xAlgoTransfer.arcv).toEqual(decodeAddress(user1.addr).publicKey);
    });

    test("succeeds and receives xALGO at different address", async () => {
      // airdrop rewards
      const additionalRewards = BigInt(10e6);
      await fundAccountWithAlgo(algodClient, proposer1.addr, additionalRewards, await getParams(algodClient));

      // calculate rate
      const {
        algoBalance: oldAlgoBalance,
        xAlgoCirculatingSupply: oldXAlgoCirculatingSupply,
        proposersBalances: oldProposersBalance,
      } = await getXAlgoRate();
      const mintAmount = BigInt(5e6);
      const minReceived = BigInt(0);
      const expectedReceived = mulScale(
        mulScale(mintAmount, oldXAlgoCirculatingSupply, oldAlgoBalance),
        ONE_16_DP - premium,
        ONE_16_DP,
      );

      // balances before
      const user1AlgoBalanceB = await getAlgoBalance(algodClient, user1.addr);
      const user1XAlgoBalanceB = await getAssetBalance(algodClient, user1.addr, xAlgoId);
      const user2AlgoBalanceB = await getAlgoBalance(algodClient, user2.addr);
      const user2XAlgoBalanceB = await getAssetBalance(algodClient, user2.addr, xAlgoId);

      // immediate mint
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = [
        prepareXAlgoConsensusDummyCall(xAlgoConsensusABI, xAlgoAppId, user1.addr, [], await getParams(algodClient)),
        ...prepareImmediateMintFromXAlgoConsensus(
          xAlgoConsensusABI,
          xAlgoAppId,
          xAlgoId,
          user1.addr,
          user2.addr,
          mintAmount,
          minReceived,
          proposerAddrs,
          await getParams(algodClient),
        ),
      ];
      await submitGroupTransaction(
        algodClient,
        txns,
        txns.map(() => user1.sk),
      );

      // balances after
      const { algoBalance, xAlgoCirculatingSupply } = await getXAlgoRate();
      const user1AlgoBalanceA = await getAlgoBalance(algodClient, user1.addr);
      const user1XAlgoBalanceA = await getAssetBalance(algodClient, user1.addr, xAlgoId);
      const user2AlgoBalanceA = await getAlgoBalance(algodClient, user2.addr);
      const user2XAlgoBalanceA = await getAssetBalance(algodClient, user2.addr, xAlgoId);
      expect(algoBalance).toEqual(oldAlgoBalance + mintAmount);
      expect(xAlgoCirculatingSupply).toEqual(oldXAlgoCirculatingSupply + expectedReceived);
      expect(user1AlgoBalanceA).toEqual(user1AlgoBalanceB - mintAmount - BigInt(6000));
      expect(user2AlgoBalanceA).toEqual(user2AlgoBalanceB);
      expect(user1XAlgoBalanceA).toEqual(user1XAlgoBalanceB);
      expect(user2XAlgoBalanceA).toEqual(user2XAlgoBalanceB + expectedReceived);
    });
  });

  describe("delayed mint", () => {
    test("fails when delay mint is paused", async () => {
      // pause delay mint
      let tx = preparePauseXAlgoConsensusMinting(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        "can_delay_mint",
        true,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      const state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.canDelayMint).toEqual(false);

      // delay mint
      const mintAmount = BigInt(10e6);
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = prepareDelayedMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        user1.addr,
        mintAmount,
        nonce,
        proposerAddrs,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('"can_delay_mint"; app_global_get; assert'),
      });

      // resume delay mint
      tx = preparePauseXAlgoConsensusMinting(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        "can_delay_mint",
        false,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
    });

    test("fails when you don't send algo", async () => {
      const mintAmount = BigInt(10e6);
      const proposerAddrs = [proposer0.addr, proposer1.addr];

      // send algo to unknown
      let txns = prepareDelayedMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        user1.addr,
        mintAmount,
        nonce,
        proposerAddrs,
        await getParams(algodClient),
      );
      txns[0].to = decodeAddress(user1.addr);
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("frame_dig -1; ==; assert"),
      });

      // send algo to proposer
      txns = prepareDelayedMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        user1.addr,
        mintAmount,
        nonce,
        proposerAddrs,
        await getParams(algodClient),
      );
      txns[0].to = decodeAddress(proposer0.addr);
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("frame_dig -1; ==; assert"),
      });
    });

    test("fails when proposer max balance is exceeded", async () => {
      const { algoBalance } = await getXAlgoRate();
      const mintAmount = maxProposerBalance * BigInt(2) - algoBalance;
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = prepareDelayedMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        user1.addr,
        mintAmount,
        nonce,
        proposerAddrs,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; <=; assert"),
      });
    });

    test("fails when nonce is not 2 bytes", async () => {
      const mintAmount = BigInt(10e6);
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = prepareDelayedMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        user1.addr,
        mintAmount,
        nonce,
        proposerAddrs,
        await getParams(algodClient),
      );
      txns[1].appArgs![2] = Uint8Array.from([0, 0, 0, 0]);
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("// 2; ==; assert"),
      });
    });

    test("succeeds when receiver is sender", async () => {
      await fundAccountWithAlgo(algodClient, getApplicationAddress(xAlgoAppId), delayMintBoxCost);

      // airdrop rewards
      const additionalRewards = BigInt(5e6);
      await fundAccountWithAlgo(algodClient, proposer0.addr, additionalRewards, await getParams(algodClient));
      const additionalRewardsFee = mulScale(additionalRewards, fee, ONE_4_DP);

      // ensure allocation will go to both proposers
      const {
        algoBalance: oldAlgoBalance,
        xAlgoCirculatingSupply: oldXAlgoCirculatingSupply,
        proposersBalances: oldProposersBalance,
      } = await getXAlgoRate();
      expect(oldProposersBalance[0]).toBeGreaterThan(oldProposersBalance[1]);
      const excessMintAmount = BigInt(2.352951e6);
      const diffMintAmount = oldProposersBalance[0] - oldProposersBalance[1];
      const mintAmount = diffMintAmount + excessMintAmount;

      // state before
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const {
        lastProposersActiveBalance: oldLastProposersActiveBalance,
        totalPendingStake: oldTotalPendingStake,
        totalUnclaimedFees: oldTotalUnclaimedFees,
      } = state;

      // delayed mint
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = [
        prepareXAlgoConsensusDummyCall(xAlgoConsensusABI, xAlgoAppId, user1.addr, [], await getParams(algodClient)),
        ...prepareDelayedMintFromXAlgoConsensus(
          xAlgoConsensusABI,
          xAlgoAppId,
          user1.addr,
          user1.addr,
          mintAmount,
          nonce,
          proposerAddrs,
          await getParams(algodClient),
        ),
      ];
      const [, , txId] = await submitGroupTransaction(
        algodClient,
        txns,
        txns.map(() => user1.sk),
      );
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const round = BigInt(txInfo["confirmed-round"]);
      const { txn: algoTransfer0 } = txInfo["inner-txns"][0].txn;
      const { txn: algoTransfer1 } = txInfo["inner-txns"][1].txn;

      // state after
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const { lastProposersActiveBalance, totalPendingStake, totalUnclaimedFees } = state;
      expect(lastProposersActiveBalance).toEqual(oldLastProposersActiveBalance + additionalRewards);
      expect(totalPendingStake).toEqual(oldTotalPendingStake + mintAmount);
      expect(totalUnclaimedFees).toEqual(oldTotalUnclaimedFees + additionalRewardsFee);

      // verify delay mint box
      const boxName = Uint8Array.from([...enc.encode("dm"), ...decodeAddress(user1.addr).publicKey, ...nonce]);
      const box = await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
      const boxValue = Uint8Array.from([
        ...decodeAddress(user1.addr).publicKey,
        ...encodeUint64(mintAmount),
        ...encodeUint64(round + BigInt(320)),
      ]);
      expect(box.value).toEqual(boxValue);

      // balances after
      const { algoBalance, xAlgoCirculatingSupply, proposersBalances } = await getXAlgoRate();
      expect(algoBalance).toEqual(oldAlgoBalance);
      expect(xAlgoCirculatingSupply).toEqual(oldXAlgoCirculatingSupply);
      expect(proposersBalances[0]).toEqual(oldProposersBalance[0] + excessMintAmount / BigInt(2) + BigInt(1));
      expect(proposersBalances[1]).toEqual(oldProposersBalance[1] + diffMintAmount + excessMintAmount / BigInt(2));
      expect(txInfo["inner-txns"].length).toEqual(2);
      expect(algoTransfer0.type).toEqual("pay");
      expect(algoTransfer0.amt).toEqual(Number(excessMintAmount / BigInt(2) + BigInt(1)));
      expect(algoTransfer0.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(algoTransfer0.rcv).toEqual(decodeAddress(proposer0.addr).publicKey);
      expect(algoTransfer1.type).toEqual("pay");
      expect(algoTransfer1.amt).toEqual(Number(diffMintAmount + excessMintAmount / BigInt(2)));
      expect(algoTransfer1.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(algoTransfer1.rcv).toEqual(decodeAddress(proposer1.addr).publicKey);
    });

    test.each([{ length: 30 }, { length: 34 }])(`fails when address length is $length bytes`, async ({ length }) => {
      const receiverAddr = getRandomBytes(length);
      const nonce = getRandomBytes(2);
      const params = await getParams(algodClient);
      const txns = [
        makePaymentTxnWithSuggestedParamsFromObject({
          from: user1.addr,
          to: getApplicationAddress(xAlgoAppId),
          amount: BigInt(10e6),
          suggestedParams: params,
        }),
        makeApplicationCallTxnFromObject({
          from: user1.addr,
          appIndex: xAlgoAppId,
          onComplete: OnApplicationComplete.NoOpOC,
          appArgs: [getMethodByName(xAlgoConsensusABI.methods, "delayed_mint").getSelector(), receiverAddr, nonce],
          suggestedParams: params,
        }),
      ];
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("// 32; ==; assert"),
      });
    });

    test.each([{ length: 1 }, { length: 4 }])(`fails when nonce length is $length bytes`, async ({ length }) => {
      const receiverAddr = getRandomBytes(32);
      const nonce = getRandomBytes(length);
      const params = await getParams(algodClient);
      const txns = [
        makePaymentTxnWithSuggestedParamsFromObject({
          from: user1.addr,
          to: getApplicationAddress(xAlgoAppId),
          amount: BigInt(10e6),
          suggestedParams: params,
        }),
        makeApplicationCallTxnFromObject({
          from: user1.addr,
          appIndex: xAlgoAppId,
          onComplete: OnApplicationComplete.NoOpOC,
          appArgs: [getMethodByName(xAlgoConsensusABI.methods, "delayed_mint").getSelector(), receiverAddr, nonce],
          suggestedParams: params,
        }),
      ];
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("// 2; ==; assert"),
      });
    });

    test("succeeds when receiver is different address", async () => {
      await fundAccountWithAlgo(algodClient, getApplicationAddress(xAlgoAppId), delayMintBoxCost);

      // airdrop rewards
      const additionalRewards = BigInt(5e6);
      await fundAccountWithAlgo(algodClient, proposer0.addr, additionalRewards, await getParams(algodClient));

      // delayed mint
      const mintAmount = BigInt(5e6);
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = [
        prepareXAlgoConsensusDummyCall(xAlgoConsensusABI, xAlgoAppId, user1.addr, [], await getParams(algodClient)),
        ...prepareDelayedMintFromXAlgoConsensus(
          xAlgoConsensusABI,
          xAlgoAppId,
          user1.addr,
          user2.addr,
          mintAmount,
          secondNonce,
          proposerAddrs,
          await getParams(algodClient),
        ),
      ];
      const [, , txId] = await submitGroupTransaction(
        algodClient,
        txns,
        txns.map(() => user1.sk),
      );
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const round = BigInt(txInfo["confirmed-round"]);

      // verify delay mint box
      const boxName = Uint8Array.from([...enc.encode("dm"), ...decodeAddress(user1.addr).publicKey, ...secondNonce]);
      const box = await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
      const boxValue = Uint8Array.from([
        ...decodeAddress(user2.addr).publicKey,
        ...encodeUint64(mintAmount),
        ...encodeUint64(round + BigInt(320)),
      ]);
      expect(box.value).toEqual(boxValue);
    });

    test("fails when box is already used", async () => {
      const mintAmount = BigInt(10e6);
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = prepareDelayedMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        user1.addr,
        mintAmount,
        nonce,
        proposerAddrs,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("box_create; assert"),
      });
    });
  });

  describe("claim delayed mint", () => {
    test.each([{ length: 30 }, { length: 34 }])(`fails when address length is $length bytes`, async ({ length }) => {
      const minterAddr = getRandomBytes(length);
      const nonce = getRandomBytes(2);
      const params = await getParams(algodClient);
      const tx = makeApplicationCallTxnFromObject({
        from: user1.addr,
        appIndex: xAlgoAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        appArgs: [getMethodByName(xAlgoConsensusABI.methods, "claim_delayed_mint").getSelector(), minterAddr, nonce],
        suggestedParams: params,
      });
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("// 32; ==; assert"),
      });
    });

    test.each([{ length: 1 }, { length: 4 }])(`fails when nonce length is $length bytes`, async ({ length }) => {
      const minterAddr = getRandomBytes(32);
      const nonce = getRandomBytes(length);
      const params = await getParams(algodClient);
      const tx = makeApplicationCallTxnFromObject({
        from: user1.addr,
        appIndex: xAlgoAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        appArgs: [getMethodByName(xAlgoConsensusABI.methods, "claim_delayed_mint").getSelector(), minterAddr, nonce],
        suggestedParams: params,
      });
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("// 2; ==; assert"),
      });
    });

    test("fails when box does not exist", async () => {
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const nonce = Uint8Array.from([200, 79]);
      const tx = prepareClaimDelayedMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user2.addr,
        user1.addr,
        user1.addr,
        nonce,
        proposerAddrs,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user2.sk)).rejects.toMatchObject({
        message: expect.stringContaining("store 36; load 37; assert"),
      });
    });

    test("fails when 320 rounds hasn't passed", async () => {
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const tx = prepareClaimDelayedMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user2.addr,
        user1.addr,
        user1.addr,
        nonce,
        proposerAddrs,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user2.sk)).rejects.toMatchObject({
        message: expect.stringContaining("extract_uint64; >=; assert"),
      });
    });

    test("succeeds when receiver is minter", async () => {
      // airdrop rewards
      const additionalRewards = BigInt(5e6);
      await fundAccountWithAlgo(algodClient, proposer1.addr, additionalRewards, await getParams(algodClient));
      const additionalRewardsFee = mulScale(additionalRewards, fee, ONE_4_DP);

      // calculate rate
      const { algoBalance: oldAlgoBalance, xAlgoCirculatingSupply: oldXAlgoCirculatingSupply } = await getXAlgoRate();
      const boxName = Uint8Array.from([...enc.encode("dm"), ...decodeAddress(user1.addr).publicKey, ...nonce]);
      const box = await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
      const mintAmount = decodeUint64(box.value.subarray(32, 40), "bigint");
      const expectedReceived = mulScale(mintAmount, oldXAlgoCirculatingSupply, oldAlgoBalance);

      // fast-forward 320 rounds
      await advanceBlockRounds(algodClient, 320);

      // state before
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const {
        lastProposersActiveBalance: oldLastProposersActiveBalance,
        totalPendingStake: oldTotalPendingStake,
        totalUnclaimedFees: oldTotalUnclaimedFees,
      } = state;

      // claim delay mint
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const tx = prepareClaimDelayedMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user2.addr,
        user1.addr,
        user1.addr,
        nonce,
        proposerAddrs,
        await getParams(algodClient),
      );
      const txId = await submitTransaction(algodClient, tx, user2.sk);
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const { txn: transfer } = txInfo["inner-txns"][0].txn;
      const { txn: boxRefund } = txInfo["inner-txns"][1].txn;

      // state after
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const { lastProposersActiveBalance, totalPendingStake, totalUnclaimedFees } = state;
      expect(lastProposersActiveBalance).toEqual(oldLastProposersActiveBalance + mintAmount + additionalRewards);
      expect(totalPendingStake).toEqual(oldTotalPendingStake - mintAmount);
      expect(totalUnclaimedFees).toEqual(oldTotalUnclaimedFees + additionalRewardsFee);

      // balances after
      const { algoBalance, xAlgoCirculatingSupply } = await getXAlgoRate();
      expect(algoBalance).toEqual(oldAlgoBalance + mintAmount);
      expect(xAlgoCirculatingSupply).toEqual(oldXAlgoCirculatingSupply + expectedReceived);
      expect(txInfo["inner-txns"].length).toEqual(2);
      expect(transfer.type).toEqual("axfer");
      expect(transfer.xaid).toEqual(Number(xAlgoId));
      expect(transfer.aamt).toEqual(Number(expectedReceived));
      expect(transfer.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(transfer.arcv).toEqual(decodeAddress(user1.addr).publicKey);
      expect(boxRefund.type).toEqual("pay");
      expect(boxRefund.amt).toEqual(Number(delayMintBoxCost));
      expect(boxRefund.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(boxRefund.rcv).toEqual(decodeAddress(user2.addr).publicKey);

      // verify delay mint box
      try {
        await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
        fail("request should fail");
      } catch (error: any) {}
    });

    test("succeeds when receiver is different address", async () => {
      // airdrop rewards
      const additionalRewards = BigInt(5e6);
      await fundAccountWithAlgo(algodClient, proposer1.addr, additionalRewards, await getParams(algodClient));

      // calculate rate
      const { algoBalance: oldAlgoBalance, xAlgoCirculatingSupply: oldXAlgoCirculatingSupply } = await getXAlgoRate();
      const boxName = Uint8Array.from([...enc.encode("dm"), ...decodeAddress(user1.addr).publicKey, ...secondNonce]);
      const box = await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
      const mintAmount = decodeUint64(box.value.subarray(32, 40), "bigint");
      const expectedReceived = mulScale(mintAmount, oldXAlgoCirculatingSupply, oldAlgoBalance);

      // balances before
      const adminXAlgoBalanceB = await getAssetBalance(algodClient, admin.addr, xAlgoId);
      const user1XAlgoBalanceB = await getAssetBalance(algodClient, user1.addr, xAlgoId);
      const user2XAlgoBalanceB = await getAssetBalance(algodClient, user2.addr, xAlgoId);

      // claim delay mint
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const tx = prepareClaimDelayedMintFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        admin.addr,
        user1.addr,
        user2.addr,
        secondNonce,
        proposerAddrs,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);

      // balances after
      const { algoBalance, xAlgoCirculatingSupply } = await getXAlgoRate();
      const adminXAlgoBalanceA = await getAssetBalance(algodClient, admin.addr, xAlgoId);
      const user1XAlgoBalanceA = await getAssetBalance(algodClient, user1.addr, xAlgoId);
      const user2XAlgoBalanceA = await getAssetBalance(algodClient, user2.addr, xAlgoId);
      expect(algoBalance).toEqual(oldAlgoBalance + mintAmount);
      expect(xAlgoCirculatingSupply).toEqual(oldXAlgoCirculatingSupply + expectedReceived);
      expect(adminXAlgoBalanceA).toEqual(adminXAlgoBalanceB);
      expect(user1XAlgoBalanceA).toEqual(user1XAlgoBalanceB);
      expect(user2XAlgoBalanceA).toEqual(user2XAlgoBalanceB + expectedReceived);

      // verify delay mint box
      try {
        await algodClient.getApplicationBoxByName(xAlgoAppId, boxName).do();
        fail("request should fail");
      } catch (error: any) {}
    });
  });

  describe("burn", () => {
    test.each([{ length: 30 }, { length: 34 }])(`fails when address length is $length bytes`, async ({ length }) => {
      const receiverAddr = getRandomBytes(length);
      const params = await getParams(algodClient);
      const txns = [
        makeAssetTransferTxnWithSuggestedParamsFromObject({
          from: user1.addr,
          to: getApplicationAddress(xAlgoAppId),
          assetIndex: xAlgoId,
          amount: BigInt(10e6),
          suggestedParams: params,
        }),
        makeApplicationCallTxnFromObject({
          from: user1.addr,
          appIndex: xAlgoAppId,
          onComplete: OnApplicationComplete.NoOpOC,
          appArgs: [getMethodByName(xAlgoConsensusABI.methods, "burn").getSelector(), receiverAddr, encodeUint64(0)],
          suggestedParams: params,
        }),
      ];
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("// 32; ==; assert"),
      });
    });

    test("fails when you don't send x algo", async () => {
      const burnAmount = BigInt(5e6);
      const minReceived = BigInt(0);
      const proposerAddrs = [proposer0.addr, proposer1.addr];

      // send x algo to unknown
      const txns = prepareBurnFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user1.addr,
        user1.addr,
        burnAmount,
        minReceived,
        proposerAddrs,
        await getParams(algodClient),
      );
      txns[0].to = decodeAddress(user1.addr);
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("global CurrentApplicationAddress; ==; assert"),
      });
    });

    test("fails when you receive less algo than min received specified", async () => {
      const { algoBalance, xAlgoCirculatingSupply } = await getXAlgoRate();
      const burnAmount = BigInt(5e6);
      const minReceived = mulScale(burnAmount, algoBalance, xAlgoCirculatingSupply) + BigInt(1);

      // send x algo to unknown
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = prepareBurnFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user1.addr,
        user1.addr,
        burnAmount,
        minReceived,
        proposerAddrs,
        await getParams(algodClient),
      );
      await expect(
        submitGroupTransaction(
          algodClient,
          txns,
          txns.map(() => user1.sk),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("frame_dig -1; >=; assert"),
      });
    });

    test("succeeds and allocates from highest balance proposer", async () => {
      // airdrop rewards
      const additionalRewards = BigInt(10e6);
      await fundAccountWithAlgo(algodClient, proposer1.addr, additionalRewards, await getParams(algodClient));
      const additionalRewardsFee = mulScale(additionalRewards, fee, ONE_4_DP);

      // calculate rate
      const {
        algoBalance: oldAlgoBalance,
        xAlgoCirculatingSupply: oldXAlgoCirculatingSupply,
        proposersBalances: oldProposersBalance,
      } = await getXAlgoRate();
      const burnAmount = BigInt(5e6);
      const minReceived = BigInt(0);
      const expectedReceived = mulScale(burnAmount, oldAlgoBalance, oldXAlgoCirculatingSupply);

      // ensure allocation will come entirely from second proposer
      expect(oldProposersBalance[1] - expectedReceived).toBeGreaterThan(oldProposersBalance[0]);

      // state before
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const {
        lastProposersActiveBalance: oldLastProposersActiveBalance,
        totalPendingStake: oldTotalPendingStake,
        totalUnclaimedFees: oldTotalUnclaimedFees,
      } = state;

      // burn
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = prepareBurnFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user1.addr,
        user1.addr,
        burnAmount,
        minReceived,
        proposerAddrs,
        await getParams(algodClient),
      );
      const [, txId] = await submitGroupTransaction(
        algodClient,
        txns,
        txns.map(() => user1.sk),
      );
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const { txn: proposerTransfer } = txInfo["inner-txns"][0].txn;
      const { txn: userTransfer } = txInfo["inner-txns"][1].txn;

      // state after
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const { lastProposersActiveBalance, totalPendingStake, totalUnclaimedFees } = state;
      expect(lastProposersActiveBalance).toEqual(oldLastProposersActiveBalance - expectedReceived + additionalRewards);
      expect(totalPendingStake).toEqual(oldTotalPendingStake);
      expect(totalUnclaimedFees).toEqual(oldTotalUnclaimedFees + additionalRewardsFee);

      // balances after
      const { algoBalance, xAlgoCirculatingSupply, proposersBalances } = await getXAlgoRate();
      expect(algoBalance).toEqual(oldAlgoBalance - expectedReceived);
      expect(xAlgoCirculatingSupply).toEqual(oldXAlgoCirculatingSupply - burnAmount);
      expect(proposersBalances[0]).toEqual(oldProposersBalance[0]);
      expect(proposersBalances[1]).toEqual(oldProposersBalance[1] - expectedReceived);
      expect(txInfo["inner-txns"].length).toEqual(2);
      expect(proposerTransfer.type).toEqual("pay");
      expect(proposerTransfer.amt).toEqual(Number(expectedReceived));
      expect(proposerTransfer.snd).toEqual(decodeAddress(proposer1.addr).publicKey);
      expect(proposerTransfer.rcv).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(userTransfer.type).toEqual("pay");
      expect(userTransfer.amt).toEqual(Number(expectedReceived));
      expect(userTransfer.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(userTransfer.rcv).toEqual(decodeAddress(user1.addr).publicKey);
    });

    test("succeeds and splits between proposers", async () => {
      // airdrop rewards
      const additionalRewards = BigInt(10e6);
      await fundAccountWithAlgo(algodClient, proposer1.addr, additionalRewards, await getParams(algodClient));
      const additionalRewardsFee = mulScale(additionalRewards, fee, ONE_4_DP);

      // ensure allocation will come from both proposers
      const {
        algoBalance: oldAlgoBalance,
        xAlgoCirculatingSupply: oldXAlgoCirculatingSupply,
        proposersBalances: oldProposersBalance,
      } = await getXAlgoRate();
      expect(oldProposersBalance[1]).toBeGreaterThan(oldProposersBalance[0]);
      const diffReceivedAmount = oldProposersBalance[1] - oldProposersBalance[0];
      let excessReceivedAmount = BigInt(5e6);
      let expectedReceived = excessReceivedAmount + diffReceivedAmount;

      // calculate rate
      const minReceived = BigInt(0);
      const burnAmount = mulScaleRoundUp(expectedReceived, oldXAlgoCirculatingSupply, oldAlgoBalance);
      expectedReceived = mulScale(burnAmount, oldAlgoBalance, oldXAlgoCirculatingSupply);
      excessReceivedAmount = expectedReceived - diffReceivedAmount;

      // state before
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const {
        lastProposersActiveBalance: oldLastProposersActiveBalance,
        totalPendingStake: oldTotalPendingStake,
        totalUnclaimedFees: oldTotalUnclaimedFees,
      } = state;

      // burn
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = [
        prepareXAlgoConsensusDummyCall(xAlgoConsensusABI, xAlgoAppId, user1.addr, [], await getParams(algodClient)),
        ...prepareBurnFromXAlgoConsensus(
          xAlgoConsensusABI,
          xAlgoAppId,
          xAlgoId,
          user1.addr,
          user1.addr,
          burnAmount,
          minReceived,
          proposerAddrs,
          await getParams(algodClient),
        ),
      ];
      const [, , txId] = await submitGroupTransaction(
        algodClient,
        txns,
        txns.map(() => user1.sk),
      );
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const { txn: proposerTransfer0 } = txInfo["inner-txns"][0].txn;
      const { txn: proposerTransfer1 } = txInfo["inner-txns"][1].txn;
      const { txn: userTransfer } = txInfo["inner-txns"][2].txn;

      // state after
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const { lastProposersActiveBalance, totalPendingStake, totalUnclaimedFees } = state;
      expect(lastProposersActiveBalance).toEqual(oldLastProposersActiveBalance - expectedReceived + additionalRewards);
      expect(totalPendingStake).toEqual(oldTotalPendingStake);
      expect(totalUnclaimedFees).toEqual(oldTotalUnclaimedFees + additionalRewardsFee);

      // balances after
      const { algoBalance, xAlgoCirculatingSupply, proposersBalances } = await getXAlgoRate();
      expect(algoBalance).toEqual(oldAlgoBalance - expectedReceived);
      expect(xAlgoCirculatingSupply).toEqual(oldXAlgoCirculatingSupply - burnAmount);
      expect(proposersBalances[0]).toEqual(
        oldProposersBalance[0] - excessReceivedAmount / BigInt(2) - (excessReceivedAmount % BigInt(2)),
      );
      expect(proposersBalances[1]).toEqual(
        oldProposersBalance[1] - diffReceivedAmount - excessReceivedAmount / BigInt(2),
      );
      expect(txInfo["inner-txns"].length).toEqual(3);
      expect(proposerTransfer0.type).toEqual("pay");
      expect(proposerTransfer0.amt).toEqual(
        Number(excessReceivedAmount / BigInt(2) + (excessReceivedAmount % BigInt(2))),
      );
      expect(proposerTransfer0.snd).toEqual(decodeAddress(proposer0.addr).publicKey);
      expect(proposerTransfer0.rcv).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(proposerTransfer1.type).toEqual("pay");
      expect(proposerTransfer1.amt).toEqual(Number(diffReceivedAmount + excessReceivedAmount / BigInt(2)));
      expect(proposerTransfer1.snd).toEqual(decodeAddress(proposer1.addr).publicKey);
      expect(proposerTransfer1.rcv).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(userTransfer.type).toEqual("pay");
      expect(userTransfer.amt).toEqual(Number(expectedReceived));
      expect(userTransfer.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(userTransfer.rcv).toEqual(decodeAddress(user1.addr).publicKey);
    });

    test("succeeds and receives ALGO at different address", async () => {
      // airdrop rewards
      const additionalRewards = BigInt(10e6);
      await fundAccountWithAlgo(algodClient, proposer1.addr, additionalRewards, await getParams(algodClient));

      // calculate rate
      const { algoBalance: oldAlgoBalance, xAlgoCirculatingSupply: oldXAlgoCirculatingSupply } = await getXAlgoRate();
      const burnAmount = BigInt(5e6);
      const minReceived = BigInt(0);
      const expectedReceived = mulScale(burnAmount, oldAlgoBalance, oldXAlgoCirculatingSupply);

      // balances before
      const user1AlgoBalanceB = await getAlgoBalance(algodClient, user1.addr);
      const user1XAlgoBalanceB = await getAssetBalance(algodClient, user1.addr, xAlgoId);
      const user2AlgoBalanceB = await getAlgoBalance(algodClient, user2.addr);
      const user2XAlgoBalanceB = await getAssetBalance(algodClient, user2.addr, xAlgoId);

      // burn
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const txns = [
        prepareXAlgoConsensusDummyCall(xAlgoConsensusABI, xAlgoAppId, user1.addr, [], await getParams(algodClient)),
        ...prepareBurnFromXAlgoConsensus(
          xAlgoConsensusABI,
          xAlgoAppId,
          xAlgoId,
          user1.addr,
          user2.addr,
          burnAmount,
          minReceived,
          proposerAddrs,
          await getParams(algodClient),
        ),
      ];
      await submitGroupTransaction(
        algodClient,
        txns,
        txns.map(() => user1.sk),
      );

      // balances after
      const { algoBalance, xAlgoCirculatingSupply } = await getXAlgoRate();
      const user1AlgoBalanceA = await getAlgoBalance(algodClient, user1.addr);
      const user1XAlgoBalanceA = await getAssetBalance(algodClient, user1.addr, xAlgoId);
      const user2AlgoBalanceA = await getAlgoBalance(algodClient, user2.addr);
      const user2XAlgoBalanceA = await getAssetBalance(algodClient, user2.addr, xAlgoId);
      expect(algoBalance).toEqual(oldAlgoBalance - expectedReceived);
      expect(xAlgoCirculatingSupply).toEqual(oldXAlgoCirculatingSupply - burnAmount);
      expect(user1AlgoBalanceA).toEqual(user1AlgoBalanceB - BigInt(6000));
      expect(user2AlgoBalanceA).toEqual(user2AlgoBalanceB + expectedReceived);
      expect(user1XAlgoBalanceA).toEqual(user1XAlgoBalanceB - burnAmount);
      expect(user2XAlgoBalanceA).toEqual(user2XAlgoBalanceB);
    });
  });

  describe("update fee", () => {
    test("fails for non-admin", async () => {
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const tx = prepareUpdateXAlgoConsensusFee(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        proposerAddrs,
        fee,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; ==; assert"),
      });
    });

    test("fails when fee is greater than 100%", async () => {
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const fee = BigInt(1e4) + BigInt(1);
      const tx = prepareUpdateXAlgoConsensusFee(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        proposerAddrs,
        fee,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("10000; <=; assert"),
      });
    });

    test("succeeds for admin", async () => {
      // airdrop 10 ALGO rewards (%fee of which will be claimable by admin)
      const additionalRewards = BigInt(10e6);
      await fundAccountWithAlgo(
        algodClient,
        proposer0.addr,
        additionalRewards / BigInt(2),
        await getParams(algodClient),
      );
      await fundAccountWithAlgo(
        algodClient,
        proposer1.addr,
        additionalRewards / BigInt(2),
        await getParams(algodClient),
      );
      const additionalRewardsFee = mulScale(additionalRewards, fee, ONE_4_DP);

      // balances before
      const adminAlgoBalanceB = await getAlgoBalance(algodClient, admin.addr);
      const {
        algoBalance: oldAlgoBalance,
        xAlgoCirculatingSupply: oldXAlgoCirculatingSupply,
        proposersBalances: oldProposersBalance,
      } = await getXAlgoRate();

      // state before
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const { lastProposersActiveBalance: oldLastProposersActiveBalance, totalUnclaimedFees: oldTotalUnclaimedFees } =
        state;

      // update fee
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const tempFee = BigInt(0.025e4);
      let tx = prepareUpdateXAlgoConsensusFee(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        proposerAddrs,
        tempFee,
        await getParams(algodClient),
      );
      const txId = await submitTransaction(algodClient, tx, admin.sk);
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const { txn: transfer } = txInfo["inner-txns"][txInfo["inner-txns"].length - 1].txn;
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.lastProposersActiveBalance).toEqual(
        oldLastProposersActiveBalance - oldTotalUnclaimedFees + additionalRewards - additionalRewardsFee,
      );
      expect(state.fee).toEqual(tempFee);
      expect(state.totalUnclaimedFees).toEqual(BigInt(0));

      // balances after
      const adminAlgoBalanceA = await getAlgoBalance(algodClient, admin.addr);
      const { algoBalance, xAlgoCirculatingSupply, proposersBalances } = await getXAlgoRate();
      expect(adminAlgoBalanceA).toEqual(
        adminAlgoBalanceB + oldTotalUnclaimedFees + additionalRewardsFee - BigInt(4000),
      );
      expect(algoBalance).toEqual(oldAlgoBalance);
      expect(xAlgoCirculatingSupply).toEqual(oldXAlgoCirculatingSupply);
      expect(proposersBalances[0] + proposersBalances[1]).toEqual(
        oldProposersBalance[0] + oldProposersBalance[1] - (oldTotalUnclaimedFees + additionalRewardsFee),
      );
      expect(proposersBalances[0] - BigInt(1)).toBeLessThanOrEqual(proposersBalances[1]);
      expect(proposersBalances[0] + BigInt(1)).toBeGreaterThanOrEqual(proposersBalances[1]);
      expect(transfer.type).toEqual("pay");
      expect(transfer.amt).toEqual(Number(oldTotalUnclaimedFees + additionalRewardsFee));
      expect(transfer.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(transfer.rcv).toEqual(decodeAddress(admin.addr).publicKey);

      // restore old fee
      tx = prepareUpdateXAlgoConsensusFee(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        proposerAddrs,
        fee,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      expect(state.fee).toEqual(fee);
    });
  });

  describe("claim fee", () => {
    test("succeeds", async () => {
      // airdrop 10 ALGO rewards (%fee of which will be claimable by admin)
      const additionalRewards = BigInt(10e6);
      await fundAccountWithAlgo(
        algodClient,
        proposer0.addr,
        additionalRewards / BigInt(2),
        await getParams(algodClient),
      );
      await fundAccountWithAlgo(
        algodClient,
        proposer1.addr,
        additionalRewards / BigInt(2),
        await getParams(algodClient),
      );
      const additionalRewardsFee = mulScale(additionalRewards, fee, ONE_4_DP);

      // balances before
      const adminAlgoBalanceB = await getAlgoBalance(algodClient, admin.addr);
      const {
        algoBalance: oldAlgoBalance,
        xAlgoCirculatingSupply: oldXAlgoCirculatingSupply,
        proposersBalances: oldProposersBalance,
      } = await getXAlgoRate();

      // state before
      let state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const { lastProposersActiveBalance: oldLastProposersActiveBalance, totalUnclaimedFees: oldTotalUnclaimedFees } =
        state;

      // claim fee
      const proposerAddrs = [proposer0.addr, proposer1.addr];
      const tx = prepareClaimXAlgoConsensusFee(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        admin.addr,
        proposerAddrs,
        await getParams(algodClient),
      );
      const txId = await submitTransaction(algodClient, tx, user1.sk);
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const { txn: transfer } = txInfo["inner-txns"][txInfo["inner-txns"].length - 1].txn;
      state = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
      const { lastProposersActiveBalance, totalUnclaimedFees } = state;
      expect(lastProposersActiveBalance).toEqual(
        oldLastProposersActiveBalance - oldTotalUnclaimedFees + additionalRewards - additionalRewardsFee,
      );
      expect(totalUnclaimedFees).toEqual(BigInt(0));

      // balances after
      const adminAlgoBalanceA = await getAlgoBalance(algodClient, admin.addr);
      const { algoBalance, xAlgoCirculatingSupply, proposersBalances } = await getXAlgoRate();
      expect(adminAlgoBalanceA).toEqual(adminAlgoBalanceB + oldTotalUnclaimedFees + additionalRewardsFee);
      expect(algoBalance).toEqual(oldAlgoBalance);
      expect(xAlgoCirculatingSupply).toEqual(oldXAlgoCirculatingSupply);
      expect(proposersBalances[0] + proposersBalances[1]).toEqual(
        oldProposersBalance[0] + oldProposersBalance[1] - (oldTotalUnclaimedFees + additionalRewardsFee),
      );
      expect(proposersBalances[0] - BigInt(1)).toBeLessThanOrEqual(proposersBalances[1]);
      expect(proposersBalances[0] + BigInt(1)).toBeGreaterThanOrEqual(proposersBalances[1]);
      expect(transfer.type).toEqual("pay");
      expect(transfer.amt).toEqual(Number(oldTotalUnclaimedFees + additionalRewardsFee));
      expect(transfer.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(transfer.rcv).toEqual(decodeAddress(admin.addr).publicKey);
    });
  });

  test("burns everything", async () => {
    // get balances before
    const { xAlgoCirculatingSupply: oldXAlgoCirculatingSupply } = await getXAlgoRate();
    const user1XAlgoBalance = await getAssetBalance(algodClient, user1.addr, xAlgoId);
    const user2XAlgoBalance = await getAssetBalance(algodClient, user2.addr, xAlgoId);
    expect(oldXAlgoCirculatingSupply).toEqual(user1XAlgoBalance + user2XAlgoBalance);

    // common
    let txns;
    const proposerAddrs = [proposer0.addr, proposer1.addr];
    const minReceived = BigInt(0);

    // user1 burn
    txns = [
      prepareXAlgoConsensusDummyCall(xAlgoConsensusABI, xAlgoAppId, user1.addr, [], await getParams(algodClient)),
      ...prepareBurnFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user1.addr,
        user1.addr,
        user1XAlgoBalance,
        minReceived,
        proposerAddrs,
        await getParams(algodClient),
      ),
    ];
    await submitGroupTransaction(
      algodClient,
      txns,
      txns.map(() => user1.sk),
    );

    // user2 burn
    txns = [
      prepareXAlgoConsensusDummyCall(xAlgoConsensusABI, xAlgoAppId, user2.addr, [], await getParams(algodClient)),
      ...prepareBurnFromXAlgoConsensus(
        xAlgoConsensusABI,
        xAlgoAppId,
        xAlgoId,
        user2.addr,
        user2.addr,
        user2XAlgoBalance,
        minReceived,
        proposerAddrs,
        await getParams(algodClient),
      ),
    ];
    await submitGroupTransaction(
      algodClient,
      txns,
      txns.map(() => user2.sk),
    );

    // state after
    const { lastProposersActiveBalance } = await parseXAlgoConsensusGlobalState(algodClient, xAlgoAppId);
    expect(lastProposersActiveBalance).toEqual(BigInt(0));

    // balances after
    const { algoBalance, xAlgoCirculatingSupply } = await getXAlgoRate();
    expect(algoBalance).toEqual(BigInt(0));
    expect(xAlgoCirculatingSupply).toEqual(BigInt(0));
  });

  describe("update smart contract", () => {
    const boxName = "sc";

    beforeAll(async () => {
      // fund box
      await fundAccountWithAlgo(
        algodClient,
        getApplicationAddress(xAlgoAppId),
        updateSCBoxCost,
        await getParams(algodClient),
      );
    });

    test("fails in smart contract update when nothing scheduled", async () => {
      const prog = await compileTeal(compilePyTeal("contracts/common/clear_program", 10));
      const tx = prepareUpdateXAlgoConsensusSC(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        boxName,
        prog,
        prog,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("store 1; load 2; assert"),
      });
    });

    test.each([
      { approval: 30, clear: 32 },
      { approval: 34, clear: 32 },
      { approval: 32, clear: 30 },
      { approval: 32, clear: 34 },
    ])(`fails when approval hash is $approval bytes and clear hash is $clear bytes`, async ({ approval, clear }) => {
      const approvalSha256 = getRandomBytes(approval);
      const clearSha256 = getRandomBytes(clear);
      const tx = makeApplicationCallTxnFromObject({
        from: admin.addr,
        appIndex: xAlgoAppId,
        onComplete: OnApplicationComplete.NoOpOC,
        appArgs: [
          getMethodByName(xAlgoConsensusABI.methods, "schedule_update_sc").getSelector(),
          approvalSha256,
          clearSha256,
        ],
        boxes: [{ appIndex: xAlgoAppId, name: enc.encode(boxName) }],
        suggestedParams: await getParams(algodClient),
      });
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("// 32; ==; assert"),
      });
    });

    test("succeeds in scheduling update", async () => {
      // schedule
      const prog = await compileTeal(compilePyTeal("contracts/common/clear_program", 10));
      const tx = prepareScheduleXAlgoConsensusSCUpdate(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        boxName,
        prog,
        prog,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);

      // verify
      const progSha256 = Uint8Array.from(Buffer.from(sha256(prog), "hex"));
      const box = await algodClient.getApplicationBoxByName(xAlgoAppId, enc.encode(boxName)).do();
      expect(box.value).toEqual(
        Uint8Array.from([...encodeUint64(prevBlockTimestamp + timeDelay), ...progSha256, ...progSha256]),
      );
    });

    test("succeeds in overriding and scheduling update", async () => {
      const prog = await compileTeal(compilePyTeal("contracts/common/clear_program", 10));
      const tx = prepareScheduleXAlgoConsensusSCUpdate(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        boxName,
        prog,
        prog,
        await getParams(algodClient),
      );
      await submitTransaction(algodClient, tx, admin.sk);
    });

    test("fails in scheduling update when not admin", async () => {
      const prog = await compileTeal(compilePyTeal("contracts/common/clear_program", 10));
      const tx = prepareScheduleXAlgoConsensusSCUpdate(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        boxName,
        prog,
        prog,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; ==; assert"),
      });
    });

    test("fails in smart contract update when not past scheduled timestamp", async () => {
      const prog = await compileTeal(compilePyTeal("contracts/common/clear_program", 10));
      const tx = prepareUpdateXAlgoConsensusSC(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        boxName,
        prog,
        prog,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, admin.sk)).rejects.toMatchObject({
        message: expect.stringContaining("extract_uint64; >; assert"),
      });
    });

    test("fails in smart contract update when not admin", async () => {
      // proceed to timestamp
      const ts = decodeUint64(
        (await algodClient.getApplicationBoxByName(xAlgoAppId, enc.encode(boxName)).do()).value.subarray(0, 8),
        "bigint",
      );
      const offset = Number(ts - prevBlockTimestamp) + 1;
      prevBlockTimestamp = await advancePrevBlockTimestamp(algodClient, offset);

      // update
      const prog = await compileTeal(compilePyTeal("contracts/common/clear_program", 10));
      const tx = prepareUpdateXAlgoConsensusSC(
        xAlgoConsensusABI,
        xAlgoAppId,
        user1.addr,
        boxName,
        prog,
        prog,
        await getParams(algodClient),
      );
      await expect(submitTransaction(algodClient, tx, user1.sk)).rejects.toMatchObject({
        message: expect.stringContaining("app_global_get; ==; assert"),
      });
    });

    test("succeeds in smart contract update", async () => {
      // update
      const prog = await compileTeal(compilePyTeal("contracts/common/clear_program", 10));
      const tx = prepareUpdateXAlgoConsensusSC(
        xAlgoConsensusABI,
        xAlgoAppId,
        admin.addr,
        boxName,
        prog,
        prog,
        await getParams(algodClient),
      );
      const txId = await submitTransaction(algodClient, tx, admin.sk);
      const txInfo = await algodClient.pendingTransactionInformation(txId).do();
      const { txn: transfer } = txInfo["inner-txns"][0].txn;

      // check inner txn
      expect(txInfo["inner-txns"].length).toEqual(1);
      expect(transfer.type).toEqual("pay");
      expect(transfer.amt).toEqual(Number(updateSCBoxCost));
      expect(transfer.snd).toEqual(decodeAddress(getApplicationAddress(xAlgoAppId)).publicKey);
      expect(transfer.rcv).toEqual(decodeAddress(admin.addr).publicKey);

      // verify update
      const app = await algodClient.getApplicationByID(xAlgoAppId).do();
      await expect(app["params"]["approval-program"]).toEqual(Buffer.from(prog).toString("base64"));
      await expect(app["params"]["clear-state-program"]).toEqual(Buffer.from(prog).toString("base64"));

      // verify state
      const unformattedState = await getAppGlobalState(algodClient, xAlgoAppId);
      expect(getParsedValueFromState(unformattedState, "init")).toEqual(BigInt(0));
    });
  });
});
