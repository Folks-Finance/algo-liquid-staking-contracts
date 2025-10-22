import { Algodv2 } from "algosdk";

export async function getAlgoBalance(algodClient: Algodv2, addr: string): Promise<bigint> {
  const acc = await algodClient.accountInformation(addr).do();
  return BigInt(acc["amount"]);
}

export async function getAssetBalance(algodClient: Algodv2, addr: string, assetId: number): Promise<bigint> {
  const accInfo = await algodClient.accountInformation(addr).do();
  const assets = accInfo["assets"];
  if (!assets) return BigInt(0);
  for (const asset of assets) {
    if (assetId === asset["asset-id"]) return BigInt(asset["amount"]);
  }
  return BigInt(0);
}
