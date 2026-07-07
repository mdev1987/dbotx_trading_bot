import { readEncryptedEnvFile, decrypt, promptPassword } from "./crypto";

async function main() {
  const sealed = readEncryptedEnvFile();
  if (!sealed) {
    console.error(".env.encrypted not found or corrupt");
    process.exit(1);
  }

  const pw = await promptPassword("Enter decryption password");
  try {
    const content = decrypt(pw, sealed);
    console.log(content);
  } catch {
    console.error("Decryption failed — wrong password or corrupted data");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
