import { Keypair } from "@solana/web3.js";
import crypto from "node:crypto";
import pino from "pino";
import { z } from "zod";

const envSchema = z.object({
  encryptedKey: z.string().min(1),
  salt: z.string().min(1),
  iv: z.string().min(1),
  passphrase: z.string().min(1)
});

export interface EncryptedKeyMaterial {
  encryptedKey: string;
  salt: string;
  iv: string;
  passphrase: string;
}

export class WalletManager {
  private readonly logger = pino({ name: "wallet-manager" });

  loadKeypair(material: EncryptedKeyMaterial): Keypair {
    const parsed = envSchema.parse(material);
    const salt = Buffer.from(parsed.salt, "hex");
    const iv = Buffer.from(parsed.iv, "hex");
    const key = crypto.scryptSync(parsed.passphrase, salt, 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);

    const encryptedBuffer = Buffer.from(parsed.encryptedKey, "hex");
    const authTag = encryptedBuffer.subarray(encryptedBuffer.length - 16);
    const payload = encryptedBuffer.subarray(0, encryptedBuffer.length - 16);

    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
    const secretKey = Uint8Array.from(JSON.parse(decrypted.toString("utf8")) as number[]);

    this.logger.info("wallet decrypted");

    return Keypair.fromSecretKey(secretKey);
  }

  static encryptKeypair(secretKey: Uint8Array, passphrase: string): EncryptedKeyMaterial {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(passphrase, salt, 32);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    const payload = Buffer.from(JSON.stringify(Array.from(secretKey)), "utf8");
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      encryptedKey: Buffer.concat([encrypted, authTag]).toString("hex"),
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      passphrase
    };
  }
}
