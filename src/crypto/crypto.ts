import { hashit } from "@notifycode/hash-it";
import type { EncryptResult } from "@notifycode/hash-it";
import { password as passwordPrompt } from "@inquirer/prompts";

export type SealedData = EncryptResult;

export function encrypt(password: string, plaintext: string): SealedData {
  return hashit.encrypt.seal(plaintext, password);
}

export function decrypt(password: string, sealed: SealedData): string {
  return hashit.encrypt.open(sealed, password);
}

export async function promptPassword(
  message?: string,
): Promise<string> {
  return passwordPrompt({ message: message ?? "Password", mask: true });
}

export function loadSealedFromEnv(): SealedData | null {
  const raw = process.env.DBOTX_API_KEY_SEALED;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SealedData;
  } catch {
    return null;
  }
}

export function parseSealed(raw: string): SealedData {
  return JSON.parse(raw) as SealedData;
}
