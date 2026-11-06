import { STAWKI_VAT } from './vat.js';
import { poprawnyEan } from './ean.js';

const POLA = new Set([
  'nazwa', 'opis', 'sku', 'ean', 'cena_gr', 'stawka_vat', 'kategoria',
  'wymiary', 'waga_g', 'wycofana',
]);
const WYMIARY = ['szerokosc_mm', 'wysokosc_mm', 'glebokosc_mm'];
const obiekt = (wartosc) => wartosc !== null && typeof wartosc === 'object' && !Array.isArray(wartosc);
const dlugosc = (tekst) => [...tekst].length;
const nieujemnaCalkowita = (wartosc) => Number.isSafeInteger(wartosc) && wartosc >= 0;
const blad = (pole, powod, kod = 'walidacja') => ({ ok: false, kod, powod, pole });

/**
 * Sprawdza komplet wymiarów stanu docelowego; typy wcześniej sprawdza parser.
 * Jak na ekranie (PRZ-090): szerokość i wysokość razem albo żadna; głębokość opcjonalna (produkt płaski),
 * ale nie sama.
 */
export function wymiaryKompletne(karta) {
  const [szerokosc, wysokosc, glebokosc] = WYMIARY.map((pole) => karta[pole] != null);
  return szerokosc === wysokosc && (szerokosc || !glebokosc);
}

/** Czysta walidacja wejścia API i mapowanie na kolumny karty, bez uzupełniania brakujących pól. */
export function parsujKarteZApi(cialo, { czesciowa = false } = {}) {
  if (!obiekt(cialo)) return blad('cialo', 'Ciało żądania musi być obiektem.');
  for (const pole of Object.keys(cialo)) {
    if (!POLA.has(pole)) return blad(pole, `Nieznane pole „${pole}”.`, 'pole');
  }
  if (!czesciowa && !Object.hasOwn(cialo, 'nazwa')) return blad('nazwa', 'Nazwa jest wymagana.');

  const karta = {};
  for (const [pole, wartosc] of Object.entries(cialo)) {
    if (pole === 'wymiary') {
      if (wartosc === null) {
        for (const wymiar of WYMIARY) karta[wymiar] = null;
        continue;
      }
      if (!obiekt(wartosc)) return blad(pole, 'Wymiary muszą być obiektem lub null.');
      for (const wymiar of Object.keys(wartosc)) {
        if (!WYMIARY.includes(wymiar)) return blad(`wymiary.${wymiar}`, `Nieznane pole wymiarów „${wymiar}”.`, 'pole');
      }
      for (const [wymiar, liczba] of Object.entries(wartosc)) {
        if (liczba !== null && !nieujemnaCalkowita(liczba)) {
          return blad(`wymiary.${wymiar}`, 'Wymiar musi być nieujemną liczbą całkowitą lub null.');
        }
        karta[wymiar] = liczba;
      }
      continue;
    }

    const kolumna = pole === 'kategoria' ? 'kategoria_glowna' : pole;
    // „wycofana” ma w bazie NOT NULL DEFAULT 0 — null to błąd wejścia, nie czyszczenie.
    if (wartosc === null && pole !== 'nazwa' && pole !== 'wycofana') {
      karta[kolumna] = null;
      continue;
    }

    let wynik = wartosc;
    switch (pole) {
      case 'nazwa':
      case 'sku': {
        const limit = pole === 'nazwa' ? 300 : 64;
        if (typeof wartosc !== 'string' || dlugosc(wartosc.trim()) < 1 || dlugosc(wartosc.trim()) > limit) {
          return blad(pole, `Pole „${pole}” musi zawierać od 1 do ${limit} znaków po usunięciu białych znaków z końców.`);
        }
        wynik = wartosc.trim();
        break;
      }
      case 'opis':
        if (typeof wartosc !== 'string' || dlugosc(wartosc) > 20000) {
          return blad(pole, 'Pole „opis” musi być tekstem o długości najwyżej 20000 znaków.');
        }
        break;
      case 'kategoria':
        // Panel trzyma kategorię jako NULLIF(TRIM(...)): białe znaki z końców obcięte, pusta = brak kategorii.
        if (typeof wartosc !== 'string' || dlugosc(wartosc.trim()) > 200) {
          return blad(pole, 'Pole „kategoria” musi być tekstem o długości najwyżej 200 znaków.');
        }
        wynik = wartosc.trim() || null;
        break;
      case 'ean':
        if (!poprawnyEan(wartosc)) return blad(pole, 'EAN musi być napisem z 8 lub 13 cyframi i poprawną cyfrą kontrolną GTIN.');
        break;
      case 'cena_gr':
      case 'waga_g':
        if (!nieujemnaCalkowita(wartosc)) return blad(pole, `Pole „${pole}” musi być nieujemną liczbą całkowitą.`);
        break;
      case 'stawka_vat':
        if (!STAWKI_VAT.includes(wartosc)) return blad(pole, 'Stawka VAT musi należeć do listy dozwolonych stawek.');
        break;
      case 'wycofana':
        if (typeof wartosc !== 'boolean') return blad(pole, 'Pole „wycofana” musi być wartością logiczną.');
        wynik = wartosc ? 1 : 0;
        break;
    }
    karta[kolumna] = wynik;
  }
  return { ok: true, karta };
}
