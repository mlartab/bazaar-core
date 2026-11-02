// Real escrow wallet on Base Sepolia (testnet USDC). No mocks, no minted
// balances: every credit that settles here rode in as an on-chain USDC
// Transfer and rode out as an on-chain USDC transfer.
//
// Conversion: 1000 CR (protocol credits) = 1 USDC, so 1 CR = 0.001 USDC =
// 1000 base units of 6-decimal USDC. Integer math only (BigInt), so the
// protocol's integer-credit invariant survives the crossing.
//
// SECURITY: the escrow key is read from ESCROW_PRIVATE_KEY at call time and
// never logged, never returned, never stored. Only the derived address is
// ever exposed (getEscrowAddress). Testability comes from client injection
// (the `clients` argument / setWalletOverrides), never from key fixtures.

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  parseEventLogs,
  isAddress,
  erc20Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export const USDC_DECIMALS = 6;
// Base units of USDC per whole credit: 0.001 USDC at 6 decimals.
export const USDC_UNITS_PER_CR = 1000n;

// Circle's published USDC on Base Sepolia. Overridable for fixtures;
// production must use this address.
export function usdcContractAddress() {
  return process.env.USDC_CONTRACT_ADDRESS ?? "0x036CbD53842c5426634e7920A7755D7e7a0e6939f";
}

export function baseSepoliaRpcUrl() {
  return process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
}

// Module-level overrides for tests: per-call `clients` always wins, these
// fill in when the caller passes none. Protocol tests run the real server
// in-process, so they install mock clients here instead of touching the
// chain. Production never calls this.
let overrides = {};
export function setWalletOverrides(next = {}) {
  overrides = { ...overrides, ...next };
}
export function clearWalletOverrides() {
  overrides = {};
}

function escrowAccount() {
  const key = process.env.ESCROW_PRIVATE_KEY;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("ESCROW_PRIVATE_KEY is not set");
  }
  return privateKeyToAccount(key);
}

// The only escrow secret-derived value that may leave this module.
export function getEscrowAddress() {
  return escrowAccount().address;
}

function getPublicClient(override) {
  const client = override ?? overrides.publicClient;
  if (client !== undefined) return client;
  return createPublicClient({ chain: baseSepolia, transport: http(baseSepoliaRpcUrl()) });
}

function getWalletClient(override) {
  const client = override ?? overrides.walletClient;
  if (client !== undefined) return client;
  return createWalletClient({ account: escrowAccount(), chain: baseSepolia, transport: http(baseSepoliaRpcUrl()) });
}

// Credits -> USDC decimal string ("60" -> "0.06"). Integer math: no float
// ever touches money.
export function crToUsdc(crAmount) {
  return formatUnits(crToUsdcUnits(crAmount), USDC_DECIMALS);
}

// Credits -> USDC base units (BigInt). The exact on-chain comparison unit.
export function crToUsdcUnits(crAmount) {
  if (!Number.isInteger(crAmount) || crAmount <= 0) {
    throw new Error("crAmount must be a positive integer");
  }
  return BigInt(crAmount) * USDC_UNITS_PER_CR;
}

// True only when the chain shows exactly one thing: `expectedAmountUsdc`
// USDC moved from the buyer to THIS escrow wallet in a successful
// transaction. Wrong token, wrong sender, wrong recipient, wrong amount,
// failed receipt, or any RPC error all read as false — never throw, so a
// chain hiccup is a rejected payment, not a crashed request.
export async function verifyTransaction(txHash, expectedAmountUsdc, expectedSender, clients = {}) {
  if (typeof overrides.verifyTransaction === "function") {
    return overrides.verifyTransaction(txHash, expectedAmountUsdc, expectedSender);
  }
  try {
    if (typeof txHash !== "string" || !txHash.startsWith("0x")) return false;
    if (typeof expectedSender !== "string" || !isAddress(expectedSender)) return false;
    const publicClient = getPublicClient(clients.publicClient);
    const escrow = String(clients.escrowAddress ?? overrides.escrowAddress ?? getEscrowAddress()).toLowerCase();
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (receipt === null || receipt === undefined || receipt.status !== "success") return false;
    const expectedValue = parseUnits(String(expectedAmountUsdc), USDC_DECIMALS);
    const usdc = usdcContractAddress().toLowerCase();
    const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs ?? [], eventName: "Transfer" });
    return transfers.some(
      (t) =>
        String(t.address ?? "").toLowerCase() === usdc &&
        String(t.args?.from ?? "").toLowerCase() === expectedSender.toLowerCase() &&
        String(t.args?.to ?? "").toLowerCase() === escrow &&
        t.args?.value === expectedValue,
    );
  } catch {
    return false;
  }
}

// Pay the seller on-chain from the escrow wallet. Returns the payout tx
// hash for the deal row. Throws when the seller address is invalid or the
// broadcast fails — the caller (inspector) must fail frozen, never settle.
export async function releaseFunds(sellerWalletAddress, amountUsdc, clients = {}) {
  if (typeof overrides.releaseFunds === "function") {
    return overrides.releaseFunds(sellerWalletAddress, amountUsdc);
  }
  if (typeof sellerWalletAddress !== "string" || !isAddress(sellerWalletAddress)) {
    throw new Error("sellerWalletAddress must be a valid 0x address");
  }
  const walletClient = getWalletClient(clients.walletClient);
  return walletClient.writeContract({
    address: usdcContractAddress(),
    abi: erc20Abi,
    functionName: "transfer",
    args: [sellerWalletAddress, parseUnits(String(amountUsdc), USDC_DECIMALS)],
  });
}
