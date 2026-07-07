import { decrypt, loadSealedFromEnv, promptPassword } from "./crypto";

async function main() {
  const sealed = loadSealedFromEnv();
  if (!sealed) {
    console.log("DBOTX_API_KEY_SEALED not found in .env — nothing to decrypt");
    process.exit(1);
  }

  const pw = await promptPassword("Enter decryption password");
  try {
    const apiKey = decrypt(pw, sealed);
    console.log(`Decrypted API key:\n${apiKey}`);
  } catch {
    console.error("Decryption failed — wrong password or corrupted data");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
