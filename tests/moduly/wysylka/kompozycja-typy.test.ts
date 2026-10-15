import { expect, it } from 'vitest';
import { zbudujKurierow, wczytajKurierow } from '../../../src/moduly/wysylka/kurierzy.ts';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import type { Kurier, ZlecenieKuriera } from '../../../src/core/kontrakty.ts';

// Rzeczywista droga fabryka → mapa → konsument. Nie wywołujemy nadań.
function odmowyKompozycji() {
  const mapa = zbudujKurierow(wczytajKurierow({}), {});
  const db = {} as Parameters<typeof createNadanie>[0]['db'];
  const usluga = createNadanie({ db, kurierzy: mapa, katalogEtykiet: '/nie-wywolujemy' });
  if (mapa.dpd) {
    // @ts-expect-error mapa nie może zgubić kontraktu identyfikatora zamówienia
    void mapa.dpd.nadaj({ zamowienie: { numer: 'TEST' }, paczka: { waga: 1, dlugosc: 1, szerokosc: 1, wysokosc: 1 } });
    // @ts-expect-error waga z formularza musi być sparsowana przed mapą kurierów
    void mapa.dpd.nadaj({} as Omit<ZlecenieKuriera, 'paczka'> & { paczka: { waga: string } });
  }
  // @ts-expect-error rzeczywisty konsument nie może dostać fabryki z błędnym zleceniem
  createNadanie({ db, katalogEtykiet: '/nie-wywolujemy', kurierzy: { dpd: { nadaj: async (_z: string) => ({ numerListu: null }) } } });
  // @ts-expect-error konsument przyjmuje liczbę id, nie wartość formularza
  void usluga.nadaj('1');
  // @ts-expect-error paczka rzeczywistego konsumenta musi mieć pełny wynik parsera
  void usluga.nadaj(1, { waga: '1' });
  const poprawny: Kurier = { nadaj: async (_z: ZlecenieKuriera) => ({ numerListu: null }) };
  void poprawny;
}
void odmowyKompozycji;
it('utrzymuje negatywne sprawdzenia całej drogi produkcyjnej w kompilacji', () => expect(typeof odmowyKompozycji).toBe('function'));
