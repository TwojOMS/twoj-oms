import type { Migracja } from '../../../core/kontrakty.ts';

// Znaki odcinane z identyfikatorów pozycji — ten sam zestaw co w zapytaniu sprzedaży karty
// (oms/db/sprzedaz-kanalow-karty.js). Migracja trzyma własną kopię, bo jej treść nie może się zmieniać.
const ODSTEPY =
  '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

// Okienka kanałów na karcie magazynu wybierają pozycje po identyfikatorze produktu albo oferty.
// Bez indeksu każde otwarcie karty przeglądało całą tabelę pozycji. Pomiar na 50 000 pozycji (katalog
// różnych produktów): 24–32 ms → 6–8 ms na kartę; im większa baza, tym większa różnica.
//
// ⚠️ Indeks na wyrażeniu W POSTACI, KTÓREJ UŻYWA ZAPYTANIE — razem ze znakami odstępu jako literałem.
// Planista SQLite dopasowuje indeks do wyrażenia tylko przy identycznym zapisie, a parametr wiązany
// (`:odstepy`) nigdy nie pasuje do indeksu. Zmiana zestawu znaków w zapytaniu wymaga nowej migracji.
export const migracjaIndeksuPozycjiKarty: Migracja = {
  numer: 5,
  nazwa: 'indeks pozycji po identyfikatorze produktu i oferty',
  wykonaj(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS pozycje_produkt_karty ON pozycje (trim(CAST(produkt_id AS TEXT), '${ODSTEPY}'));
      CREATE INDEX IF NOT EXISTS pozycje_oferta_karty ON pozycje (trim(oferta_id, '${ODSTEPY}'));
    `);
  },
};
