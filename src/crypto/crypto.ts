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
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();

    let valuePart = trimmed.slice(eqIdx + 1).trim();

    // Strip inline comments (# ...) — but only outside quotes
    if (valuePart.startsWith('"')) {
      const end = valuePart.indexOf('"', 1);
      if (end !== -1) {
        valuePart = valuePart.slice(1, end);
      }
    } else if (valuePart.startsWith("'")) {
      const end = valuePart.indexOf("'", 1);
      if (end !== -1) {
        valuePart = valuePart.slice(1, end);
      }
    } else {
      const commentIdx = valuePart.indexOf("#");
      if (commentIdx !== -1) {
        valuePart = valuePart.slice(0, commentIdx).trimEnd();
      }
    }

    if (key) {
      process.env[key] = valuePart;
    }
  }
}
