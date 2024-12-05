import { makeAssetTransferTxnWithSuggestedParams, SuggestedParams, Transaction } from "algosdk";

export function prepareOptIntoAssetTxn(addr: string, assetId: number, params: SuggestedParams): Transaction {
  return makeAssetTransferTxnWithSuggestedParams(addr, addr, undefined, undefined, 0, undefined, assetId, params);
}

export function prepareOptIntoAssetsTxns(addr: string, assetIds: number[], params: SuggestedParams): Transaction[] {
  return assetIds.map(assetId => prepareOptIntoAssetTxn(addr, assetId, params));
}
