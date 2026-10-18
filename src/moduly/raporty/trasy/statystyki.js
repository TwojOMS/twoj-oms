import { zakresZZapytania, nazwaOkresu, nazwaSkrotu } from '../../../domena/okresy-raportu.js';
import { zamowieniaOkresu, pierwszyDzienZamowien } from '../../../domena/statystyki-okresu.js';
import { rozkladUslug, terminowosc } from '../../../domena/statystyki-wysylki.js';
import { rozkladMetod } from '../../../domena/statystyki-platnosci.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';

// Zakladka STATYSTYKI — wysylka i platnosci. Trasa jest CIENKA: parsuje zakres, wola domene,
// renderuje. Wzorzec: routes/raporty.js.
//
// ⚠️ TEN MODUL NICZEGO NIE LICZY. Mianownik sklada `zamowieniaOkresu`, rozklad uslug
// i terminowosc `statystyki-wysylki.js`, metody platnosci `statystyki-platnosci.js`,
// zakresy `okresy-raportu.js`. Druga sciezka liczaca to samo rozjechalaby sie przy
// pierwszej zmianie reguly.

// ⚠️ PIERWSZY DZIEN OMS-U. Zamowienia z przewoznikiem, metoda platnosci i data wyslania
// zaczynaja sie 3.07.2026; historia (10 878 wierszy w `sprzedaz_historyczna`) niesie
// wylacznie dzien, kwote, status i flage faktury. Zakres wychodzacy przed te date dostaje
// pasek zastrzezenia — inaczej „Ten rok" pokazywalby 226 zamowien i wygladalo to jak awaria.
// Początek pokrycia danych otrzymujemy z konfiguracji, a bez niej — z pierwszego zamówienia w bazie.

const SKROTY = [
  'dzisiaj', 'ten-miesiac', 'poprzedni-miesiac', 'ten-kwartal', 'poprzedni-kwartal',
  'ten-rok', 'poprzedni-rok', 'ostatnie-30',
];

// ⚠️ CZAS WARSZAWSKI, nie UTC — ta sama funkcja, co przy /raporty. Pierwszego dnia miesiaca
// o 01:30 czasu polskiego `new Date().toISOString()` pokazuje jeszcze miesiac POPRZEDNI.
const dzisiaj = () => dzienWarszawa(new Date().toISOString());

export function zarejestrujTrasyStatystyk(app, { db, config }) {
  app.get('/statystyki', async (req, reply) => {
    const dzien = dzisiaj();
    const { zakres, blad } = zakresZZapytania(req.query ?? {}, dzien);
    const skroty = SKROTY.map((klucz) => ({ klucz, etykieta: nazwaSkrotu(klucz, dzien) }));
    if (blad) {
      return reply.view('statystyki.ejs', {
        blad, zakres: null, skroty,
        uslugi: null, termin: null, platnosci: null, przedOmsem: false,
      });
    }
    const zamowienia = zamowieniaOkresu(db, zakres, config.regulySprzedazy);
    // PRZ-093.07: bez OMS_STATYSTYKI_PIERWSZY_DZIEN początkiem danych jest dzień pierwszego
    // zamówienia w bazie (env wygrywa). Liczony przy każdym wejściu — zamówienia przybywają.
    const pierwszyZBazy = config.pierwszyDzienOms ? null : pierwszyDzienZamowien(db);
    const pierwszyDzien = config.pierwszyDzienOms ?? pierwszyZBazy;
    return reply.view('statystyki.ejs', {
      blad: null,
      zakres,
      nazwa: nazwaOkresu(zakres),
      skroty,
      uslugi: rozkladUslug(zamowienia),
      termin: terminowosc(zamowienia),
      platnosci: rozkladMetod(zamowienia),
      // Pasek zastrzezenia zalezy WYLACZNIE od zakresu, nie od tego, czy cos znaleziono:
      // pusty styczen ma ten sam powod pustki, co styczen z jednym zamowieniem.
      przedOmsem: !pierwszyDzien || zakres.od < pierwszyDzien,
      pierwszyDzien,
      pierwszyDzienZBazy: pierwszyZBazy !== null,
    });
  });
}
