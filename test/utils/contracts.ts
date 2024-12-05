import { Algodv2 } from "algosdk";
import { TealKeyValue } from "algosdk/dist/types/client/v2/algod/models/types";
import { spawnSync } from "child_process";

export const enc = new TextEncoder();

/**
 * Compile PyTEAL program and return TEAL string
 */
export function compilePyTeal(path: string, ...args: any[]): string {
  const pythonProcess = spawnSync('python3', [`${path}.py`, ...args]);
  if (pythonProcess.stderr && pythonProcess.stderr.toString() != "") console.log(pythonProcess.stderr.toString());
  return pythonProcess.stdout.toString();
}

/**
 * Helper function to compile TEAL program
 */
export async function compileTeal(programSource: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const programBytes = enc.encode(programSource);
  const compileResponse = await new Algodv2('', 'https://mainnet-api.algonode.cloud/', 443).compile(programBytes).do();
  const compiledBytes = new Uint8Array(Buffer.from(compileResponse.result, "base64"));
  return compiledBytes;
}

function encodeToBase64(str: string, encoding: BufferEncoding = 'utf8') {
  return Buffer.from(str, encoding).toString('base64');
}

export function getParsedValueFromState(
  state: TealKeyValue[],
  key: string,
  encoding: BufferEncoding = 'utf8',
): string | bigint | undefined {
  const encodedKey: string = encoding ? encodeToBase64(key, encoding) : key;
  const keyValue: TealKeyValue | undefined = state.find(entry => entry.key === encodedKey);
  if (keyValue === undefined) return;
  const { value } = keyValue;
  if (value.type === 1) return value.bytes;
  if (value.type === 2) return BigInt(value.uint);
  return;
}

export async function getAppGlobalState(algodClient: Algodv2, appId: number): Promise<TealKeyValue[]> {
  const app = await algodClient.getApplicationByID(appId).do();
  return app['params']['global-state'];
}

export function parseUint64s(base64Value: string): bigint[] {
  const value = Buffer.from(base64Value, 'base64').toString('hex');
  // uint64s are 8 bytes each
  const uint64s: bigint[] = [];
  for (let i = 0; i < value.length; i += 16) {
    uint64s.push(BigInt("0x" + value.slice(i, i + 16)))
  }
  return uint64s;
}
