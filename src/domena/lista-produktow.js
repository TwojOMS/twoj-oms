import { czyPozycjaPlaceholdera } from './indywidualne.js';
import { czyPozycjaNieTowar } from './pozycje-niesprzedazowe.js';

// „Lista produktów" (PRZ-074) — kartka do kompletowania paczki: SAME produkty z iloscia.
// Bez danych klienta, bez cen, bez kwot i bez wysylki. Ten modul celowo NIE ZNA zadnej kwoty:
// wiersz wynikowy ma trzy pola, wiec widok nie ma skad wydrukowac ceny nawet przez pomylke.
//
// Pozycje wchodza tu JUZ EFEKTYWNE — nadpisania reczne i pozycje dopisane na karcie naklada
// warstwa odczytu (`zLinii` w db/zamowienia.js), dokladnie jak dla tabeli pozycji karty
// (domain/tabela-pozycji.js) i specyfikacji (domain/specyfikacja.js). Lista pakowania i karta
// widza wiec te same ilosci.
//
// Wysylka z kolumny zamowienia nie jest pozycja, wiec nie trafia tu wcale (specyfikacja
// trzyma ja osobno, w `dostawaZl`). Wysylke i usluge priorytetowa PRZEBRANE ZA POZYCJE
// (zamowienia z oferty panelu indywidualnego) odcina ta sama regula, ktora trzyma je poza
// rankingiem produktow — `czyPozycjaNieTowar`. Tego sie nie pakuje.

/**
 * @param {object} z - zamowienie (wiersz `zLinii`, z nalozonymi nadpisaniami)
 * @returns {{ numer: string, pozycje: { ilosc: number, nazwa: string, sku: string | null }[] }}
 */
export function listaProduktow(z) {
  const pozycje = (z?.pozycje ?? [])
    .filter((p) => !czyPozycjaNieTowar(p?.nazwa))
    .map((p) => ({
      ilosc: Number(p?.ilosc ?? 0),
      nazwa: String(p?.nazwa ?? ''),
      // SKU zaslepki wtyczki to identyfikator ukrytego produktu technicznego, nie symbol
      // karty — ta sama zasada, co na karcie i na specyfikacji.
      sku: czyPozycjaPlaceholdera(p?.sku) ? null : (p?.sku || null),
    }));
  return { numer: String(z?.numer ?? ''), pozycje };
}

// Klucz scalania wierszy listy zbiorczej: SKU, gdy jest; inaczej DOKLADNA nazwa (po trim).
// ⚠️ Przedrostki `s:`/`n:` rozdzielaja przestrzenie — nazwa „KLOSZ-70" bez SKU nie ma prawa
// wpasc do wiersza produktu z SKU „KLOSZ-70". Nazwy nie normalizujemy dalej (wielkosc liter,
// rozmiar w nazwie): „Abażur 80cm" i „Abażur 80 cm" moga byc dwoma roznymi kartami, a scalenie
// dwoch roznych kart konczy sie paczka bez jednego z nich. Dwa wiersze zamiast jednego
// kosztuja operatora tylko spojrzenie.
const kluczScalania = (p) => (p.sku ? `s:${p.sku.trim()}` : `n:${p.nazwa.trim()}`);

/**
 * „Lista produktów" ZBIORCZA (PRZ-084) — jedna kartka do kompletowania kilku zamowien naraz.
 * Ta sama regula pozycji co `listaProduktow` (bez wysylki, bez SKU zaslepki), wiec lista
 * zbiorcza i lista jednego zamowienia nie moga sie rozjechac. Bez kwot i bez danych klienta:
 * numer zamowienia to jedyny identyfikator, jaki tu stoi.
 *
 * Wiersz niesie, w ktorych zamowieniach siedzi produkt i po ile sztuk (`zamowienia`) — po
 * skompletowaniu operator rozdziela towar do paczek. Kolejnosc wierszy: po nazwie (polski
 * porzadek), zeby przy polce isc po kolei; zamowienia w wierszu — w kolejnosci zaznaczenia.
 *
 * @param {object[]} zamowienia - wiersze `zLinii`, w kolejnosci listy
 */
export function listaProduktowZbiorcza(zamowienia) {
  const lista = Array.isArray(zamowienia) ? zamowienia : [];
  const wiersze = new Map();
  for (const z of lista) {
    const { numer, pozycje } = listaProduktow(z);
    for (const p of pozycje) {
      const klucz = kluczScalania(p);
      let w = wiersze.get(klucz);
      if (!w) {
        w = { ilosc: 0, nazwa: p.nazwa, sku: p.sku, zamowienia: [] };
        wiersze.set(klucz, w);
      }
      w.ilosc += p.ilosc;
      // Ten sam produkt dwa razy w jednym zamowieniu (dwie linie, np. pozycja dopisana na
      // karcie) to JEDEN wpis „numer ×3", nie dwa wpisy tego samego numeru.
      const wpis = w.zamowienia.find((x) => x.numer === numer);
      if (wpis) wpis.ilosc += p.ilosc;
      else w.zamowienia.push({ numer, ilosc: p.ilosc });
    }
  }
  const posortowane = [...wiersze.values()].sort((a, b) => a.nazwa.localeCompare(b.nazwa, 'pl')
    || String(a.sku ?? '').localeCompare(String(b.sku ?? ''), 'pl'));
  return {
    numery: lista.map((z) => String(z?.numer ?? '')),
    wiersze: posortowane,
    razemPozycji: posortowane.length,
    razemSztuk: posortowane.reduce((s, w) => s + w.ilosc, 0),
  };
}
