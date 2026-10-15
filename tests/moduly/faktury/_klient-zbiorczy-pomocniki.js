import { dopiszKlienta } from '../../../src/oms/db/klienci.js';

// Klient rozliczany zbiorczo dla testów — od 2026-08-24 mieszka w BAZIE, nie w konfiguracji.
//
// ⚠️ Do tej daty testy budowały go jako `config.klienciZbiorczy: [...]` i to wystarczało,
// bo `znajdzKlientaZbiorczego` czytało konfigurację. Teraz warunki umowy stoją na karcie
// klienta, więc test, który chce mieć klienta zbiorczego, musi go do bazy WSTAWIĆ —
// dokładnie tak, jak robi to operator na ekranie.

/** Warunki Zetaklientów: rabat 30%, próg 500 zł, obsługa 4 zł, kurier 19 zł. */
export const ZETAKLIENT = {
  klucz: 'zetaklient',
  nazwa: 'PHU Ewa Zieliński',
  nip: '1000001017',
  rabat_procent: 30,
  prog_darmowej_dostawy_gr: 50000,
  oplata_obslugi_gr: 400,
  oplata_kurierska_gr: 1900,
};

/**
 * Wstawia klienta rozliczanego zbiorczo i oddaje jego `id`.
 *
 * ⚠️ Przez `dopiszKlienta`, a nie własnym INSERT-em: własny SQL rozjechałby się z listą
 * kolumn przy pierwszej zmianie tabeli, a testy przestałyby sprawdzać to, co robi panel.
 */
export function dopiszKlientaZbiorczego(db, nadpisania = {}) {
  return dopiszKlienta(db, {
    ...ZETAKLIENT,
    rozliczenie_zbiorcze: 1,
    b2b: 0,
    chce_fakture: 0,
    metoda_wysylki: 'dpd',
    koszt_dostawy_brutto: '0.00',
    platnosc: 'przelew',
    termin_platnosci: null,
    komentarz: null,
    aktywny: 1,
    faktura: {},
    wysylka: {},
    ...nadpisania,
  });
}
