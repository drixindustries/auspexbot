import test from "node:test";
import assert from "node:assert/strict";
import { testEnv } from "./helpers.js";
testEnv();
const { solanaReceived, assertRecent } = await import("../payments.js");
const { normalizeCallAddress } = await import("../rankings.js");
const { extractAddress } = await import("../lib/scan.js");

const OWNER = "Recv1111111111111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const bal = (owner, amount) => ({ owner, mint: USDC, uiTokenAmount: { amount: String(amount) } });

test("Solana: USDC counted only when OUR balance increases (closes the transferChecked hole)", () => {
  const paid = { meta: { preTokenBalances: [bal(OWNER, 0), bal("Payer", 20_000_000)], postTokenBalances: [bal(OWNER, 10_000_000), bal("Payer", 10_000_000)], preBalances: [0, 0], postBalances: [0, 0] }, transaction: { message: { accountKeys: [{ pubkey: "Payer", signer: true }, { pubkey: OWNER, signer: false }] } } };
  assert.equal(solanaReceived(paid, OWNER, USDC).usdcRaw, 10_000_000);
  assert.equal(solanaReceived(paid, OWNER, USDC).from, "Payer");
  // someone else's public USDC transfer (old code accepted any transferChecked >= $10)
  const other = { meta: { preTokenBalances: [bal("A", 50_000_000), bal("B", 0)], postTokenBalances: [bal("A", 0), bal("B", 50_000_000)], preBalances: [0, 0], postBalances: [0, 0] }, transaction: { message: { accountKeys: [{ pubkey: "A", signer: true }, { pubkey: "B" }] } } };
  assert.deepEqual([solanaReceived(other, OWNER, USDC).usdcRaw, solanaReceived(other, OWNER, USDC).lamports], [0, 0]);
});
test("Solana: SOL lamport delta", () => {
  const tx = { meta: { preBalances: [5e9, 1e9], postBalances: [4.9e9, 1.1e9] }, transaction: { message: { accountKeys: ["Payer", OWNER] } } };
  assert.equal(solanaReceived(tx, OWNER, USDC).lamports, 1e8);
});
test("old transactions are rejected (replay guard)", () => {
  const now = Date.parse("2026-10-23T00:00:00Z");
  assert.doesNotThrow(() => assertRecent(now - 3600e3, now));
  assert.throws(() => assertRecent(now - 30 * 86400e3, now), /older than/);
  assert.throws(() => assertRecent(null, now));
});
test("call addresses: EVM lowercased, Solana case preserved", () => {
  assert.equal(normalizeCallAddress("0xAbCdEf0000000000000000000000000000000001"), "0xabcdef0000000000000000000000000000000001");
  assert.equal(normalizeCallAddress("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"), "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
  assert.equal(extractAddress("/call DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 lfg").family, "solana");
  assert.equal(extractAddress("check 0x4ed4e862860bed51a9570b96d89af5e1b0efefed").family, "evm");
});
