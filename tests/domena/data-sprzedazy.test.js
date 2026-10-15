import {
  describe, it, expect, afterEach,
} from 'vitest';
import { proponowanaDataSprzedazy } from '../../src/domena/data-sprzedazy.js';

// Nazwy pól i kwoty jak w platnosci-domena.test.js / kwota-oczekiwana-reczne.test.js — te
// same fixture'y, żeby test tej reguły nie wymyślał drugiego dialektu danych zamówienia.
const platnosc = (kwota, data) => ({
  kwota, data, zrodlo: 'reczna', utworzona_at: '2026-07-30T10:00:00Z',
});

describe('proponowana data sprzedaży — przedpłata przenosi obowiązek (art. 19a ust. 8)', () => {
  it('jedna wpłata na całość → podstawa „zaplata", data = data tej wpłaty', () => {
    const z = { kwota_brutto: '212.90', platnosci: [platnosc('212.90', '2026-07-30')] };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-01');
    expect(wynik.podstawa).toBe('zaplata');
    expect(wynik.data).toBe('2026-07-30');
    expect(wynik.wyjasnienie).toMatch(/zapłat/i);
  });

  // Sedno: nie ostatnia i nie pierwsza wpłata, tylko ta, która PRZEKROCZYŁA próg kwoty.
  it('dwie wpłaty → liczy się ta, która DOMKNĘŁA kwotę (środkowa z trzech)', () => {
    const z = {
      kwota_brutto: '212.90',
      platnosci: [
        platnosc('100.00', '2026-07-28'),
        platnosc('112.90', '2026-07-29'), // ta domyka próg 212.90
        platnosc('50.00', '2026-07-30'),
      ],
    };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-01');
    expect(wynik.podstawa).toBe('zaplata');
    expect(wynik.data).toBe('2026-07-29');
  });

  it('nadpłata też jest pokryciem kwoty → podstawa „zaplata"', () => {
    const z = { kwota_brutto: '212.90', platnosci: [platnosc('300.00', '2026-07-30')] };
    expect(proponowanaDataSprzedazy(z, '2026-08-01').podstawa).toBe('zaplata');
  });
});

describe('proponowana data sprzedaży — wydanie towaru (art. 19a ust. 1)', () => {
  it('pobranie: brak wpłat i brak wyslane_at → podstawa „wydanie", data = dziś (dzień wystawienia)', () => {
    const z = { kwota_brutto: '150.00', platnosci: [], wyslane_at: null };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-04');
    expect(wynik.podstawa).toBe('wydanie');
    expect(wynik.data).toBe('2026-08-04');
    expect(wynik.wyjasnienie).toMatch(/wydania towaru/);
  });

  it('pobranie z ustawionym wyslane_at → data z wyslane_at, nie z dziś', () => {
    const z = { kwota_brutto: '150.00', platnosci: [], wyslane_at: '2026-08-02T09:00:00Z' };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-04');
    expect(wynik.podstawa).toBe('wydanie');
    expect(wynik.data).toBe('2026-08-02');
  });

  // Obowiązek podatkowy z zapłaty powstaje TYLKO przy pełnym pokryciu — niedopłata wpada
  // w bezpieczne przybliżenie „wydanie" (Task 10 zostawia częściową zapłatę poza zakresem).
  it('niedopłata → podstawa „wydanie" mimo istniejącej (niepełnej) wpłaty', () => {
    const z = {
      kwota_brutto: '212.90',
      platnosci: [platnosc('100.00', '2026-07-30')],
      wyslane_at: '2026-08-01',
    };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-04');
    expect(wynik.podstawa).toBe('wydanie');
    expect(wynik.data).toBe('2026-08-01');
  });
});

// ⚠️ CAŁA TREŚĆ art. 19a ust. 8: zapłata przenosi obowiązek podatkowy TYLKO WTEDY, gdy
// otrzymano ją PRZED dokonaniem dostawy. Zwykły przelew po wysyłce (klient zapłacił
// z terminu, towar dawno pojechał) obowiązku nie przenosi — tam rządzi ust. 1 i dzień
// wydania towaru.
//
// Bez tego warunku faktura dostawała datę sprzedaży z INNEGO MIESIĄCA niż powstał obowiązek
// podatkowy, czyli lądowała w złym okresie JPK/VAT — a `wyjasnienie` cytowało przy tym
// przepis, który nie ma zastosowania, więc operator nie miał powodu daty poprawić.
describe('proponowana data sprzedaży — zapłata liczy się TYLKO przed dostawą', () => {
  it('wysyłka 30.07, zapłata dopiero 5.08 → wydanie, data 2026-07-30 (art. 19a ust. 1)', () => {
    const z = {
      kwota_brutto: '212.90',
      platnosci: [platnosc('212.90', '2026-08-05')],
      wyslane_at: '2026-07-30T09:00:00Z',
    };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-06');
    expect(wynik.podstawa).toBe('wydanie');
    expect(wynik.data).toBe('2026-07-30');
  });

  // Zdanie uzasadniające DATĘ musi cytować przepis, z którego ta data wynika. Cytat z ust. 8
  // pod datą wydania jest gorszy niż milczenie: uzasadnia błąd i zniechęca do poprawki.
  it('przy wydaniu wyjaśnienie NIE cytuje ust. 8 — cytuje ust. 1', () => {
    const z = {
      kwota_brutto: '212.90',
      platnosci: [platnosc('212.90', '2026-08-05')],
      wyslane_at: '2026-07-30T09:00:00Z',
    };
    const { wyjasnienie } = proponowanaDataSprzedazy(z, '2026-08-06');
    expect(wyjasnienie).toContain('art. 19a ust. 1');
    expect(wyjasnienie).not.toContain('ust. 8');
  });

  it('zapłata 28.07 PRZED wysyłką 30.07 → zaplata, data 2026-07-28 (art. 19a ust. 8)', () => {
    const z = {
      kwota_brutto: '212.90',
      platnosci: [platnosc('212.90', '2026-07-28')],
      wyslane_at: '2026-07-30T09:00:00Z',
    };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-06');
    expect(wynik.podstawa).toBe('zaplata');
    expect(wynik.data).toBe('2026-07-28');
  });

  // Zapłata TEGO SAMEGO DNIA co wydanie: obie interpretacje dają tę samą datę, więc
  // porównanie `<=` jest bezpieczne i najprostsze.
  it('zapłata tego samego dnia co wysyłka → zaplata (ta sama data w obie strony)', () => {
    const z = {
      kwota_brutto: '212.90',
      platnosci: [platnosc('212.90', '2026-07-30')],
      wyslane_at: '2026-07-30T09:00:00Z',
    };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-06');
    expect(wynik.podstawa).toBe('zaplata');
    expect(wynik.data).toBe('2026-07-30');
  });

  // Dostawy JESZCZE NIE BYŁO, więc każda zapłata jest zapłatą „przed dostawą".
  it('brak wyslane_at + pełna wpłata → zaplata', () => {
    const z = { kwota_brutto: '212.90', platnosci: [platnosc('212.90', '2026-08-05')], wyslane_at: null };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-06');
    expect(wynik.podstawa).toBe('zaplata');
    expect(wynik.data).toBe('2026-08-05');
  });

  // ⚠️ POBRANIE. Kurier inkasuje przy DORĘCZENIU, czyli po wydaniu towaru — odnotowana
  // wpłata z inkasa nie ma prawa przestawić daty sprzedaży na dzień inkasa.
  it('pobranie: wpłata z inkasa po wysyłce → data wydania, nie data inkasa', () => {
    const z = {
      kwota_brutto: '150.00',
      pobranie: 1,
      kwota_pobrania: '150.00',
      platnosci: [platnosc('150.00', '2026-08-03')],
      wyslane_at: '2026-08-01T06:00:00Z',
    };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-06');
    expect(wynik.podstawa).toBe('wydanie');
    expect(wynik.data).toBe('2026-08-01');
  });
});

describe('proponowana data sprzedaży — miarą jest kwotaOczekiwanaGrosze, nie kwota_brutto', () => {
  // Ta sama para pozycji, co w kwota-oczekiwana-reczne.test.js: 100 zł ze sklepu + 20 zł
  // dopisane ręcznie = 120 zł oczekiwane. Gdyby reguła liczyła próg od `kwota_brutto` (100 zł),
  // wpłata 100 zł od razu domykałaby kwotę i test poniżej fałszywie pokazałby „zaplata".
  const zamowienieZDopiskiem = (platnosci) => ({
    kwota_brutto: '100.00',
    koszt_dostawy_brutto: '0.00',
    pozycje: [
      {
        nazwa: 'A', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', zrodlo: 'sklep',
      },
      {
        nazwa: 'Dodatek', ilosc: 1, cena_brutto: '20.00', brutto_linii: '20.00', zrodlo: 'reczna',
      },
    ],
    platnosci,
    wyslane_at: '2026-08-01',
  });

  it('wpłata pokrywająca tylko kwotę sklepową (100) NIE domyka kwoty oczekiwanej (120) → wydanie', () => {
    const wynik = proponowanaDataSprzedazy(
      zamowienieZDopiskiem([platnosc('100.00', '2026-07-30')]),
      '2026-08-04',
    );
    expect(wynik.podstawa).toBe('wydanie');
    expect(wynik.data).toBe('2026-08-01');
  });

  it('wpłata pokrywająca pełną kwotę oczekiwaną (120) → zaplata', () => {
    const wynik = proponowanaDataSprzedazy(
      zamowienieZDopiskiem([platnosc('120.00', '2026-07-30')]),
      '2026-08-04',
    );
    expect(wynik.podstawa).toBe('zaplata');
    expect(wynik.data).toBe('2026-07-30');
  });
});

// ⚠️ `dzienWarszawa` na wartości, której nie umie odczytać, oddaje PUSTY STRING — i to jest
// świadome (patrz domain/format-daty.js: nigdy „Invalid Date" na ekranie). Gałąź „zapłata"
// musi to sprawdzić SAMA: bez tego wychodziło `{ data: '', podstawa: 'zaplata' }`, czyli
// zdanie z dziurą („zapłacono  — …") i domyślnie wybrany wariant „zapłacone" na karcie —
// jedyne miejsce, w którym panel twierdzi „obowiązek powstał w dniu zapłaty", nie wiedząc,
// którego dnia.
describe('proponowana data sprzedaży — nieczytelna data wpłaty spada do „wydanie"', () => {
  const wplataBezDaty = { kwota: '212.90', data: 'nie-data', zrodlo: 'reczna', utworzona_at: 'też nie' };

  it('nieparsowalna data wpłaty + wyslane_at → wydanie z dnia wysyłki, nie pusta data', () => {
    const z = { kwota_brutto: '212.90', platnosci: [wplataBezDaty], wyslane_at: '2026-08-01T09:00:00Z' };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-06');
    expect(wynik.podstawa).toBe('wydanie');
    expect(wynik.data).toBe('2026-08-01');
  });

  it('nieparsowalna data wpłaty bez wysyłki → wydanie z dnia dzisiejszego', () => {
    const z = { kwota_brutto: '212.90', platnosci: [wplataBezDaty], wyslane_at: null };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-06');
    expect(wynik.podstawa).toBe('wydanie');
    expect(wynik.data).toBe('2026-08-06');
  });

  // Zdanie z dziurą w miejscu daty jest gorsze niż milczenie: wygląda na uzasadnienie.
  it('wyjaśnienie NIE zostaje ze zdaniem z dziurą po dacie', () => {
    const z = { kwota_brutto: '212.90', platnosci: [wplataBezDaty], wyslane_at: null };
    const { wyjasnienie } = proponowanaDataSprzedazy(z, '2026-08-06');
    expect(wyjasnienie).not.toMatch(/zapłacono\s+—/);
    expect(wyjasnienie).toContain('art. 19a ust. 1');
  });
});

describe('proponowana data sprzedaży — kwota uszkodzona nie może wywalić karty', () => {
  it('kwota_brutto nieliczbowa → funkcja NIE RZUCA, oddaje „wydanie"', () => {
    const z = { kwota_brutto: 'abc', platnosci: [], wyslane_at: null };
    expect(() => proponowanaDataSprzedazy(z, '2026-08-04')).not.toThrow();
    const wynik = proponowanaDataSprzedazy(z, '2026-08-04');
    expect(wynik.podstawa).toBe('wydanie');
    expect(wynik.data).toBe('2026-08-04');
  });

  it('zamówienie zupełnie puste → też nie rzuca', () => {
    expect(() => proponowanaDataSprzedazy({}, '2026-08-04')).not.toThrow();
    expect(proponowanaDataSprzedazy({}, '2026-08-04').podstawa).toBe('wydanie');
  });
});

// ⚠️ PUŁAPKA Z HISTORII TEGO REPO: kontener chodzi z TZ=UTC. Gołe `new Date().getDate()`
// (czy odpowiedniki) między północą a drugą w nocy oddaje DZIEŃ POPRZEDNI. Test musi
// przechodzić NIEZALEŻNIE od strefy maszyny — stąd przestawianie `process.env.TZ` w locie
// (Node czyta tę zmienną na bieżąco, bez restartu procesu).
describe('proponowana data sprzedaży — dzień warszawski, nigdy UTC ani lokalny zegar maszyny', () => {
  const oryginalnyTZ = process.env.TZ;
  afterEach(() => { process.env.TZ = oryginalnyTZ; });

  it.each(['UTC', 'Europe/Warsaw', 'Pacific/Kiritimati'])(
    'wpłata o 2026-08-04T00:30:00Z → dzień warszawski 2026-08-04, niezależnie od TZ=%s',
    (tz) => {
      process.env.TZ = tz;
      const z = { kwota_brutto: '100.00', platnosci: [platnosc('100.00', '2026-08-04T00:30:00Z')] };
      const wynik = proponowanaDataSprzedazy(z, '2026-08-04');
      expect(wynik.podstawa).toBe('zaplata');
      expect(wynik.data).toBe('2026-08-04');
    },
  );

  // Prawdziwe przejście przez północ: 23:15 UTC to w Warszawie (czas letni, +2) już 01:15
  // NASTĘPNEGO dnia. To jest przypadek, na którym naiwna arytmetyka (albo lokalny zegar
  // maszyny) faktycznie by się pomyliła — w każdą stronę.
  it.each(['UTC', 'Europe/Warsaw', 'Pacific/Kiritimati'])(
    'wpłata o 2026-07-31T23:15:00Z → dzień warszawski 2026-08-01 (przejście przez północ), TZ=%s',
    (tz) => {
      process.env.TZ = tz;
      const z = { kwota_brutto: '100.00', platnosci: [platnosc('100.00', '2026-07-31T23:15:00Z')] };
      const wynik = proponowanaDataSprzedazy(z, '2026-08-04');
      expect(wynik.podstawa).toBe('zaplata');
      expect(wynik.data).toBe('2026-08-01');
    },
  );

  // ⚠️ TA SAMA PUŁAPKA W DRUGIEJ GAŁĘZI TEJ SAMEJ FUNKCJI. `wyslane_at` to NASZ znacznik,
  // zapisywany w UTC (kontener chodzi z TZ=UTC), więc dzień MUSI wyjść z przeliczenia na
  // Warszawę, a nie z `slice(0, 10)` po napisie: 23:40 UTC to w Warszawie (czas letni, +2)
  // już 01:40 NASTĘPNEGO dnia, i to jest data sprzedaży na fakturze — 31 lipca wpada
  // w INNY MIESIĄC JPK/VAT niż 1 sierpnia. Dokładnie ten błąd wyszedł już przy proformie.
  //
  // ⚠️ Zamówienie tu jest BEZ WPŁAT celowo: przy pełnym pokryciu rządziłaby gałąź „zapłata"
  // i test sprawdzałby drugi raz to, co wyżej.
  it.each(['UTC', 'Europe/Warsaw', 'Pacific/Kiritimati'])(
    'wysyłka o 2026-07-31T23:40:00Z → dzień wydania 2026-08-01 (przejście przez północ), TZ=%s',
    (tz) => {
      process.env.TZ = tz;
      const z = { kwota_brutto: '100.00', platnosci: [], wyslane_at: '2026-07-31T23:40:00Z' };
      const wynik = proponowanaDataSprzedazy(z, '2026-08-04');
      expect(wynik.podstawa).toBe('wydanie');
      expect(wynik.data).toBe('2026-08-01');
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// INKASO KURIERA NIE JEST PRZEDPŁATĄ (31.08.2026)
//
// ⚠️⚠️ POWÓD ISTNIENIA: sklep PRO przy oznaczaniu zamówienia jako zrealizowane zapisuje
// `date_paid`, a poller czyta to jako WPŁATĘ o źródle `sklep` i metodzie „Za pobraniem".
// Zmierzone na produkcji 31.08.2026 (zamówienie 1259): panel proponował datę sprzedaży
// ze zdaniem „zapłacono 31.08 — obowiązek podatkowy powstał w dniu zapłaty (art. 19a
// ust. 8)", podczas gdy paczka była W DRODZE, a `left_to_pay` na fakturze wynosiło 99,90.
//
// Art. 19a ust. 8 wymaga zapłaty PRZED dostawą. Przy pobraniu kurier inkasuje przy
// doręczeniu — czyli NIGDY przed. Wpłata pobraniowa nie ma więc prawa uruchamiać tej
// gałęzi ANI JEDEN RAZ, niezależnie od tego, jaką datę nosi.
describe('proponowana data sprzedaży — inkaso kuriera to nie zapłata przed dostawą', () => {
  const pobranieZeSklepu = (kwota, data) => ({
    kwota, data, zrodlo: 'sklep', metoda: 'Za pobraniem', utworzona_at: data,
  });

  it('wpłata „Za pobraniem" w dniu wysyłki → podstawa „wydanie", nie „zaplata"', () => {
    const z = {
      kwota_brutto: '99.90',
      pobranie: 1,
      wyslane_at: '2026-08-31T11:09:31.149Z',
      platnosci: [pobranieZeSklepu('99.90', '2026-08-31T11:09:33Z')],
    };
    const wynik = proponowanaDataSprzedazy(z, '2026-08-31');
    expect(wynik.podstawa).toBe('wydanie');
    expect(wynik.data).toBe('2026-08-31');
    expect(wynik.wyjasnienie).toMatch(/19a ust\. 1/);
    // Zdanie nie ma prawa twierdzić, że ktokolwiek zapłacił.
    expect(wynik.wyjasnienie).not.toMatch(/zapłacono/i);
  });

  // ⚠️ TO JEST TEN PRZYPADEK, KTÓRY KOSZTUJE. Przy odroczonej wysyłce sklep potrafi
  // oznaczyć zamówienie jako opłacone WCZEŚNIEJ niż paczka wyjedzie. Stara reguła brała
  // wtedy dzień fałszywej wpłaty — czyli datę sprzedaży z POPRZEDNIEGO MIESIĄCA i VAT
  // w złym okresie JPK.
  it('fałszywa wpłata pobraniowa z 31.08 przy wysyłce 1.09 → data sprzedaży 1.09', () => {
    const z = {
      kwota_brutto: '99.90',
      pobranie: 1,
      wyslane_at: '2026-09-01T09:00:00Z',
      platnosci: [pobranieZeSklepu('99.90', '2026-08-31T11:09:33Z')],
    };
    const wynik = proponowanaDataSprzedazy(z, '2026-09-01');
    expect(wynik.data).toBe('2026-09-01');
    expect(wynik.podstawa).toBe('wydanie');
  });

  // ⚠️ BRAMKA MA BYĆ WĄSKA. Klient, który przy zamówieniu za pobraniem naprawdę przelał
  // pieniądze przed wysyłką (zmiana zdania, dopłata), dalej podlega art. 19a ust. 8 —
  // odsiewamy INKASO, a nie każdą wpłatę przy zamówieniu z pobraniem.
  it('prawdziwy przelew przed wysyłką na zamówieniu z pobraniem → dalej „zaplata"', () => {
    const z = {
      kwota_brutto: '99.90',
      pobranie: 1,
      wyslane_at: '2026-09-01T09:00:00Z',
      platnosci: [{ kwota: '99.90', data: '2026-08-28', zrodlo: 'reczna', metoda: 'Przelew' }],
    };
    const wynik = proponowanaDataSprzedazy(z, '2026-09-01');
    expect(wynik.podstawa).toBe('zaplata');
    expect(wynik.data).toBe('2026-08-28');
  });

  // Częściowe pokrycie prawdziwym przelewem + reszta z inkasa: próg NIE jest domknięty
  // przed dostawą, więc obowiązek powstaje z wydania.
  it('przelew 40 zł + inkaso 59,90 zł → próg niedomknięty przedpłatą, podstawa „wydanie"', () => {
    const z = {
      kwota_brutto: '99.90',
      pobranie: 1,
      wyslane_at: '2026-09-01T09:00:00Z',
      platnosci: [
        { kwota: '40.00', data: '2026-08-28', zrodlo: 'reczna', metoda: 'Przelew' },
        pobranieZeSklepu('59.90', '2026-09-01T09:00:02Z'),
      ],
    };
    const wynik = proponowanaDataSprzedazy(z, '2026-09-01');
    expect(wynik.podstawa).toBe('wydanie');
    expect(wynik.data).toBe('2026-09-01');
  });
});
