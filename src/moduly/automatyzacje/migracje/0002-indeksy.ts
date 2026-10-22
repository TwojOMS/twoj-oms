import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-108.08 (poprawki po recenzji 08, usterki 4 i 5): indeksy dla detektorów „Status zmienił się na” i „Paczka nadana”
// (okno 14 dni po `utworzona_at`) oraz ostrzeżeń.
// Migracja ADDYTYWNA — same zwykłe (nie UNIQUE) indeksy; strażnik migracji je dopuszcza także na tabelach innych modułów
// (precedens: zamowienia/0001 zakłada indeksy na `przesylki` i `platnosci` z rdzenia). W module automatyzacji, bo tylko
// on ich potrzebuje; tabele `zamowienia` i `zamowienia_status_wlasny` istnieją, bo moduł wymaga `zamowienia`.
// Pomiar (kopia bazy recenzenta: 50 000 zamówień, surowe_json 4 KB, laptop): status → Wysłane 365 ms → patrz raport
// PRZ-108.08; bez indeksu `wyslane_at` każde sprawdzenie czytało całą tabelę razem ze stronami przepełnienia.
export const migracjaIndeksow: Migracja = {
  numer: 2,
  nazwa: 'indeksy detektora statusu i ostrzeżeń automatyzacji',
  wykonaj(db) {
    db.exec(`
      CREATE INDEX zamowienia_wyslane_at ON zamowienia (wyslane_at);
      CREATE INDEX zamowienia_w_realizacji_at ON zamowienia (w_realizacji_at);
      CREATE INDEX zamowienia_status_wlasny_klucz_ustawione ON zamowienia_status_wlasny (klucz, ustawione_at);
      CREATE INDEX automatyzacje_wykonania_regula_stan ON automatyzacje_wykonania (regula_id, stan, zakonczone_at);
      CREATE INDEX przesylki_utworzona_at ON przesylki (utworzona_at);
    `);
  },
};
