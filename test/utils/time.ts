import { Algodv2 } from "algosdk";
import { fundAccountWithAlgo, funder } from "./fund";

/**
 * Advance previous block timestamp by setting offset
 */
export async function advancePrevBlockTimestamp(algodClient: Algodv2, secs: number): Promise<bigint> {
  // set offset
  await algodClient.setBlockOffsetTimestamp(secs).do();

  // add block for new timestamp
  const txId = await fundAccountWithAlgo(algodClient, funder.addr, 0);
  const txInfo = await algodClient.pendingTransactionInformation(txId).do();
  const { block } = await algodClient.block(txInfo["confirmed-round"]).do();

  // reset offset
  await algodClient.setBlockOffsetTimestamp(0).do();

  // return timestamp of latest block
  return BigInt(block.ts);
}

export async function advanceBlockRounds(algodClient: Algodv2, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await fundAccountWithAlgo(algodClient, funder.addr, 0);
  }
}
