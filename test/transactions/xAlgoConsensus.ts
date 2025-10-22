import {
  ABIContract,
  Algodv2,
  AtomicTransactionComposer,
  decodeAddress,
  encodeAddress,
  getApplicationAddress,
  getMethodByName,
  makePaymentTxnWithSuggestedParams,
  OnApplicationComplete,
  SuggestedParams,
  Transaction,
} from "algosdk";
import { sha256 } from "js-sha256";
import { getABIContract } from "../utils/abi";
import { compilePyTeal, compileTeal, enc, getAppGlobalState, getParsedValueFromState } from "../utils/contracts";
import { emptySigner, transferAlgoOrAsset } from "../utils/transaction";

export interface XAlgoConsensusGlobalState {
  initialised: boolean;
  admin: string;
  registerAdmin: string;
  xGovAdmin: string;
  xAlgoId: number;
  timeDelay: bigint;
  numProposers: bigint;
  maxProposerBalance: bigint;
  fee: bigint;
  premium: bigint;
  lastProposersActiveBalance: bigint;
  totalPendingStake: bigint;
  totalUnclaimedFees: bigint;
  canImmediateMint: boolean;
  canDelayMint: boolean;
}

export async function parseXAlgoConsensusGlobalState(
  algodClient: Algodv2,
  appId: number,
): Promise<XAlgoConsensusGlobalState> {
  const state = await getAppGlobalState(algodClient, appId);

  const initialised = Boolean(getParsedValueFromState(state, "init"));
  const admin = encodeAddress(Buffer.from(String(getParsedValueFromState(state, "admin")), "base64"));
  const registerAdmin = encodeAddress(Buffer.from(String(getParsedValueFromState(state, "register_admin")), "base64"));
  const xGovAdmin = encodeAddress(Buffer.from(String(getParsedValueFromState(state, "xgov_admin")), "base64"));
  const xAlgoId = Number(getParsedValueFromState(state, "x_algo_id") || 0);
  const timeDelay = BigInt(getParsedValueFromState(state, "time_delay") || 0);
  const numProposers = BigInt(getParsedValueFromState(state, "num_proposers") || 0);
  const maxProposerBalance = BigInt(getParsedValueFromState(state, "max_proposer_balance") || 0);
  const fee = BigInt(getParsedValueFromState(state, "fee") || 0);
  const premium = BigInt(getParsedValueFromState(state, "premium") || 0);
  const lastProposersActiveBalance = BigInt(getParsedValueFromState(state, "last_proposers_active_balance") || 0);
  const totalPendingStake = BigInt(getParsedValueFromState(state, "total_pending_stake") || 0);
  const totalUnclaimedFees = BigInt(getParsedValueFromState(state, "total_unclaimed_fees") || 0);
  const canImmediateMint = Boolean(getParsedValueFromState(state, "can_immediate_mint"));
  const canDelayMint = Boolean(getParsedValueFromState(state, "can_delay_mint"));

  return {
    initialised,
    admin,
    registerAdmin,
    xGovAdmin,
    xAlgoId,
    timeDelay,
    numProposers,
    maxProposerBalance,
    fee,
    premium,
    lastProposersActiveBalance,
    totalPendingStake,
    totalUnclaimedFees,
    canImmediateMint,
    canDelayMint,
  };
}

export async function prepareCreateXAlgoConsensusV2(
  creatorAddr: string,
  adminAddr: string,
  registerAdminAddr: string,
  xGovAdminAddr: string,
  maxProposerBalance: number | bigint,
  premium: number | bigint,
  fee: number | bigint,
  params: SuggestedParams,
): Promise<{ tx: Transaction; abi: ABIContract }> {
  // compile approval and clear program
  const approval = await compileTeal(compilePyTeal("contracts/testing/consensus_v2"));
  const clear = await compileTeal(compilePyTeal("contracts/common/clear_program", 10));

  // get ABI contract
  const abi = getABIContract("contracts/testing/consensus_v2");

  // depply app txn
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: creatorAddr,
    signer: emptySigner,
    appID: 0,
    method: getMethodByName(abi.methods, "create"),
    methodArgs: [adminAddr, registerAdminAddr, xGovAdminAddr, maxProposerBalance, premium, fee],
    approvalProgram: approval,
    clearProgram: clear,
    numGlobalInts: 32,
    numGlobalByteSlices: 32,
    numLocalInts: 8,
    numLocalByteSlices: 8,
    extraPages: 3,
    suggestedParams: params,
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return { tx: txns[0], abi };
}

export function prepareInitialiseXAlgoConsensusV2(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  senderAddr: string,
  proposerAddr: string,
  params: SuggestedParams,
): Transaction[] {
  const rekeyTx = makePaymentTxnWithSuggestedParams(
    proposerAddr,
    proposerAddr,
    0,
    undefined,
    undefined,
    { ...params, flatFee: true, fee: 0 },
    getApplicationAddress(xAlgoConsensusAppId),
  );

  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: senderAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "initialise"),
    methodArgs: [proposerAddr],
    boxes: [
      { appIndex: xAlgoConsensusAppId, name: enc.encode("pr") },
      {
        appIndex: xAlgoConsensusAppId,
        name: Uint8Array.from([...enc.encode("ap"), ...decodeAddress(proposerAddr).publicKey]),
      },
    ],
    suggestedParams: { ...params, flatFee: true, fee: 3000 },
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return [rekeyTx, txns[0]];
}

export function prepareMintFromXAlgoConsensus(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  xAlgoId: number,
  userAddr: string,
  mintAmount: number | bigint,
  proposerAddr: string,
  params: SuggestedParams,
): Transaction[] {
  const sendAlgo = {
    txn: transferAlgoOrAsset(0, userAddr, proposerAddr, mintAmount, params),
    signer: emptySigner,
  };
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: userAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "mint"),
    methodArgs: [sendAlgo],
    appAccounts: [proposerAddr],
    appForeignAssets: [xAlgoId],
    boxes: [{ appIndex: xAlgoConsensusAppId, name: enc.encode("pr") }],
    suggestedParams: { ...params, flatFee: true, fee: 2000 },
  });
  return atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
}

export function prepareInitialiseXAlgoConsensusV3(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  senderAddr: string,
  params: SuggestedParams,
): Transaction {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: senderAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "initialise"),
    methodArgs: [],
    suggestedParams: params,
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareUpdateXAlgoConsensusAdmin(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  adminType: string,
  adminAddr: string,
  newAdminAddr: string,
  params: SuggestedParams,
): Transaction {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: adminAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "update_admin"),
    methodArgs: [adminType, newAdminAddr],
    suggestedParams: params,
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareScheduleXAlgoConsensusSCUpdate(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  adminAddr: string,
  boxName: string,
  approval: Uint8Array,
  clear: Uint8Array,
  params: SuggestedParams,
): Transaction {
  const approvalSha256 = Uint8Array.from(Buffer.from(sha256(approval), "hex"));
  const clearSha256 = Uint8Array.from(Buffer.from(sha256(clear), "hex"));

  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: adminAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "schedule_update_sc"),
    methodArgs: [approvalSha256, clearSha256],
    boxes: [{ appIndex: xAlgoConsensusAppId, name: enc.encode(boxName) }],
    suggestedParams: params,
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareUpdateXAlgoConsensusSC(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  adminAddr: string,
  boxName: string,
  approvalSha256: Uint8Array,
  clearSha256: Uint8Array,
  params: SuggestedParams,
): Transaction {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: adminAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    onComplete: OnApplicationComplete.UpdateApplicationOC,
    method: getMethodByName(xAlgoConsensusABI.methods, "update_sc"),
    approvalProgram: approvalSha256,
    clearProgram: clearSha256,
    boxes: [{ appIndex: xAlgoConsensusAppId, name: enc.encode(boxName) }],
    suggestedParams: { ...params, flatFee: true, fee: 2000 },
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareAddProposerForXAlgoConsensus(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  registerAdminAddr: string,
  proposerAddr: string,
  params: SuggestedParams,
): Transaction[] {
  const rekeyTx = makePaymentTxnWithSuggestedParams(
    proposerAddr,
    proposerAddr,
    0,
    undefined,
    undefined,
    { ...params, flatFee: true, fee: 0 },
    getApplicationAddress(xAlgoConsensusAppId),
  );

  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: registerAdminAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "add_proposer"),
    methodArgs: [proposerAddr],
    boxes: [
      { appIndex: xAlgoConsensusAppId, name: enc.encode("pr") },
      {
        appIndex: xAlgoConsensusAppId,
        name: Uint8Array.from([...enc.encode("ap"), ...decodeAddress(proposerAddr).publicKey]),
      },
    ],
    suggestedParams: { ...params, flatFee: true, fee: 3000 },
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });

  return [rekeyTx, txns[0]];
}

export function prepareRebalanceXAlgoConsensusProposers(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  adminAddr: string,
  proposerIndex0: number | bigint,
  proposerIndex1: number | bigint,
  amount: number | bigint,
  proposerAddr0: string,
  proposerAddr1: string,
  params: SuggestedParams,
): Transaction {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: adminAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "rebalance_proposers"),
    methodArgs: [proposerIndex0, proposerIndex1, amount],
    appAccounts: [proposerAddr0, proposerAddr1],
    boxes: [{ appIndex: xAlgoConsensusAppId, name: enc.encode("pr") }],
    suggestedParams: { ...params, flatFee: true, fee: 2000 },
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareUpdateXAlgoConsensusProposerRange(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  adminAddr: string,
  minProposerBalance: number | bigint,
  maxProposerBalance: number | bigint,
  params: SuggestedParams,
): Transaction {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: adminAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "update_proposer_balance_range"),
    methodArgs: [minProposerBalance, maxProposerBalance],
    suggestedParams: params,
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareUpdateXAlgoConsensusMaxProposerBalance(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  adminAddr: string,
  maxProposerBalance: number | bigint,
  params: SuggestedParams,
): Transaction {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: adminAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "update_max_proposer_balance"),
    methodArgs: [maxProposerBalance],
    suggestedParams: params,
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareUpdateXAlgoConsensusFee(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  adminAddr: string,
  proposerAddrs: string[],
  fee: number | bigint,
  params: SuggestedParams,
): Transaction {
  if (proposerAddrs.length > 4) throw Error("Need to use dummy txn(s)");

  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: adminAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "update_fee"),
    methodArgs: [fee],
    appAccounts: proposerAddrs,
    boxes: [{ appIndex: xAlgoConsensusAppId, name: enc.encode("pr") }],
    suggestedParams: { ...params, flatFee: true, fee: 1000 * (2 + proposerAddrs.length) },
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareClaimXAlgoConsensusFee(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  senderAddr: string,
  adminAddr: string,
  proposerAddrs: string[],
  params: SuggestedParams,
): Transaction {
  if (proposerAddrs.length > 3) throw Error("Need to use dummy txn(s)");

  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: senderAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "claim_fee"),
    methodArgs: [],
    appAccounts: [adminAddr, ...proposerAddrs],
    boxes: [{ appIndex: xAlgoConsensusAppId, name: enc.encode("pr") }],
    suggestedParams: { ...params, flatFee: true, fee: 1000 * (2 + proposerAddrs.length) },
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareUpdateXAlgoConsensusPremium(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  adminAddr: string,
  premium: number | bigint,
  params: SuggestedParams,
): Transaction {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: adminAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "update_premium"),
    methodArgs: [premium],
    suggestedParams: params,
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function preparePauseXAlgoConsensusMinting(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  adminAddr: string,
  mintingType: string,
  toPause: boolean,
  params: SuggestedParams,
): Transaction {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: adminAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "pause_minting"),
    methodArgs: [mintingType, toPause],
    suggestedParams: params,
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareSetXAlgoConsensusProposerAdmin(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  senderAddr: string,
  proposerIndex: number | bigint,
  proposerAddr: string,
  newProposerAdminAddr: string,
  params: SuggestedParams,
): Transaction {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: senderAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "set_proposer_admin"),
    methodArgs: [proposerIndex, newProposerAdminAddr],
    boxes: [
      { appIndex: xAlgoConsensusAppId, name: enc.encode("pr") },
      {
        appIndex: xAlgoConsensusAppId,
        name: Uint8Array.from([...enc.encode("ap"), ...decodeAddress(proposerAddr).publicKey]),
      },
    ],
    suggestedParams: params,
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareRegisterXAlgoConsensusOnline(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  senderAddr: string,
  registerFeeAmount: number | bigint,
  proposerIndex: number | bigint,
  proposerAddr: string,
  voteKey: Buffer,
  selectionKey: Buffer,
  stateProofKey: Buffer,
  voteFirstRound: number | bigint,
  voteLastRound: number | bigint,
  voteKeyDilution: number | bigint,
  params: SuggestedParams,
): Transaction[] {
  const fundCall = {
    txn: transferAlgoOrAsset(0, senderAddr, proposerAddr, registerFeeAmount, params),
    signer: emptySigner,
  };
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: senderAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "register_online"),
    methodArgs: [
      fundCall,
      proposerIndex,
      encodeAddress(voteKey),
      encodeAddress(selectionKey),
      stateProofKey,
      voteFirstRound,
      voteLastRound,
      voteKeyDilution,
    ],
    appAccounts: [proposerAddr],
    boxes: [
      { appIndex: xAlgoConsensusAppId, name: enc.encode("pr") },
      {
        appIndex: xAlgoConsensusAppId,
        name: Uint8Array.from([...enc.encode("ap"), ...decodeAddress(proposerAddr).publicKey]),
      },
    ],
    suggestedParams: params,
  });
  return atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
}

export function prepareRegisterXAlgoConsensusOffline(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  senderAddr: string,
  proposerIndex: number | bigint,
  proposerAddr: string,
  params: SuggestedParams,
): Transaction {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: senderAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "register_offline"),
    methodArgs: [proposerIndex],
    appAccounts: [proposerAddr],
    boxes: [
      { appIndex: xAlgoConsensusAppId, name: enc.encode("pr") },
      {
        appIndex: xAlgoConsensusAppId,
        name: Uint8Array.from([...enc.encode("ap"), ...decodeAddress(proposerAddr).publicKey]),
      },
    ],
    suggestedParams: { ...params, flatFee: true, fee: 2000 },
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareSubscribeXAlgoConsensusProposerToXGov(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  senderAddr: string,
  xGovFeeAmount: number | bigint,
  proposerIndex: number | bigint,
  proposerAddr: string,
  xGovRegistryAppId: number,
  votingAddr: string,
  params: SuggestedParams,
): Transaction[] {
  const fundCall = {
    txn: transferAlgoOrAsset(0, senderAddr, getApplicationAddress(xAlgoConsensusAppId), xGovFeeAmount, params),
    signer: emptySigner,
  };
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: senderAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "subscribe_xgov"),
    methodArgs: [fundCall, proposerIndex, xGovRegistryAppId, votingAddr],
    appAccounts: [proposerAddr],
    boxes: [{ appIndex: xAlgoConsensusAppId, name: enc.encode("pr") }],
    suggestedParams: { ...params, flatFee: true, fee: 3000 },
  });
  return atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
}

export function prepareUnsubscribeXAlgoConsensusProposerFromXGov(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  senderAddr: string,
  proposerIndex: number | bigint,
  proposerAddr: string,
  xGovRegistryAppId: number,
  params: SuggestedParams,
): Transaction {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: senderAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "unsubscribe_xgov"),
    methodArgs: [proposerIndex, xGovRegistryAppId],
    appAccounts: [proposerAddr],
    boxes: [{ appIndex: xAlgoConsensusAppId, name: enc.encode("pr") }],
    suggestedParams: { ...params, flatFee: true, fee: 2000 },
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareImmediateMintFromXAlgoConsensus(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  xAlgoId: number,
  userAddr: string,
  receiverAddr: string,
  mintAmount: number | bigint,
  minReceived: number | bigint,
  proposerAddrs: string[],
  params: SuggestedParams,
): Transaction[] {
  if (proposerAddrs.length > 3) throw Error("Need to use dummy txn(s)");

  const sendAlgo = {
    txn: transferAlgoOrAsset(0, userAddr, getApplicationAddress(xAlgoConsensusAppId), mintAmount, params),
    signer: emptySigner,
  };
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: userAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "immediate_mint"),
    methodArgs: [sendAlgo, receiverAddr, minReceived],
    appAccounts: [receiverAddr, ...proposerAddrs],
    appForeignAssets: [xAlgoId],
    boxes: [{ appIndex: xAlgoConsensusAppId, name: enc.encode("pr") }],
    suggestedParams: { ...params, flatFee: true, fee: 1000 * (2 + proposerAddrs.length) },
  });
  return atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
}

export function prepareDelayedMintFromXAlgoConsensus(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  userAddr: string,
  receiverAddr: string,
  mintAmount: number | bigint,
  nonce: Uint8Array,
  proposerAddrs: string[],
  params: SuggestedParams,
): Transaction[] {
  if (proposerAddrs.length > 4) throw Error("Need to use dummy txn(s)");

  const boxName = Uint8Array.from([...enc.encode("dm"), ...decodeAddress(userAddr).publicKey, ...nonce]);

  const sendAlgo = {
    txn: transferAlgoOrAsset(0, userAddr, getApplicationAddress(xAlgoConsensusAppId), mintAmount, params),
    signer: emptySigner,
  };
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: userAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "delayed_mint"),
    methodArgs: [sendAlgo, receiverAddr, nonce],
    appAccounts: proposerAddrs,
    boxes: [
      { appIndex: xAlgoConsensusAppId, name: enc.encode("pr") },
      { appIndex: xAlgoConsensusAppId, name: boxName },
    ],
    suggestedParams: { ...params, flatFee: true, fee: 1000 * (1 + proposerAddrs.length) },
  });
  return atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
}

export function prepareClaimDelayedMintFromXAlgoConsensus(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  xAlgoId: number,
  senderAddr: string,
  minterAddr: string,
  receiverAddr: string,
  nonce: Uint8Array,
  proposerAddrs: string[],
  params: SuggestedParams,
): Transaction {
  if (proposerAddrs.length > 3) throw Error("Need to use dummy txn(s)");

  const boxName = Uint8Array.from([...enc.encode("dm"), ...decodeAddress(minterAddr).publicKey, ...nonce]);

  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: senderAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "claim_delayed_mint"),
    methodArgs: [minterAddr, nonce],
    appAccounts: [receiverAddr, ...proposerAddrs],
    appForeignAssets: [xAlgoId],
    boxes: [
      { appIndex: xAlgoConsensusAppId, name: enc.encode("pr") },
      { appIndex: xAlgoConsensusAppId, name: boxName },
    ],
    suggestedParams: { ...params, flatFee: true, fee: 3000 },
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}

export function prepareBurnFromXAlgoConsensus(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  xAlgoId: number,
  userAddr: string,
  receiverAddr: string,
  burnAmount: number | bigint,
  minReceived: number | bigint,
  proposerAddrs: string[],
  params: SuggestedParams,
): Transaction[] {
  if (proposerAddrs.length > 3) throw Error("Need to use dummy txn(s)");

  const sendXAlgo = {
    txn: transferAlgoOrAsset(xAlgoId, userAddr, getApplicationAddress(xAlgoConsensusAppId), burnAmount, params),
    signer: emptySigner,
  };
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: userAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "burn"),
    methodArgs: [sendXAlgo, receiverAddr, minReceived],
    appAccounts: [receiverAddr, ...proposerAddrs],
    appForeignAssets: [xAlgoId],
    boxes: [{ appIndex: xAlgoConsensusAppId, name: enc.encode("pr") }],
    suggestedParams: { ...params, flatFee: true, fee: 1000 * (2 + proposerAddrs.length) },
  });
  return atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
}

export function prepareXAlgoConsensusDummyCall(
  xAlgoConsensusABI: ABIContract,
  xAlgoConsensusAppId: number,
  senderAddr: string,
  proposerAddrs: string[],
  params: SuggestedParams,
): Transaction {
  if (proposerAddrs.length > 4) throw Error("Need to use other dummy txn(s)");

  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    sender: senderAddr,
    signer: emptySigner,
    appID: xAlgoConsensusAppId,
    method: getMethodByName(xAlgoConsensusABI.methods, "dummy"),
    methodArgs: [],
    appAccounts: proposerAddrs,
    suggestedParams: params,
  });
  const txns = atc.buildGroup().map(({ txn }) => {
    txn.group = undefined;
    return txn;
  });
  return txns[0];
}
