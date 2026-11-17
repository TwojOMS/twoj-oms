import type { Migracja } from '../../../core/kontrakty.ts';

// Filtr faktury na liście zamówień czyta z indeksu dwie odpowiedzi reguł domeny
// (domena/filtry-listy.js → `kluczeFiltrow`): czy klient chce fakturę i czy dokument jest wystawiony.
//
// ⚠️ Wiersze sprzed migracji mają w obu kolumnach NULL. Nie liczymy ich tutaj: migracja nie zna
// reguł domeny, a przeliczenie całej tabeli przed startem wstrzymałoby panel. Sprawdzenie indeksu
// w tle po starcie procesu (oms/db/indeks-listy.js, droga 3) przelicza każdy wiersz, a lista
// pokazuje jego postęp — przez te kilkanaście sekund filtr faktury może nie widzieć części
// starszych zamówień.
export const migracjaIndeksuListyFaktura: Migracja = {
  numer: 4,
  nazwa: 'indeks listy: życzenie faktury i faktura wystawiona',
  wykonaj(db) {
    db.exec(`
      ALTER TABLE lista_stan ADD COLUMN chce_fakture INTEGER;
      ALTER TABLE lista_stan ADD COLUMN faktura_wystawiona INTEGER;
    `);
  },
};
