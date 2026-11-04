import { createHash } from 'node:crypto';

// Nazwy porównujemy przez SHA-256; jawne dane właściciela nie trafiają do repo.
export function zawieraNazwe(tresc, wzorce) {
  for (const { wzor, skrot, bezWielkosci } of wzorce) {
    for (const m of tresc.matchAll(new RegExp(`(?=(${wzor}))`, 'gu'))) {
      const nazwa = m[1].replace(/\s/g, '');
      if (createHash('sha256').update(bezWielkosci ? nazwa.toLowerCase() : nazwa).digest('hex') === skrot) return true;
    }
  }
  return false;
}

export function wzorzecNazw(wzorce, pozostale = /(?!)/) {
  return { test: (tresc) => pozostale.test(tresc) || zawieraNazwe(tresc, wzorce) };
}
