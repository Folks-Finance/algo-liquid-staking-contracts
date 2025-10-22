import { Algodv2, makePaymentTxnWithSuggestedParams, mnemonicToSecretKey, SuggestedParams } from "algosdk";
import { waitForConfirmation } from "./transaction";

/**
 * Main account that can be used as funder
 */
export const funder = mnemonicToSecretKey(
  "adapt mule code swamp target refuse inspire violin winner fashion reopen evoke crouch work swim segment subway hybrid donate orbit guess govern cost abstract vault",
);

/**
 * Main account that can be used as an algo dispenser
 */
export async function fundAccountWithAlgo(
  algodClient: Algodv2,
  addr: string,
  amount: number | bigint,
  params?: SuggestedParams,
): Promise<string> {
  // Fetch params if has not been passed
  if (!params) params = await algodClient.getTransactionParams().do();

  // fund
  const tx = makePaymentTxnWithSuggestedParams(funder.addr, addr, amount, undefined, undefined, params);
  const signedTx = tx.signTxn(funder.sk);
  await algodClient.sendRawTransaction(signedTx).do();
  await waitForConfirmation(algodClient, tx.txID());

  // return transaction id
  return tx.txID();
}
