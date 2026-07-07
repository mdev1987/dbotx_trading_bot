import {
  readEncryptedEnvFile,
  decrypt,
  promptPassword,
  loadEnvContentIntoProcess,
} from "./crypto/crypto";

async function main() {
  const sealed = readEncryptedEnvFile();

  if (sealed) {
    const pw = await promptPassword("Enter decryption password");
    try {
      const content = decrypt(pw, sealed);
      loadEnvContentIntoProcess(content);
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
