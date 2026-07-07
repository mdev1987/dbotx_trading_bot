import { loadSealedFromEnv, decrypt, promptPassword } from "./crypto/crypto";

async function main() {
  const sealed = loadSealedFromEnv();
  if (sealed) {
    const pw = await promptPassword("Enter decryption password");
    try {
      const apiKey = decrypt(pw, sealed);
      process.env.DBOTX_API_KEY = apiKey;
    } catch {
      console.error("Decryption failed — wrong password or corrupted data");
      process.exit(1);
    }
  }

  await import("./main");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
