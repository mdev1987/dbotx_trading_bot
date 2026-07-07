import { readFileSync, writeFileSync } from "node:fs";
import { encrypt, promptPassword } from "./crypto";

const ENV_PATH = ".env";
const OUTPUT_PATH = ".env.encrypted";

async function main() {
  const content = readFileSync(ENV_PATH, "utf-8");

  const pw = await promptPassword("Enter encryption password");
  const confirm = await promptPassword("Confirm encryption password");
  if (pw !== confirm) {
    console.error("Passwords do not match");
    process.exit(1);
  }

  const sealed = encrypt(pw, content);
  const encoded = JSON.stringify(sealed);
  writeFileSync(OUTPUT_PATH, encoded, "utf-8");
  console.log(`Encrypted ${ENV_PATH} → ${OUTPUT_PATH}`);
  console.log("You may now remove or keep .env for local development.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
