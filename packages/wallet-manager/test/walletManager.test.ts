import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { WalletManager } from "../src/index.js";

describe("WalletManager", () => {
  it("encrypts and decrypts keypairs", () => {
    const keypair = Keypair.generate();
    const material = WalletManager.encryptKeypair(keypair.secretKey, "passphrase");
    const manager = new WalletManager();
    const restored = manager.loadKeypair(material);

    expect(restored.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
  });
});
