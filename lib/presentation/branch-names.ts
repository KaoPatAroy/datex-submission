const regions: Record<string, string> = { East: 'ตะวันออก', Central: 'กลาง', South: 'ใต้' };

/** Pure presentation shared by the server answer and client conversation. */
export function displayBranchNames(text: string): string {
  return text.replace(/\bDemo (East|Central|South) Branch (\d+)\b/g,
    (_match, region: string, branch: string) => `สาขา${regions[region]} ${branch}`);
}

/** Exact aliases derived from authorized branch metadata; no branch directory. */
export function branchNameAliases(name: string): string[] {
  const aliases = [name, displayBranchNames(name)];
  if (/^Demo (East|Central|South) Branch \d+$/.test(name)) aliases.push(name.slice(5));
  return [...new Set(aliases)];
}
