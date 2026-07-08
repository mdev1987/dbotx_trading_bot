export function maskAddress(addr: string, prefixLen = 6, suffixLen = 4): string {
  if (addr.length <= prefixLen + suffixLen + 3) return addr;
  return `${addr.slice(0, prefixLen)}...${addr.slice(-suffixLen)}`;
}

export function maskWalletId(id: string | number): string {
  const s = String(id);
  return maskAddress(s, 4, 4);
}
