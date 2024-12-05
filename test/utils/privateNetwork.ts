import { Algodv2 } from "algosdk";
import { execSync } from "child_process";
import { readFileSync } from "fs";

/**
 * Connection to private network
 */
const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const algodServer = 'http://127.0.0.1'
export const privateAlgodClient = () => {
    const port = Buffer.from(readFileSync("net1/Primary/algod.net")).toString().split(":")[1];
    return new Algodv2(token, algodServer, port);
}

/**
 * Start private network
 */
export async function startPrivateNetwork() {
    execSync('sh scripts/startnet.sh');
}

/**
 * Stop private network
 */
export function stopPrivateNetwork() {
    execSync('sh scripts/stopnet.sh');
}
