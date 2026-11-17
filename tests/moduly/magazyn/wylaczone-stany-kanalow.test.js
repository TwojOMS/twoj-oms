// Porównanie nagranych żądań: przy wyłączonych stanach 3 przebiegi pętli ofert ERLI i Allegro
// wysyłają do kanału żądania bajt w bajt równe nagraniu z zachowanego wzorca.
// Nagranie: `E4_BLIZNIAK_NAGRAJ=1 npx vitest run tests/moduly/magazyn/wylaczone-stany-kanalow.test.js` (tylko wariant i).
// Bez zmiennej test wyłącznie porównuje. Zestaw i warianty: tests/pomoc/e4-blizniak.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const licznik = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:crypto', async (oryginal) => {
  const m = await oryginal();
  const randomUUID = () => {
    licznik.n += 1;
    return `00000000-0000-4000-8000-${String(licznik.n).padStart(12, '0')}`;
  };
  return { ...m, default: { ...m.default, randomUUID }, randomUUID };
});

const { WARIANTY, przygotujErli, przygotujAllegro } = await import('../../pomoc/e4-blizniak.js');

const NAGRAJ = process.env.E4_BLIZNIAK_NAGRAJ === '1';
const plik = (kanal) => new URL(`../../fixtures/e4-blizniak-${kanal}.json`, import.meta.url);

beforeEach(() => { licznik.n = 0; });

async function porownaj(kanal, przygotuj, wariant) {
  const z = await przygotuj({ wariant });
  try {
    await z.przebiegi();
    const tekst = z.nagr.tekst();
    if (NAGRAJ && wariant === 'i') writeFileSync(plik(kanal), tekst);
    expect(tekst).toBe(readFileSync(plik(kanal), 'utf8'));
    return z.nagr.zadania;
  } finally { z.zamknij(); }
}

describe('E4 — test bliźniaczy: stany wyłączone = żądania do kanałów bez zmian', () => {
  it.each(WARIANTY)('ERLI, wariant (%s): 3 przebiegi > 100 zmian, żądania równe nagraniu bazy', async (wariant) => {
    const zadania = await porownaj('erli', przygotujErli, wariant);
    const batch = zadania.filter((z) => z.sciezka === '/api/products/batch-update');
    const pozycje = batch.flatMap((z) => JSON.parse(z.tresc));
    expect(pozycje.length).toBeGreaterThan(100);
    expect(pozycje.some((p) => 'stock' in p)).toBe(true);
    expect(pozycje.some((p) => 'price' in p)).toBe(true);
  });

  it.each(WARIANTY)('Allegro, wariant (%s): 3 przebiegi, żądania równe nagraniu bazy', async (wariant) => {
    const zadania = await porownaj('allegro', przygotujAllegro, wariant);
    expect(zadania.some((z) => z.metoda === 'PATCH')).toBe(true);
    expect(zadania.some((z) => z.metoda === 'PUT')).toBe(true);
  });
});
