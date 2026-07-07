import { hashit } from "@notifycode/hash-it";
import type { EncryptResult } from "@notifycode/hash-it";
import { password as passwordPrompt } from "@inquirer/prompts";
import { readFileSync } from "node:fs";

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

/**
 * Load an encrypted .env file from disk and return the sealed data.
 * Looks for .env.encrypted in the current working directory.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function readEncryptedEnvFile(): SealedData | null {
  try {
    const raw = readFileSync(".env.encrypted", "utf-8").trim();
    return JSON.parse(raw) as SealedData;
  } catch {
    return null;
  }
}

/**
 * Parse a decrypted .env file content (key=value lines) into process.env.
 * Supports:
 *   KEY=VALUE
 *   KEY="VALUE"
 *   KEY='VALUE'
 *   # comments
 *   empty lines
 */
export function loadEnvContentIntoProcess(content: string): void {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    if (key) {
      process.env[key] = value;
    }
  }
}
