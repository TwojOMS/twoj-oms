// tests/oms/wysylka-ksef-regula.test.js
import { describe, it, expect } from 'vitest';
import { coWolnoWyslac, czyKonsumencka } from '../../src/domena/wysylka-ksef.js';

// ⚠️ NIP NABYWCY JEST W FIKSTURZE BAZOWEJ, bo tak wygląda 168 ze 169 faktur zmierzonych na
// żywym koncie (VI–VIII.2026) — i bo od 28.08.2026 dokument BEZ NIP-u jest konsumencki, więc
// bariera go nie przepuszcza. Fikstura bez tego pola testowałaby ścieżkę odmowy przy każdym
// teście, który sprawdza coś zupełnie innego.
const dok = (n) => ({
  uuid: `u${n}`, number: `${n}/08/2026`, rodzaj: 'vat', ksef_number: null,
  client_tax_code: '1234563218',
});

describe('co wolno wysłać do KSeF', () => {
  it('przepuszcza faktury VAT bez numeru KSeF', () => {
    const w = coWolnoWyslac(['u1', 'u2'], [dok(1), dok(2)]);
    expect(w.doWyslania.map((d) => d.uuid)).toEqual(['u1', 'u2']);
    expect(w.pominiete).toEqual([]);
  });

  // ⚠️ POMINIĘTE MUSI WRÓCIĆ Z POWODEM. Ciche wyrzucenie z listy jest gorsze niż odmowa
  // całości: operator widzi „wysłano", a dokumentu nikt nie wysłał (przewodnik 4.13a).
  it('odrzuca dokument, który JUŻ jest w KSeF — z powodem', () => {
    const wKsef = { ...dok(3), ksef_number: '1234563218-20260806-5EB04B000005-18' };
    const w = coWolnoWyslac(['u3'], [wKsef]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0]).toMatchObject({ numer: '3/08/2026' });
    expect(w.pominiete[0].powod).toMatch(/jest już w KSeF/i);
  });

  // ⚠️⚠️ DOKUMENT, KTOREGO WYSYLKE PANEL JUZ ZLECIL (recenzja calosci, Finding 1). `ksef_number`
  // pojawia sie dopiero po ~70 sekundach, wiec swiezo pobrana lista jest SLEPA na wysylke
  // zlecona przed chwila — bariera musi widziec REZERWACJE, a nie tylko numer. Bez tego ekran
  // podgladu liczyl taki dokument do „Poleci do KSeF" i obiecywal wyslanie czegos, co i tak
  // odbije sie od bazy (services/wysylka-ksef.js, `zarezerwuj`).
  //
  // ⚠️ TO NIE JEST DRUGA BARIERA ZAMIAST TAMTEJ — rezerwacja w bazie zostaje jedyna GWARANCJA
  // (odbija takze dwa rownolegle zatwierdzenia). Ten warunek istnieje po to, zeby EKRAN mowil
  // prawde o tym, co poleci.
  it('odrzuca dokument, którego wysyłkę panel już zlecił — z powodem odsyłającym do inFaktu', () => {
    const zlecony = { ...dok(4), ksefZleconaAt: '2026-08-06T14:00:00.000Z' };
    const w = coWolnoWyslac(['u4'], [zlecony]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0]).toMatchObject({ numer: '4/08/2026' });
    expect(w.pominiete[0].powod).toMatch(/już zlecił|juz zlecil/i);
    expect(w.pominiete[0].powod).toMatch(/inFak/i);
    // Panel NIGDY nie ponawia sam — duplikatu u organu nie da sie skasowac.
    expect(w.pominiete[0].powod).toMatch(/nie ponowi/i);
  });

  // Data zlecenia jest dla czlowieka: po niej odnajdzie te wysylke w logu zamowienia.
  it('powód niesie moment, w którym panel zlecił wysyłkę', () => {
    const zlecony = { ...dok(4), ksefZleconaAt: '2026-08-06T14:00:00.000Z' };
    expect(coWolnoWyslac(['u4'], [zlecony]).pominiete[0].powod).toMatch(/2026-08-06T14:00:00\.000Z/);
  });

  // ⚠️ TO JEST LICZBA NA CZERWONYM PRZYCISKU. Ekran podgladu pisze „Poleci do KSeF — N"
  // z dlugosci `doWyslania`, wiec dokument juz zlecony policzony do tej liczby zamienia
  // zdanie „polecą trzy" w falsz — poleca dwa, a trzeci odbije sie od rezerwacji.
  it('mieszana partia z dokumentem już zleconym — liczba „poleci" nie kłamie', () => {
    const zlecony = { ...dok(2), ksefZleconaAt: '2026-08-06T14:00:00.000Z' };
    const w = coWolnoWyslac(['u1', 'u2'], [dok(1), zlecony]);
    expect(w.doWyslania.map((d) => d.uuid)).toEqual(['u1']);
    expect(w.pominiete).toHaveLength(1);
  });

  // ⚠️ BIAŁA LISTA TYPU, A NIE BRAK CHECKBOXA W WIDOKU. Widok jest wygodą; bariera musi
  // stać w domenie, bo formularz można wysłać z ręki. Decyzja właściciela 06.08.2026:
  // korekty wyłącznie do podglądu.
  it('odrzuca korektę, nawet gdy przyszła w zaznaczeniu', () => {
    const k = { uuid: 'k1', number: '1/KOR/08/2026', rodzaj: 'korekta', ksef_number: null };
    const w = coWolnoWyslac(['k1'], [k]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0].powod).toMatch(/korekt/i);
  });

  // ⚠️ ZAZNACZENIE NIESIE IDENTYFIKATORY, NIE DECYZJE. Uuid spoza bieżącego wyniku znaczy,
  // że ktoś podłożył formularz albo lista się zmieniła między podglądem a zatwierdzeniem.
  it('odrzuca identyfikator spoza listy', () => {
    const w = coWolnoWyslac(['obcy'], [dok(1)]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0].powod).toMatch(/nie ma go na liście|spoza/i);
  });

  it('puste zaznaczenie daje pusty wynik, a nie wszystko', () => {
    expect(coWolnoWyslac([], [dok(1), dok(2)])).toEqual({ doWyslania: [], pominiete: [] });
    expect(coWolnoWyslac(null, [dok(1)])).toEqual({ doWyslania: [], pominiete: [] });
  });

  it('duplikat w zaznaczeniu nie wysyła dokumentu dwa razy', () => {
    const w = coWolnoWyslac(['u1', 'u1'], [dok(1)]);
    expect(w.doWyslania).toHaveLength(1);
  });

  // ⚠️ FASTIFY ODDAJE JEDEN ZAZNACZONY CHECKBOX JAKO NAPIS, NIE TABLICĘ (masowe.js,
  // `wybraneZListy`). Bez `[].concat` pętla `for...of` po stringu iteruje ZNAKI: 'u1' dałoby
  // 'u' i '1', zero wysyłek i dwa bezsensowne wiersze na ekranie operatora. To jest
  // najczęstszy przypadek — jedna zaznaczona faktura — więc musi działać pierwszy.
  it('pojedyncze zaznaczenie jako goły napis (jeden checkbox z Fastify) wysyła dokładnie ten dokument', () => {
    const w = coWolnoWyslac('u1', [dok(1)]);
    expect(w.doWyslania.map((d) => d.uuid)).toEqual(['u1']);
    expect(w.pominiete).toEqual([]);
  });

  // ⚠️ TU JEST GŁÓWNY INWARIANT MODUŁU: pominięty dokument nie znika, wraca z powodem —
  // dla WSZYSTKICH pominiętych w JEDNYM wywołaniu, nie tylko dla pojedynczego zaznaczenia.
  // Testy wyżej sprawdzają po jednym dokumencie na wywołanie, więc `continue` zamieniony na
  // `break` przechodziłby całą resztę pliku bez zająknięcia.
  it('mieszana partia: dobry, już w KSeF, korekta, obcy id — jedno wywołanie, cztery różne losy', () => {
    const dobry = dok(1);
    const wKsef = { ...dok(2), ksef_number: '1234563218-20260806-5EB04B000005-18' };
    const korekta = { uuid: 'k1', number: '1/KOR/08/2026', rodzaj: 'korekta', ksef_number: null };
    const w = coWolnoWyslac(['u1', 'u2', 'k1', 'obcy'], [dobry, wKsef, korekta]);

    expect(w.doWyslania.length + w.pominiete.length).toBe(4);
    expect(w.doWyslania.map((d) => d.uuid)).toEqual(['u1']);

    const powody = w.pominiete.map((p) => p.powod);
    expect(powody.some((p) => /jest już w KSeF/i.test(p))).toBe(true);
    expect(powody.some((p) => /korekt/i.test(p))).toBe(true);
    expect(powody.some((p) => /nie ma go na liście|spoza/i.test(p))).toBe(true);

    // Id spoza listy w polu „numer" ma być czytelnie identyfikatorem, nie fałszywym
    // numerem faktury (widok renderuje to pole jako numer dokumentu).
    const obcy = w.pominiete.find((p) => /nie ma go na liście|spoza/i.test(p.powod));
    expect(obcy.numer).toBe('(id obcy)');
  });

  // ⚠️ WOŁANA DWA RAZY (patrz nagłówek pliku źródłowego): raz na podglądzie, raz przy
  // zatwierdzeniu, z listą dokumentów wczytaną NA NOWO. Ten test przypina kontrakt „nie ma
  // pamięci między wywołaniami" — gdyby ktoś kiedyś dodał cache po uuid, ten test by to złapał.
  it('to samo zaznaczenie, dwie różne listy dokumentów — dwie różne odpowiedzi', () => {
    const w1 = coWolnoWyslac(['u1'], [dok(1)]);
    expect(w1.doWyslania).toHaveLength(1);
    expect(w1.pominiete).toEqual([]);

    const jużWKsef = { ...dok(1), ksef_number: '1234563218-20260806-5EB04B000005-18' };
    const w2 = coWolnoWyslac(['u1'], [jużWKsef]);
    expect(w2.doWyslania).toEqual([]);
    expect(w2.pominiete[0].powod).toMatch(/jest już w KSeF/i);
  });

  // ⚠️ Nie wystarczy `?? []` — zdegradowana odpowiedź API potrafi oddać obiekt truthy zamiast
  // tablicy (patrz lista-faktur.js, `bierz`). Funkcja stoi przed operacją nieodwracalną i nie
  // ma prawa wywalić się na złym payloadzie zamiast odmówić po swojemu.
  it('zdegradowana odpowiedź (obiekt zamiast tablicy) w dokumentach nie wywala funkcji', () => {
    expect(() => coWolnoWyslac(['u1'], { error: 'boom' })).not.toThrow();
    const w = coWolnoWyslac(['u1'], { error: 'boom' });
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0].powod).toMatch(/nie ma go na liście|spoza/i);
  });

  // ⚠️ Nieznany `rodzaj` to NIE korekta. Powód musi to odróżnić — inaczej człowiek szuka
  // dokumentu w inFakcie, którego tam nigdy nie było (patrz masowe.js, rozróżnienie
  // „nieznana metoda" vs. nazwany przypadek).
  it('nieznany rodzaj dokumentu dostaje własny powód, nie mylony z korektą', () => {
    const dziwny = { uuid: 'd1', number: '1/DZ/08/2026', rodzaj: 'proforma', ksef_number: null };
    const w = coWolnoWyslac(['d1'], [dziwny]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0].powod).toMatch(/nieznany rodzaj/i);
  });

  // ⚠️⚠️ KOLEJNOŚĆ SPECYFICZNOŚCI (recenzja całości, Finding A3). Biała lista rodzaju musi być
  // sprawdzona PRZED „panel już zlecił": rodzaj dokumentu to powód TRWAŁY (korekta nigdy nie
  // stanie się wysyłalna), a „już zlecił" jest powodem PRZEJŚCIOWYM (sam znika po odpowiedzi
  // inFaktu). Dziś korekta nie ma drogi do bycia „zleconą" (panel jej nie rezerwuje) — ten test
  // przypina kolejność na przyszłość, zanim ta droga się pojawi.
  it('korekta zgłoszona jako już zlecona dostaje powód o korektach, nie „panel już zlecił"', () => {
    const zleconaKorekta = {
      uuid: 'k1', number: '1/KOR/08/2026', rodzaj: 'korekta', ksef_number: null,
      ksefZleconaAt: '2026-08-06T14:00:00.000Z',
    };
    const w = coWolnoWyslac(['k1'], [zleconaKorekta]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0].powod).toMatch(/korekt/i);
    expect(w.pominiete[0].powod).not.toMatch(/panel już zlecił/i);
  });
});

// ⚠️⚠️ FAKTURA KONSUMENCKA (NABYWCA BEZ NIP-u). Do 28.08.2026 bariera nie pytała o NIP
// NIGDZIE — ani ona, ani widok, ani trasa. Pomiar na żywym koncie (VI–VIII.2026): 169 faktur,
// 168 z NIP-em i wszystkie 168 w KSeF, DOKŁADNIE JEDNA bez NIP-u (`30/06/2026`) i jej w KSeF
// nie ma. Ta jedna miała pole wyboru i była JEDYNĄ czerwcową bez numeru KSeF, więc „zaznacz
// wszystkie" w czerwcu zaznaczyłoby wyłącznie ją i wysłało — a wysyłki do KSeF nie da się
// cofnąć. Przepis (Ministerstwo Finansów): faktury B2C w KSeF są DOBROWOLNE.
// Decyzja właściciela 28.08.2026: blokada twarda, dokładnie jak przy korektach.
describe('faktura konsumencka (nabywca bez NIP-u) nie jedzie do KSeF', () => {
  const bezNipu = (nadpisz = {}) => ({ ...dok(30), number: '30/06/2026', ...nadpisz });

  // ⚠️ NAJPIERW ŚCIEŻKA, KTÓREJ NIE WOLNO ZEPSUĆ: 168 ze 169 zmierzonych faktur ma NIP
  // i wszystkie mają jechać dalej tak, jak jechały.
  it('faktura z NIP-em nabywcy i bez numeru KSeF dalej jedzie do wysyłki', () => {
    const w = coWolnoWyslac(['u1'], [dok(1)]);
    expect(w.doWyslania.map((d) => d.uuid)).toEqual(['u1']);
    expect(w.pominiete).toEqual([]);
  });

  it('pusty `client_tax_code` odbija się od bariery — z powodem o dokumencie konsumenckim', () => {
    const w = coWolnoWyslac(['u30'], [bezNipu({ client_tax_code: '' })]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0]).toMatchObject({ numer: '30/06/2026' });
    // Powód ma NAZWAĆ stan, powiedzieć o dobrowolności i o tym, że panel takich nie wysyła.
    expect(w.pominiete[0].powod).toMatch(/konsumenck/i);
    expect(w.pominiete[0].powod).toMatch(/NIP/i);
    expect(w.pominiete[0].powod).toMatch(/dobrowoln/i);
  });

  // ⚠️ POWÓD NIE JEST KOMUNIKATEM O BŁĘDZIE. Faktura bez NIP-u to normalna sprzedaż osobie
  // prywatnej, a nie usterka do naprawienia — słowo „błąd" wysyłałoby właściciela szukać
  // uszkodzenia, którego nie ma.
  it('powód nie nazywa tego błędem ani brakiem danych', () => {
    const powod = coWolnoWyslac(['u30'], [bezNipu({ client_tax_code: '' })]).pominiete[0].powod;
    expect(powod).not.toMatch(/błąd|blad/i);
    expect(powod).not.toMatch(/brak danych/i);
  });

  // ⚠️⚠️ BRAK POLA TO ODMOWA, NIE ZGODA. Zdegradowana odpowiedź inFaktu (2xx z pustym ciałem
  // daje dokument z samych `null`) nie ma prawa OTWORZYĆ drogi do operacji nieodwracalnej.
  // Ta sama doktryna, co w domain/lista-faktur.js: na braku danych nie działamy.
  it.each([
    ['null', { client_tax_code: null }],
    ['undefined', { client_tax_code: undefined }],
    ['same spacje', { client_tax_code: '   ' }],
  ])('%s w polu NIP-u = odmowa, a nie przepustka', (_opis, nadpisz) => {
    const w = coWolnoWyslac(['u30'], [bezNipu(nadpisz)]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0].powod).toMatch(/konsumenck/i);
  });

  it('CAŁKOWITY brak klucza `client_tax_code` też jest odmową', () => {
    const goly = { uuid: 'u30', number: '30/06/2026', rodzaj: 'vat', ksef_number: null };
    const w = coWolnoWyslac(['u30'], [goly]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0].powod).toMatch(/konsumenck/i);
  });

  // ⚠️⚠️ TU JEST NAJDROŻSZA POMYŁKA MOŻLIWA W TEJ REGULE. Klient zagraniczny (WDT) ma
  // w `client_tax_code` numer VAT UE z prefiksem literowym — to JEST podatnik i jego faktura
  // ma iść do KSeF normalnie (domain/wdt.js: „numer zaczyna się od dwóch liter" znaczy
  // „nabywca z innego państwa Unii"). Każda „poprawka" reguły w stronę walidacji polskiego
  // NIP-u (dziesięć cyfr, suma kontrolna, brak liter) zablokowałaby WDT — czyli zamieniłaby
  // jedną cichą pomyłkę na drugą, gorszą, bo dotyczącą dokumentów, które do KSeF iść MUSZĄ.
  it.each(['SK1000000002', 'DE100000003', 'CZ10000005'])(
    'zagraniczny numer VAT UE (%s) to podatnik — faktura jedzie do KSeF',
    (vatUe) => {
      const w = coWolnoWyslac(['u30'], [bezNipu({ client_tax_code: vatUe })]);
      expect(w.doWyslania.map((d) => d.uuid)).toEqual(['u30']);
      expect(w.pominiete).toEqual([]);
    },
  );

  // ⚠️ KOLEJNOŚĆ POWODÓW, CZĘŚĆ 1. „Jest już w KSeF" jest trwałe ORAZ niesie numer, po którym
  // człowiek odnajdzie dokument u organu — wygrywa z „konsumencka", która niczego nie doda.
  it('dokument konsumencki, który JUŻ jest w KSeF, dostaje powód o KSeF-ie (z numerem)', () => {
    const w = coWolnoWyslac(['u30'], [bezNipu({
      client_tax_code: null, ksef_number: '1234563218-20260630-5EB04B000005-18',
    })]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0].powod).toMatch(/jest już w KSeF/i);
    expect(w.pominiete[0].powod).toMatch(/1234563218-20260630/);
    expect(w.pominiete[0].powod).not.toMatch(/konsumenck/i);
  });

  // ⚠️ KOLEJNOŚĆ POWODÓW, CZĘŚĆ 2 — ta sama zasada, co przy korekcie zgłoszonej jako zlecona.
  // „Konsumencka" jest TRWAŁA (faktura bez NIP-u nie stanie się wysyłalna ani po dobie, ani po
  // odpowiedzi inFaktu), a „panel już zlecił" PRZEJŚCIOWE — pokazane tutaj kłamałoby, że
  // wystarczy poczekać.
  it('dokument konsumencki ze stemplem rezerwacji dostaje powód o konsumenckim, nie o zleconej wysyłce', () => {
    const w = coWolnoWyslac(['u30'], [bezNipu({
      client_tax_code: '', ksefZleconaAt: '2026-06-30T14:00:00.000Z',
    })]);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete[0].powod).toMatch(/konsumenck/i);
    expect(w.pominiete[0].powod).not.toMatch(/już zlecił|juz zlecil/i);
  });

  // Odtworzenie CZERWCA z pomiaru: jedna faktura bez NIP-u wśród samych dokumentów z NIP-em.
  // „Zaznacz wszystkie" oddaje całą listę — bariera ma wypuścić resztę i zatrzymać tę jedną.
  it('partia „zaznacz wszystkie": jedna konsumencka wśród firmowych zostaje w domu', () => {
    const konsument = bezNipu({ uuid: 'uK', client_tax_code: null });
    const w = coWolnoWyslac(['u1', 'uK', 'u2'], [dok(1), konsument, dok(2)]);
    expect(w.doWyslania.map((d) => d.uuid)).toEqual(['u1', 'u2']);
    expect(w.pominiete).toHaveLength(1);
    expect(w.pominiete[0]).toMatchObject({ numer: '30/06/2026' });
    expect(w.pominiete[0].powod).toMatch(/konsumenck/i);
  });
});

describe('czyKonsumencka — predykat wołany także przez widok', () => {
  it.each([
    ['brak pola', {}, true],
    ['null', { client_tax_code: null }, true],
    ['pusty napis', { client_tax_code: '' }, true],
    ['same spacje', { client_tax_code: ' \t ' }, true],
    ['polski NIP', { client_tax_code: '1234563218' }, false],
    ['VAT UE (WDT)', { client_tax_code: 'SK1000000002' }, false],
    // Cokolwiek niepustego = nabywca podał identyfikator podatkowy. Reguła NIE waliduje
    // formatu i nie ma prawa go walidować — patrz docblock `czyKonsumencka`.
    ['numer w innym formacie', { client_tax_code: '123-456-78-90' }, false],
  ])('%s → %s', (_opis, dokument, oczekiwane) => {
    expect(czyKonsumencka(dokument)).toBe(oczekiwane);
  });

  // Bariera woła ten predykat na dokumencie z listy, a lista bywa zdegradowana (patrz
  // `wzbogac` w services/faktury-widok.js — `d` bywa `null`). Predykat ma wtedy odmówić,
  // a nie wywalić się przy wysyłce.
  it('null/undefined nie wywala predykatu — odpowiada „konsumencka", czyli odmowa', () => {
    expect(czyKonsumencka(null)).toBe(true);
    expect(czyKonsumencka(undefined)).toBe(true);
  });
});
