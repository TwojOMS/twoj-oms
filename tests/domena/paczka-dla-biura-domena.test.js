import { describe, it, expect } from 'vitest';
import { zlozPaczke, porownajNumery } from '../../src/domena/paczka-dla-biura.js';

const f = (n = {}) => ({
  uuid: 'u', id: 10, number: '5/08/2026', rodzaj: 'vat', kind: 'vat', invoice_date: '2026-08-05', sale_date: '2026-08-05',
  net_price: 10000, tax_price: 2300, gross_price: 12300, currency: 'PLN',
  client_company_name: 'Firma', client_tax_code: '1234563218', ksef_number: 'KS-1', ...n,
});
const k = (n = {}) => ({
  ksef_number: 'K-1', numer_dokumentu: 'FV/1', sprzedawca_nazwa: 'OVH', sprzedawca_nip: '1', data_wystawienia: '2026-08-04',
  data_trwalego_zapisu: '2026-08-04T10:00:00Z', dzien_otrzymania: '2026-08-04', netto: '100.00', vat: '23.00', brutto: '123.00',
  waluta: 'PLN', rodzaj: 'Vat', zrodlo: 'ksef', sciezka_pdf: null, ...n,
});

describe('sprzedaz', () => {
  it('faktura wystawiona 2.09 za sprzedaz 31.08 wchodzi do sierpnia z flaga', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [f({ number: '6/09/2026', invoice_date: '2026-09-02', sale_date: '2026-08-31' })], korekty: [], koszty: [], kwarantanna: 0 });
    expect(p.sprzedaz).toHaveLength(1);
    expect(p.sprzedaz[0].uwagi).toContain('wystawiona 02.09.2026');
  });
  it('faktura z data sprzedazy w miesiacu i wystawienia w miesiacu — bez flagi', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [f()], korekty: [], koszty: [], kwarantanna: 0 });
    expect(p.sprzedaz[0].uwagi).toEqual([]);
  });
  // Druga strona tej samej granicy: sprzedaz w miesiacu paczki, ale faktura wystawiona
  // JESZCZE W POPRZEDNIM (zaliczka, faktura wystawiona z wyprzedzeniem — art. 106i ust. 7
  // ustawy o VAT). Flaga ma dzialac w obie strony, nie tylko dla faktur „spoznionych".
  it('faktura wystawiona 31.07 za sprzedaz 03.08 tez dostaje flage', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [f({ invoice_date: '2026-07-31', sale_date: '2026-08-03' })], korekty: [], koszty: [], kwarantanna: 0 });
    expect(p.sprzedaz[0].uwagi).toContain('wystawiona 31.07.2026');
  });
  it('bez numeru KSeF dostaje uwage „bez KSeF"', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [f({ ksef_number: null })], korekty: [], koszty: [], kwarantanna: 0 });
    expect(p.sprzedaz[0].uwagi).toContain('bez KSeF');
  });
  it('korekta: „korekta do <numer>" gdy pierwotna w paczce, inaczej id', () => {
    const p = zlozPaczke({
      miesiac: '2026-08', faktury: [f({ id: 10, number: '5/08/2026' })],
      korekty: [
        f({ uuid: 'k1', rodzaj: 'korekta', kind: 'correction', number: '1/KOR/08/2026', parent_id: 10, gross_price: -1000, net_price: -813, tax_price: -187 }),
        f({ uuid: 'k2', rodzaj: 'korekta', kind: 'correction', number: '2/KOR/08/2026', parent_id: 99, gross_price: -1000, net_price: -813, tax_price: -187 }),
      ],
      koszty: [], kwarantanna: 0,
    });
    const [, k1, k2] = p.sprzedaz;
    expect(k1.uwagi).toContain('korekta do 5/08/2026');
    expect(k2.uwagi).toContain('korekta do faktury id 99');
  });
  // ⚠️ Encja korekty inFaktu NIESIE numer faktury pierwotnej w `corrected_invoice_number`
  // (sprawdzone na zywym koncie 2026-08-14, patrz services/korekta.js) — i to jest zrodlo
  // PIERWSZE, bo dziala takze dla korekty do faktury spoza tej paczki, gdzie mapa po id nic
  // nie wie. `parent_id` bywa wtedy nieprzydatne albo wskazuje poza miesiac.
  it('korekta bierze numer pierwotnej z corrected_invoice_number, nawet gdy parent_id wskazuje poza paczke', () => {
    const p = zlozPaczke({
      miesiac: '2026-08', faktury: [f({ id: 10, number: '5/08/2026' })],
      korekty: [f({ uuid: 'k1', rodzaj: 'korekta', number: '1/KOR/08/2026', parent_id: 99, corrected_invoice_number: '4/07/2026' })],
      koszty: [], kwarantanna: 0,
    });
    expect(p.sprzedaz[1].uwagi).toContain('korekta do 4/07/2026');
  });
  // ⚠️ `id` z inFaktu bywa liczba, a `parent_id` napisem (i odwrotnie) — mapa po surowych
  // wartosciach chybialaby po cichu i ksiegowa dostawalaby „korekta do faktury id 10" obok
  // faktury numer 10 lezacej dwa wiersze wyzej.
  it('korekta trafia po parent_id mimo roznicy typow (napis kontra liczba)', () => {
    const p = zlozPaczke({
      miesiac: '2026-08', faktury: [f({ id: 10, number: '5/08/2026' })],
      korekty: [f({ uuid: 'k1', rodzaj: 'korekta', number: '1/KOR/08/2026', parent_id: '10' })],
      koszty: [], kwarantanna: 0,
    });
    expect(p.sprzedaz[1].uwagi).toContain('korekta do 5/08/2026');
  });
  it('korekta bez numeru pierwotnej i bez parent_id — uwaga z pytajnikiem', () => {
    const p = zlozPaczke({
      miesiac: '2026-08', faktury: [],
      korekty: [f({ uuid: 'k1', rodzaj: 'korekta', number: '1/KOR/08/2026', corrected_invoice_number: '  ', parent_id: null })],
      koszty: [], kwarantanna: 0,
    });
    expect(p.sprzedaz[0].uwagi).toContain('korekta do faktury id ?');
  });
  it('kolejnosc: faktury po numerze (10 po 9, nie po 1), potem korekty', () => {
    const p = zlozPaczke({
      miesiac: '2026-08', korekty: [f({ uuid: 'k', rodzaj: 'korekta', number: '1/KOR/08/2026' })],
      faktury: [f({ uuid: 'a', number: '10/08/2026' }), f({ uuid: 'b', number: '9/08/2026' }), f({ uuid: 'c', number: '1/08/2026' })],
      koszty: [], kwarantanna: 0,
    });
    expect(p.sprzedaz.map((w) => w.numer)).toEqual(['1/08/2026', '9/08/2026', '10/08/2026', '1/KOR/08/2026']);
    expect(p.sprzedaz.map((w) => w.lp)).toEqual([1, 2, 3, 4]);
  });
  it('sumy per waluta, korekty ujemne wchodza', () => {
    const p = zlozPaczke({
      miesiac: '2026-08',
      faktury: [f({ uuid: 'a' }), f({ uuid: 'e', currency: 'EUR', net_price: 1000, tax_price: 0, gross_price: 1000 })],
      korekty: [f({ uuid: 'k', rodzaj: 'korekta', number: '1/KOR/08/2026', net_price: -813, tax_price: -187, gross_price: -1000 })],
      koszty: [], kwarantanna: 0,
    });
    expect(p.sumy.sprzedaz.PLN).toEqual({ nettoGr: 9187, vatGr: 2113, bruttoGr: 11300 });
    expect(p.sumy.sprzedaz.EUR).toEqual({ nettoGr: 1000, vatGr: 0, bruttoGr: 1000 });
  });
  // Brak kwoty w odpowiedzi inFaktu nie moze zniknac w zerze: zestawienie wygladaloby na
  // kompletne, a suma miesiaca bylaby cicho zanizona o cala fakture.
  it('faktura bez kwoty z inFaktu dostaje uwage, a nie ciche zero', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [f({ tax_price: null })], korekty: [], koszty: [], kwarantanna: 0 });
    expect(p.sprzedaz[0].uwagi).toContain('brak kwoty w inFakcie — sprawdź fakturę');
    expect(p.sprzedaz[0].vatGr).toBe(0);
  });
  // ⚠️ Uwaga NA WIERSZU nie wystarcza: ksiegowa czyta najpierw sumy i ostrzezenia paczki,
  // a wiersz z brakiem kwoty potrafi utonac wsrod stu innych. Skoro suma miesiaca jest
  // przez ten brak NIEPELNA, paczka musi to powiedziec na swoim poziomie — z numerami
  // dokumentow do sprawdzenia.
  it('brak kwoty w inFakcie daje ostrzezenie paczki, znacznik niepelnej sumy i nie wchodzi do sum', () => {
    const p = zlozPaczke({
      miesiac: '2026-08',
      faktury: [f({ uuid: 'a', number: '1/08/2026' }), f({ uuid: 'b', number: '2/08/2026', gross_price: null })],
      korekty: [], koszty: [], kwarantanna: 0,
    });
    expect(p.ostrzezenia).toContain('1 dokument sprzedażowy bez kwoty w inFakcie — sumy sprzedaży są NIEPEŁNE, sprawdź faktury: 2/08/2026');
    expect(p.sumy.sprzedaz.niepelne).toBe(true);
    expect(p.sumy.sprzedaz.PLN).toEqual({ nettoGr: 10000, vatGr: 2300, bruttoGr: 12300 });
  });
  it('dwa dokumenty bez kwoty — liczebnik i oba numery w ostrzezeniu', () => {
    const p = zlozPaczke({
      miesiac: '2026-08',
      faktury: [f({ uuid: 'a', number: '1/08/2026', net_price: null }), f({ uuid: 'b', number: '2/08/2026', gross_price: '' })],
      korekty: [], koszty: [], kwarantanna: 0,
    });
    expect(p.ostrzezenia).toContain('2 dokumenty sprzedażowe bez kwoty w inFakcie — sumy sprzedaży są NIEPEŁNE, sprawdź faktury: 1/08/2026, 2/08/2026');
  });
  it('komplet kwot — bez ostrzezenia i bez znacznika niepelnej sumy', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [f()], korekty: [], koszty: [], kwarantanna: 0 });
    expect(p.ostrzezenia).toEqual([]);
    expect('niepelne' in p.sumy.sprzedaz).toBe(false);
  });
  // Pusta data wystawienia zapalala flage „z pogranicza" i zostawiala w niej urwane
  // „wystawiona " — dla ksiegowej to wyglada na usterke wydruku, a nie na brak danych.
  it('pusta data wystawienia daje czytelna uwage, nie urwane „wystawiona ”', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [f({ invoice_date: null })], korekty: [], koszty: [], kwarantanna: 0 });
    expect(p.sprzedaz[0].uwagi).toContain('brak daty wystawienia');
  });
  // Waluta z API bywa mala litera albo ze spacja — dwa koszyki „PLN" i „pln" rozjechalyby
  // sume miesiaca na dwie liczby, z ktorych zadna nie jest kwota do deklaracji.
  it('waluta „pln" i „PLN" wpadaja do jednego koszyka', () => {
    const p = zlozPaczke({
      miesiac: '2026-08',
      faktury: [f({ uuid: 'a', number: '1/08/2026', currency: 'pln' }), f({ uuid: 'b', number: '2/08/2026', currency: ' PLN ' })],
      korekty: [], koszty: [], kwarantanna: 0,
    });
    expect(Object.keys(p.sumy.sprzedaz)).toEqual(['PLN']);
    expect(p.sumy.sprzedaz.PLN).toEqual({ nettoGr: 20000, vatGr: 4600, bruttoGr: 24600 });
    expect(p.sprzedaz.map((w) => w.waluta)).toEqual(['PLN', 'PLN']);
  });
  // Zapis zachowania, nie ochrona: `Math.round` broni WYLACZNIE przed ulamkiem grosza.
  // Kwota podana w ZLOTOWKACH (123.4) zostanie tu 123 groszami — 100x za malo i bez sladu.
  it('123.4 z inFaktu staje sie 123 groszami (zaokraglenie, nie przeliczenie ze zlotowek)', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [f({ net_price: 123.4, tax_price: 0, gross_price: 123.4 })], korekty: [], koszty: [], kwarantanna: 0 });
    expect(p.sprzedaz[0].nettoGr).toBe(123);
    expect(p.sumy.sprzedaz.PLN).toEqual({ nettoGr: 123, vatGr: 0, bruttoGr: 123 });
  });
  // ⚠️ Ulamek grosza z odpowiedzi API nie moze wejsc do sumy — dwie takie kwoty dodane do
  // siebie daja liczbe, ktorej nie ma w zadnej deklaracji, i rozjezdzaja sie z zestawieniem
  // z inFaktu. Kwoty sprzedazy maja byc calkowite CO DO TYPU, nie tylko co do wartosci.
  it('kwoty sprzedazy sa calkowite nawet gdy inFakt odda ulamek grosza', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [f({ net_price: '10000.4', tax_price: 2300.5, gross_price: 12300.9 })], korekty: [], koszty: [], kwarantanna: 0 });
    expect(p.sprzedaz[0].uwagi).toEqual([]);
    expect(p.sumy.sprzedaz.PLN).toEqual({ nettoGr: 10000, vatGr: 2301, bruttoGr: 12301 });
    for (const v of Object.values(p.sumy.sprzedaz.PLN)) expect(Number.isInteger(v)).toBe(true);
  });
  it('kontrahent bez firmy = imie i nazwisko; bez NIP-u = pusty napis', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [f({ client_company_name: null, client_first_name: 'Jan', client_last_name: 'Nowak', client_tax_code: null })], korekty: [], koszty: [], kwarantanna: 0 });
    expect(p.sprzedaz[0].kontrahent).toBe('Jan Nowak');
    expect(p.sprzedaz[0].nip).toBe('');
  });
});

describe('koszty', () => {
  it('koszt wystawiony 30.07, otrzymany 2.08 — w sierpniu z flaga obu dat', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [], korekty: [], koszty: [k({ data_wystawienia: '2026-07-30', dzien_otrzymania: '2026-08-02' })], kwarantanna: 0 });
    expect(p.koszty[0].uwagi).toContain('wystawiona 30.07.2026, otrzymana 02.08.2026');
    expect(p.koszty[0].maPlik).toBe(true);
  });
  // Zwykly przypadek: dokument wystawiony i odebrany w tym samym miesiacu nie ma czego
  // tlumaczyc ksiegowej — pusta lista uwag jest tu tresciwa, bo flagi maja zwracac uwage
  // tylko na dokumenty „z pogranicza".
  it('koszt wystawiony i otrzymany w miesiacu paczki — bez flagi', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [], korekty: [], koszty: [k()], kwarantanna: 0 });
    expect(p.koszty[0].uwagi).toEqual([]);
  });
  // Brak ktorejkolwiek z dwoch dat ma sie nazwac po imieniu — urwane „wystawiona ,
  // otrzymana 02.08.2026" ksiegowa czyta jako usterke wydruku, a to jest brak danych.
  it('koszt bez daty wystawienia — uwaga nazywa brak, nie urywa sie', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [], korekty: [], kwarantanna: 0, koszty: [k({ data_wystawienia: null })] });
    expect(p.koszty[0].uwagi).toContain('brak daty wystawienia, otrzymana 04.08.2026');
  });
  it('koszt bez dnia otrzymania — uwaga nazywa brak', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [], korekty: [], kwarantanna: 0, koszty: [k({ dzien_otrzymania: null })] });
    expect(p.koszty[0].uwagi).toContain('wystawiona 04.08.2026, brak daty otrzymania');
  });
  it('koszt reczny: bez strony PDF, z uwaga o papierze', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [], korekty: [], koszty: [k({ zrodlo: 'reczne', ksef_number: 'RECZNY-1', rodzaj: 'Reczny' })], kwarantanna: 0 });
    expect(p.koszty[0].maPlik).toBe(false);
    expect(p.koszty[0].uwagi).toContain('dokument papierowy poza KSeF — dołącz oryginał');
  });
  it('kwoty jako grosze z napisow, sumy per waluta, korekta kosztowa (Kor) wchodzi ze znakiem z KSeF', () => {
    const p = zlozPaczke({
      miesiac: '2026-08', faktury: [], korekty: [], kwarantanna: 0,
      koszty: [k(), k({ ksef_number: 'K-2', rodzaj: 'Kor', netto: '-50.00', vat: '-11.50', brutto: '-61.50' }), k({ ksef_number: 'K-3', waluta: 'EUR', netto: '10.00', vat: '0.00', brutto: '10.00' })],
    });
    expect(p.sumy.koszty.PLN).toEqual({ nettoGr: 5000, vatGr: 1150, bruttoGr: 6150 });
    expect(p.sumy.koszty.EUR).toEqual({ nettoGr: 1000, vatGr: 0, bruttoGr: 1000 });
  });
  // ⚠️ Dowod, ze sumowanie idzie po liczbach CALKOWITYCH: te same trzy kwoty dodane jako
  // floaty (0.07 + 0.07 + 0.07) daja 0.21000000000000002 i po zaokragleniu na koncu potrafia
  // chybic o grosz. Suma w groszach ma byc calkowita CO DO TYPU, nie tylko co do wartosci.
  it('sumy sa liczbami calkowitymi — nic nie przechodzi przez floaty', () => {
    const p = zlozPaczke({
      miesiac: '2026-08', faktury: [], korekty: [], kwarantanna: 0,
      koszty: [k({ ksef_number: 'a', netto: '0.07', vat: '0.07', brutto: '0.07' }),
        k({ ksef_number: 'b', netto: '0.07', vat: '0.07', brutto: '0.07' }),
        k({ ksef_number: 'c', netto: '0.07', vat: '0.07', brutto: '0.07' })],
    });
    expect(p.sumy.koszty.PLN).toEqual({ nettoGr: 21, vatGr: 21, bruttoGr: 21 });
    for (const v of Object.values(p.sumy.koszty.PLN)) expect(Number.isInteger(v)).toBe(true);
  });
  // Pusta kwota ma RZUCIC, a nie wpisac NaN do zestawienia dla biura — NaN w JSON-ie staje
  // sie `null`, wiec paczka wygladalaby na kompletna, a suma miesiaca byla o dokument za mala.
  it('koszt z pusta kwota wywraca skladanie paczki', () => {
    expect(() => zlozPaczke({ miesiac: '2026-08', faktury: [], korekty: [], kwarantanna: 0, koszty: [k({ netto: '' })] }))
      .toThrow(/Brak kwoty/);
  });
  it('kwarantanna > 0 daje ostrzezenie', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [], korekty: [], koszty: [], kwarantanna: 2 });
    expect(p.ostrzezenia).toEqual(['2 dokumenty kosztowe leżą w kwarantannie panelu i NIE ma ich w tej paczce.']);
  });
  it('kolejnosc kosztow: po dacie otrzymania, potem numer', () => {
    const p = zlozPaczke({ miesiac: '2026-08', faktury: [], korekty: [], kwarantanna: 0, koszty: [k({ ksef_number: 'b', dzien_otrzymania: '2026-08-05', numer_dokumentu: 'B' }), k({ ksef_number: 'a', dzien_otrzymania: '2026-08-05', numer_dokumentu: 'A' }), k({ ksef_number: 'c', dzien_otrzymania: '2026-08-01' })] });
    expect(p.koszty.map((w) => w.klucz)).toEqual(['c', 'a', 'b']);
  });
});

describe('porownajNumery', () => {
  it('rok, miesiac, kolejny — numerycznie', () => {
    expect(['10/08/2026', '2/08/2026', '1/07/2026', 'WDT/3/2026'].sort(porownajNumery)).toEqual(['1/07/2026', '2/08/2026', '10/08/2026', 'WDT/3/2026']);
  });
  // ⚠️ Numer korekty BEZ segmentu miesiaca (`12/KOR/2026`) nie pasuje do wzorca — i to jest
  // w porzadku, dopoki NIE GINIE: ma wyladowac za numerami dopasowanymi, ale zostac
  // w zestawieniu. Zgubiony wiersz to zgubiony dokument podatkowy.
  it('numer spoza wzorca (12/KOR/2026) idzie na koniec, ale zostaje', () => {
    expect(['12/KOR/2026', '2/08/2026', '10/08/2026'].sort(porownajNumery)).toEqual(['2/08/2026', '10/08/2026', '12/KOR/2026']);
  });
  it('korekta spoza wzorca zostaje w paczce', () => {
    const p = zlozPaczke({
      miesiac: '2026-08', faktury: [],
      korekty: [f({ uuid: 'k1', rodzaj: 'korekta', number: '12/KOR/2026' }), f({ uuid: 'k2', rodzaj: 'korekta', number: '1/KOR/08/2026' })],
      koszty: [], kwarantanna: 0,
    });
    expect(p.sprzedaz.map((w) => w.numer)).toEqual(['1/KOR/08/2026', '12/KOR/2026']);
  });
});
