import { readFileSync, writeFileSync } from "node:fs";
import { encrypt, promptPassword } from "./crypto";

const ENV_PATH = ".env";

async function main() {
  const env = readFileSync(ENV_PATH, "utf-8");
  const match = env.match(/^DBOTX_API_KEY=(.+)$/m);
  if (!match) {
    console.error(".env missing DBOTX_API_KEY");
    process.exit(1);
  }
  const apiKey = match[1]!.trim();
  if (!apiKey || apiKey.startsWith("your_") || apiKey.startsWith("{")) {
    console.error("No real DBOTX_API_KEY found — nothing to encrypt");
    process.exit(1);
  }

  const pw = await promptPassword("Enter encryption password");
  const confirm = await promptPassword("Confirm encryption password");
  if (pw !== confirm) {
    console.error("Passwords do not match");
    process.exit(1);
  }

  const sealed = encrypt(pw, apiKey);
  const encoded = JSON.stringify(sealed);

  const updated = env.replace(
    /^DBOTX_API_KEY=.*$/m,
    `DBOTX_API_KEY_SEALED=${encoded}`,
  );
  writeFileSync(ENV_PATH, updated, "utf-8");
  console.log("DBOTX_API_KEY encrypted → DBOTX_API_KEY_SEALED in .env");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
