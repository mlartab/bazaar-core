import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes, pad, encodeAbiParameters } from "viem";
import {
  crToUsdc,
  crToUsdcUnits,
  verifyTransaction,
  releaseFunds,
  setWalletOverrides,
  clearWalletOverrides,
  usdcContractAddress,
  USDC_DECIMALS,
} from "../../protocol/wallet.js";

// Mocked viem clients throughout: no RPC, no keys, no network. Every test
// builds its own fake client objects; the real viem library is used only
// for ABI encoding so the fake logs parse exactly like chain logs.
const BUYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x3333333333333333333333333333333333333333";
const ESCROW = "0x00000000000000000000000000000000e5c20007";
const SELLER = "0x2222222222222222222222222222222222222222";
const TX = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// 60 CR at 1000 CR/USDC and 6 decimals -> 60_000 base units.
const SIXTY_CR_UNITS = 60000n;

function transferLog({ token, from, to, value }) {
  return {
    address: token,
    topics: [keccak256(toBytes("Transfer(address,address,uint256)")), pad(from), pad(to)],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

function receiptWith(logs, status = "success") {
  return { status, logs };
}

test("wallet: crToUsdc converts credits at 1000 CR = 1 USDC", () => {
  assert.equal(USDC_DECIMALS, 6);
  assert.equal(crToUsdc(60), "0.06");
  assert.equal(crToUsdc(1000), "1");
  assert.equal(crToUsdc(1), "0.001");
  assert.equal(crToUsdcUnits(60), SIXTY_CR_UNITS);
  assert.throws(() => crToUsdc(0), /positive integer/);
  assert.throws(() => crToUsdc(-5), /positive integer/);
  assert.throws(() => crToUsdc(1.5), /positive integer/);
});

test("wallet: verifyTransaction accepts the exact buyer-to-escrow transfer", async () => {
  const fake = {
    getTransactionReceipt: async ({ hash }) => {
      assert.equal(hash, TX);
      return receiptWith([
        transferLog({ token: usdcContractAddress(), from: BUYER, to: ESCROW, value: SIXTY_CR_UNITS }),
      ]);
    },
  };
  assert.equal(await verifyTransaction(TX, "0.06", BUYER, { publicClient: fake, escrowAddress: ESCROW }), true);
});

test("wallet: verifyTransaction rejects wrong amounts, senders, and tokens", async () => {
  const log = transferLog({ token: usdcContractAddress(), from: BUYER, to: ESCROW, value: SIXTY_CR_UNITS });
  const fake = { getTransactionReceipt: async () => receiptWith([log]) };
  const clients = { publicClient: fake, escrowAddress: ESCROW };
  // Wrong expected amount.
  assert.equal(await verifyTransaction(TX, "0.07", BUYER, clients), false);
  // Wrong sender.
  assert.equal(await verifyTransaction(TX, "0.06", OTHER, clients), false);
  // Wrong token contract.
  const wrongToken = {
    getTransactionReceipt: async () =>
      receiptWith([transferLog({ token: OTHER, from: BUYER, to: ESCROW, value: SIXTY_CR_UNITS })]),
  };
  assert.equal(await verifyTransaction(TX, "0.06", BUYER, { publicClient: wrongToken, escrowAddress: ESCROW }), false);
  // Wrong recipient.
  const wrongTo = {
    getTransactionReceipt: async () =>
      receiptWith([transferLog({ token: usdcContractAddress(), from: BUYER, to: OTHER, value: SIXTY_CR_UNITS })]),
  };
  assert.equal(await verifyTransaction(TX, "0.06", BUYER, { publicClient: wrongTo, escrowAddress: ESCROW }), false);
  // Failed receipt.
  const failed = { getTransactionReceipt: async () => receiptWith([log], "reverted") };
  assert.equal(await verifyTransaction(TX, "0.06", BUYER, { publicClient: failed, escrowAddress: ESCROW }), false);
  // RPC throws and malformed hashes read as false, never throw.
  const throwing = {
    getTransactionReceipt: async () => {
      throw new Error("boom");
    },
  };
  assert.equal(await verifyTransaction(TX, "0.06", BUYER, { publicClient: throwing, escrowAddress: ESCROW }), false);
  assert.equal(await verifyTransaction("not-a-hash", "0.06", BUYER, clients), false);
});

test("wallet: releaseFunds transfers USDC and returns the payout hash", async () => {
  let captured = null;
  const fakeWallet = {
    writeContract: async (args) => {
      captured = args;
      return "0xPAYOUTHASH";
    },
  };
  const hash = await releaseFunds(SELLER, "0.06", { walletClient: fakeWallet });
  assert.equal(hash, "0xPAYOUTHASH");
  assert.equal(captured.address, usdcContractAddress());
  assert.equal(captured.functionName, "transfer");
  assert.deepEqual(captured.args, [SELLER, SIXTY_CR_UNITS]);
  // Invalid seller addresses throw instead of broadcasting.
  await assert.rejects(() => releaseFunds("nope", "0.06", { walletClient: fakeWallet }), /valid 0x address/);
});

test("wallet: overrides let the server substitute verification in-process", async () => {
  setWalletOverrides({ verifyTransaction: async () => true });
  try {
    // No clients, no env keys: the override answers without touching viem.
    assert.equal(await verifyTransaction("0xwhatever", "0.06", BUYER), true);
  } finally {
    clearWalletOverrides();
  }
});
