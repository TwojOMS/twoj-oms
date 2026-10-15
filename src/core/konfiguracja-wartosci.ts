/** Limits of Node's timer and the installation policy approved for D07. */
export function interwal(wartosc: string | undefined, nazwa: string, domyslny: number, minimum: number): number {
  const ms = wartosc === undefined ? domyslny : Number(wartosc);
  if ((wartosc !== undefined && wartosc !== wartosc.trim()) || !Number.isSafeInteger(ms) || ms < minimum || ms > 2147483647)
    throw new Error(`${nazwa}: wymagany całkowity odstęp od ${minimum} do 2147483647 ms`);
  return ms;
}

/** Keep existing defaults and the original valid value; errors only name the key. */
export function skonfigurowanyUrl(wartosc: string | undefined, nazwa: string): string | undefined {
  if (wartosc === undefined || wartosc === '') return undefined;
  try {
    if (wartosc !== wartosc.trim()) throw new Error();
    const url = new URL(wartosc);
    if (!/^https?:\/\//i.test(wartosc) || !['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
  } catch { throw new Error(`${nazwa}: wymagany absolutny URL http/https`); }
  return wartosc;
}
