import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { zbadajGranice } from '../../scripts/granice-modulow.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const plikWyjatkow = 'granice-modulow-wyjatki.json';

function porownajLimity(
  aktualne: Record<string, readonly string[]>,
  limity: Record<string, number>,
): string[] {
  const roznice: string[] = [];
  for (const [klucz, krawedzie] of Object.entries(aktualne)) {
    const limit = limity[klucz] ?? 0;
    if (krawedzie.length > limit) {
      roznice.push(`Nowa para lub krawędź ponad limit (${klucz}, ${krawedzie.length}/${limit}):\n${krawedzie.join('\n')}`);
    }
  }
  for (const [klucz, limit] of Object.entries(limity)) {
    const liczba = aktualne[klucz]?.length ?? 0;
    if (liczba < limit) roznice.push(`${klucz} (${liczba}/${limit}): obniż limit w ${plikWyjatkow}`);
  }
  return roznice;
}

it('pilnuje limitów importów i listy cykli', () => {
  const wyjatki = JSON.parse(readFileSync(new URL(plikWyjatkow, import.meta.url), 'utf8'));
  const { pozaWymaga, wzajemne, podPradWarstw, cykle } = zbadajGranice(repo);
  // Zamiana jednej krawędzi na inną w tej samej parze modułów nie zmienia licznika.
  const roznice = porownajLimity(
    Object.fromEntries(Object.entries(pozaWymaga).map(([para, dane]) => [para, dane.krawedzie])),
    wyjatki.pozaWymaga,
  );
  const policz = (lista: string[]) => {
    const grupy: Record<string, string[]> = {};
    for (const krawedz of lista) (grupy[krawedz] ??= []).push(krawedz);
    return grupy;
  };
  for (const [warstwy, krawedzie] of Object.entries(podPradWarstw)) {
    roznice.push(...porownajLimity(policz(krawedzie), wyjatki.podPradWarstw[warstwy] ?? {}));
  }
  const zapisaneWzajemne = new Set<string>(wyjatki.wzajemne);
  for (const [para, krawedzie] of Object.entries(wzajemne)) {
    if (!zapisaneWzajemne.delete(para)) {
      roznice.push(`Nowa para wzajemna (${para}):\n${krawedzie.join('\n')}`);
    }
  }
  for (const para of zapisaneWzajemne) {
    roznice.push(`${para}: obniż limit w ${plikWyjatkow}`);
  }

  const zapisaneCykle = new Set<string>(wyjatki.cykle.map((cykl: string[]) => cykl.join('\n')));
  for (const cykl of cykle) {
    const pliki = cykl.join('\n');
    if (!zapisaneCykle.delete(pliki)) roznice.push(`Nowy cykl:\n${pliki}`);
  }
  for (const pliki of zapisaneCykle) {
    roznice.push(`usuń cykl z ${plikWyjatkow}:\n${pliki}`);
  }
  expect(roznice, roznice.join('\n\n')).toEqual([]);
});
