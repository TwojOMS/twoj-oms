import { describe, it, expect, beforeEach } from 'vitest';

import { openOmsDb } from '../../../src/oms/db/db.ts';
import { dopiszKlienta, klientPoNip } from '../../../src/oms/db/klienci.js';
import { znormalizujKlienta } from '../../../src/domena/klient-staly.js';
import { normalizujNip } from '../../../src/domena/klient-zbiorczy.js';
import { nipDoZapytania } from '../../../src/domena/gus.js';

// NUMER VAT-UE NA KARCIE STAŁEGO KLIENTA (26.08.2026, zgłoszenie właściciela: słowackiego
// klienta Alfatrend „nie da się wpisać do karty stałych klientów ani założyć mu zamówienia
// okresowego").
//
// Zmierzone przyczyny były DWIE i żadna nie krzyczała:
//
//  1. `body.nip ?? faktura.nip` — `??` łapie wyłącznie `null`/`undefined`, a formularz
//     zawsze wysyła pole `nip`, więc PUSTY napis wygrywał z wypełnionym „NIP na fakturze".
//     Karta zapisywała się BEZ NIP-u, a bez niego panel nie wskaże nabywcy faktury
//     okresowej (web/routes/okresy.js) — stąd „nie da się założyć zamówienia okresowego".
//
//  2. `normalizujNip` kasowała wszystko, co nie jest cyfrą, więc „SK1000000001" zapisywało
//     się jako „1000000001" — dziesięć cyfr, czyli numer WYGLĄDAJĄCY NA POLSKI NIP.
//     To gorsze niż odmowa: taki numer poszedłby na fakturę i nikt by się nie zorientował.
//
// ⚠️ ZGODNOŚĆ WSTECZ JEST CZĘŚCIĄ REGUŁY, nie miłym dodatkiem. Kolumna `nip` w całej bazie
// trzyma SAME CYFRY, a dopasowanie zamówienia do karty i do okresu idzie przez porównanie
// znormalizowanych numerów. Gdyby normalizacja zmieniła wynik dla numeru POLSKIEGO, panel
// z dnia na dzień przestałby rozpoznawać wszystkich dotychczasowych klientów — po cichu,
// bo „brak dopasowania" wygląda tak samo jak „klient jeszcze nic nie zamówił".

const ALFATREND = 'SK1000000001';

describe('numer VAT-UE na karcie stałego klienta', () => {
  it('zapisuje słowacki numer z prefiksem kraju, zamiast obcinać go do samych cyfr', () => {
    const wynik = znormalizujKlienta({ nazwa: 'Alfatrend', nip: ALFATREND });

    // ⚠️ Gdyby tu stało '1000000001', panel wystawiłby fakturę na numer, który wygląda
    // na polski NIP i nim NIE JEST — a to jest błąd widoczny dopiero u księgowej.
    expect(wynik.nip).toBe(ALFATREND);
    expect(wynik.faktura.nip).toBe(ALFATREND);
  });

  it('przejmuje numer z pola „NIP na fakturze", gdy pole „NIP" zostało puste', () => {
    // Tak wygląda formularz po kliknięciu „Pobierz z GUS": przycisk czyta `f_nip`, więc
    // człowiek wpisuje numer WŁAŚNIE TAM i pole `nip` wyżej zostaje puste.
    const wynik = znormalizujKlienta({ nazwa: 'Alfatrend', nip: '', f_nip: ALFATREND });

    expect(wynik.nip).toBe(ALFATREND);
    expect(wynik.faktura.nip).toBe(ALFATREND);
  });

  it('odmawia głośno, gdy numeru nie da się rozpoznać, zamiast zapisać jego kawałek', () => {
    // „XY" nie jest kodem kraju z Unii. Stara reguła zrobiłaby z tego „123456" i zapisała
    // bez słowa — czyli klienta z numerem, którego nikt nie wpisał.
    expect(() => znormalizujKlienta({ nazwa: 'Alfatrend', nip: 'XY123456' }))
      .toThrow(/nie wygląda ani na polski NIP, ani na numer VAT-UE/);
  });
});

describe('normalizacja numeru — zgodność wstecz dla numerów polskich', () => {
  it('nie zmienia niczego dla numerów, które już leżą w bazie', () => {
    expect(normalizujNip('6762432557')).toBe('6762432557');
    expect(normalizujNip('676-24-32-557')).toBe('6762432557');
    expect(normalizujNip(' 676 243 25 57 ')).toBe('6762432557');
  });

  it('sprowadza polski numer z prefiksem „PL" do samych cyfr', () => {
    // ⚠️ PL JEST WYJĄTKIEM WŚRÓD KODÓW KRAJU i musi nim zostać: cała dotychczasowa baza
    // trzyma polskie numery bez prefiksu, więc zachowanie „PL" rozjechałoby dopasowanie.
    expect(normalizujNip('PL6762432557')).toBe('6762432557');
    expect(normalizujNip('pl6762432557')).toBe('6762432557');
  });

  it('zachowuje kod kraju przy numerze z innego państwa Unii', () => {
    expect(normalizujNip('SK1000000001')).toBe('SK1000000001');
    expect(normalizujNip('sk 1000000001')).toBe('SK1000000001');
    expect(normalizujNip('CZ-10000006')).toBe('CZ10000006');
    expect(normalizujNip('DE100000003')).toBe('DE100000003');
  });

  it('nie robi kodu kraju ze śmieci w polu NIP', () => {
    // W archiwum zamówień to pole bywa wypełnione ręcznie i bywa w nim wszystko.
    expect(normalizujNip('brak')).toBe('');
    expect(normalizujNip('nie dotyczy')).toBe('');
    expect(normalizujNip('NIP 6762432557')).toBe('6762432557');
    expect(normalizujNip('')).toBe('');
    expect(normalizujNip(null)).toBe('');
    // Sam kod kraju bez numeru to nie jest numer.
    expect(normalizujNip('SK')).toBe('');
  });
});

describe('dopasowanie klienta z numerem VAT-UE', () => {
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  it('znajduje kartę po numerze wpisanym w dowolnym zapisie', () => {
    // To jest trasa, po której zamówienie trafia do okresu (services/okres.js) i po której
    // karta pokazuje historię (db/zamowienia.js) — bez niej „zamówienie okresowe" nie ma
    // do czego przylgnąć.
    dopiszKlienta(db, {
      klucz: 'alfatrend', nazwa: 'Alfatrend s.r.o.', nip: ALFATREND, b2b: 1,
      rabat_procent: 0, chce_fakture: 1, metoda_wysylki: 'dpd', aktywny: 1,
      koszt_dostawy_brutto: '0.00', platnosc: 'przelew', termin_platnosci: null,
      komentarz: null,
    });

    expect(klientPoNip(db, 'SK1000000001')?.klucz).toBe('alfatrend');
    expect(klientPoNip(db, 'sk 1000000001')?.klucz).toBe('alfatrend');
    // ⚠️ Same cyfry NIE MAJĄ dopasować się do numeru słowackiego: „1000000001" to zupełnie
    // inny podmiot (albo polski NIP kogoś trzeciego), a ciche zlanie obu w jedno
    // podstawiłoby na fakturę nabywcę, którego nikt nie wskazał.
    expect(klientPoNip(db, '1000000001')).toBeFalsy();
  });
});

describe('przycisk „Pobierz z GUS" wobec numeru zagranicznego', () => {
  it('mówi, że GUS zna wyłącznie polskie podmioty, zamiast zmyślać literówkę', () => {
    // Stary komunikat brzmiał „ma błędną sumę kontrolną — sprawdź, czy nie ma literówki".
    // Numer był poprawny; człowiek szukał literówki, której nie ma.
    expect(() => nipDoZapytania(ALFATREND)).toThrow(/GUS/);
    expect(() => nipDoZapytania(ALFATREND)).not.toThrow(/literówki/);
  });

  it('dalej sprawdza sumę kontrolną polskiego NIP-u', () => {
    expect(() => nipDoZapytania('6762432558')).toThrow(/sumę kontrolną/);
    expect(nipDoZapytania('PL6762432557')).toBe('6762432557');
  });
});
