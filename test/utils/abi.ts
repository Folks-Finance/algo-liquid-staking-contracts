import { ABIContract } from "algosdk";
import * as fs from "fs";

export function getABIContract(path: string): ABIContract {
  const buff = fs.readFileSync(`${path}.json`);
  return new ABIContract(JSON.parse(buff.toString()));
}
