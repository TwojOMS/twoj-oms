import { afterEach, beforeEach, expect, it } from 'vitest';
import { czyKanalAllegro, ustawKanalyAllegro, kanalyAllegro } from '../../src/domena/wysylka.js';

const tabela = [
  [{ sklep: 'allegro_polcien' }, true, 'allegro'],
  [{ sklep: 'rynek_polcien' }, true, 'allegro'],
  [{ sklep: 'sklep_polcien' }, false, 'woo'],
  [{ sklep: 'reczne' }, false, 'woo'],
  [{ sklep: 'ALLEGRO_x' }, false, 'woo'],
  [{ sklep: 'allegrowy' }, false, 'woo'],
  [{ sklep: '' }, false, 'woo'],
  [{ sklep: undefined }, false, 'woo'],
  [null, false, 'woo'],
] as const;

beforeEach(() => ustawKanalyAllegro(['rynek_polcien']));
afterEach(() => ustawKanalyAllegro([]));

it.each(tabela)('złoty predykat przez wysylka.js: %j → %s', (z, allegro) => {
  expect(czyKanalAllegro(z)).toBe(allegro);
});

it.each(tabela)('złoty moduł zamówienia: %j → %s / %s', async (z, _allegro, typ) => {
  const { modulZamowienia, umiejetnosciZamowienia } = await import('../../src/domena/moduly-kanalow.ts');
  expect(modulZamowienia(z).typ).toBe(typ);
  expect(umiejetnosciZamowienia(z)).toBe(modulZamowienia(z).umiejetnosci);
});

it('jawny zbiór zastępuje konfigurację, a prefiks nadal wygrywa', () => {
  const klucze = new Set(['sklep_polcien']);
  expect(czyKanalAllegro({ sklep: 'rynek_polcien' }, klucze)).toBe(false);
  expect(czyKanalAllegro({ sklep: 'sklep_polcien' }, klucze)).toBe(true);
  expect(czyKanalAllegro({ sklep: 'allegro_polcien' }, klucze)).toBe(true);
  const kopia = kanalyAllegro();
  kopia.push('sklep_polcien');
  expect(kanalyAllegro()).toEqual(['rynek_polcien']);
  ustawKanalyAllegro(undefined);
  expect(kanalyAllegro()).toEqual([]);
});
