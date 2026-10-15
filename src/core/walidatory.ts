export function poprawnyNip(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false;
  const wagi = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const suma = wagi.reduce((a, w, i) => a + w * Number(nip[i]), 0) % 11;
  return suma !== 10 && suma === Number(nip[9]);
}

export function poprawnyRachunek(nrb: string): boolean {
  if (!/^\d{26}$/.test(nrb)) return false;
  return BigInt(nrb.slice(2) + '2521' + nrb.slice(0, 2)) % 97n === 1n;
}
