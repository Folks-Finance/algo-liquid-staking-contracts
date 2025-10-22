import {
  Algodv2,
  assignGroupID,
  LogicSigAccount,
  makeAssetTransferTxnWithSuggestedParams,
  makePaymentTxnWithSuggestedParams,
  signLogicSigTransaction,
  SuggestedParams,
  Transaction,
  waitForConfirmation as wfc,
} from "algosdk";

export const emptySigner = async () => [];

export function getParams(algodClient: Algodv2): Promise<SuggestedParams> {
  return algodClient.getTransactionParams().do();
}

/**
 * Transfer algo or asset. 0 assetId indicates algo transfer, else asset transfer.
 */
export function transferAlgoOrAsset(
  assetId: number,
  from: string,
  to: string,
  amount: number | bigint,
  params: SuggestedParams,
): Transaction {
  return assetId !== 0
    ? makeAssetTransferTxnWithSuggestedParams(from, to, undefined, undefined, amount, undefined, assetId, params)
    : makePaymentTxnWithSuggestedParams(from, to, amount, undefined, undefined, params);
}

/**
 * Submit single transaction
 */
export async function submitTransaction(algodClient: Algodv2, txn: Transaction, signer: Uint8Array): Promise<string> {
  const signedTxn = txn.signTxn(signer);
  const { txId } = await algodClient.sendRawTransaction(signedTxn).do();
  await waitForConfirmation(algodClient, txId);
  return txId;
}

/**
 * Submit atomic group transaction
 */
export async function submitGroupTransaction(
  algodClient: Algodv2,
  txns: Transaction[],
  signers: (Uint8Array | LogicSigAccount)[],
  assignGroupId: boolean = true,
): Promise<string[]> {
  if (assignGroupId) assignGroupID(txns);
  const signedTxns = txns.map((txn, i) => {
    if (signers[i] instanceof LogicSigAccount) return signLogicSigTransaction(txn, signers[i] as LogicSigAccount).blob;
    return txn.signTxn(signers[i] as Uint8Array);
  });
  await algodClient.sendRawTransaction(signedTxns).do();
  await waitForConfirmation(algodClient, txns[0].txID());
  return txns.map((txn) => txn.txID());
}

export const waitForConfirmation = async function (algodClient: Algodv2, txId: string, waitRounds: number = 1000) {
  await wfc(algodClient, txId, waitRounds);
};
