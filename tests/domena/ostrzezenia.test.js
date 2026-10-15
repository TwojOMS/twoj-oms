import { describe, it, expect } from 'vitest';
import {
  ostrzezeniaFaktur, ostrzezeniaPrzesylek, ostrzezeniaWiadomosci, ostrzezeniaIntegracji,
  ostrzezeniaTerminow, ostrzezeniaZwrotow, ostrzezeniaPobran,
  zlozOstrzezenia, kluczDozwolony, WYGASANIE_INTEGRACJI_MS,
} from '../../src/domena/ostrzezenia.js';
import { ocenZdrowie } from '../../src/domena/zdrowie.js';

// 2026-08-29 to SOBOTA — daty w przypadkach niżej są dobrane jawnie pod regułę dni
// roboczych (24.08 = poniedziałek, do soboty mijają 4 dni robocze: wt–pt).
const TERAZ = new Date('2026-08-29T10:00:00.000Z');
const DZIS = '2026-08-29';

describe('ostrzezeniaFaktur — dokument do wysłania do KSeF', () => {
  const luka = (n) => ({
    uuid: `u-${n}`, numer: `${n}/08/2026`, invoice_date: '2026-08-27', sprawdzona_at: '2026-08-29T07:00:00.000Z',
  });

  it('faktura wystawiona przed dzisiejszym dniem alarmuje z numerem i datą', () => {
    const [w] = ostrzezeniaFaktur({ luki: [luka(51)], dzis: DZIS });
    expect(w.typ).toBe('faktura-ksef');
    expect(w.klucz).toBe('faktura-ksef:u-51');
    expect(w.tekst).toContain('51/08/2026');
    expect(w.tekst).toContain('2026-08-27');
    expect(w.tekst).toContain('nie została wysłana do KSeF');
    expect(w.przycisk).toEqual({ href: '/faktury?miesiac=2026-08', etykieta: 'Faktury' });
    expect(w.etykietaOdrzucenia).toBe('Ignoruj');
  });

  it('faktura z DZISIEJSZĄ datą wystawienia MILCZY — wieczorna wysyłka to normalny tryb', () => {
    expect(ostrzezeniaFaktur({ luki: [{ ...luka(60), invoice_date: DZIS }], dzis: DZIS })).toHaveLength(0);
  });

  it('dokument z poprzedniego miesiąca linkuje do SWOJEGO miesiąca zakładki', () => {
    const [w] = ostrzezeniaFaktur({ luki: [{ ...luka(9), invoice_date: '2026-07-30' }], dzis: DZIS });
    expect(w.przycisk.href).toBe('/faktury?miesiac=2026-07');
  });

  it('luka bez daty wystawienia NIE znika po cichu', () => {
    const [w] = ostrzezeniaFaktur({ luki: [{ ...luka(3), invoice_date: null }], dzis: DZIS });
    expect(w).toBeTruthy();
    expect(w.przycisk.href).toBe('/faktury');
  });

  it('data odczytu lustra jedzie w title — stęchłe dane mają być widoczne', () => {
    const [w] = ostrzezeniaFaktur({ luki: [luka(51)], dzis: DZIS });
    expect(w.title).toContain('2026-08-29T07:00:00.000Z');
  });

  it('bez luk nie ma wierszy', () => {
    expect(ostrzezeniaFaktur({ luki: [], dzis: DZIS })).toHaveLength(0);
  });
});

describe('ostrzezeniaPrzesylek — paczka bez ruchu', () => {
  // Kształt wiersza jak z przesylkiDoSledzenia (SELECT * FROM przesylki).
  const paczka = (n, reszta = {}) => ({
    id: n,
    zamowienie_id: 100 + n,
    kurier: 'dpd',
    status: 'nadana',
    numer_listu: `0000${n}`,
    status_kuriera: 'Przesyłka w drodze',
    status_kuriera_kod: null,
    status_kuriera_at: '2026-08-24T09:00:00.000Z', // poniedziałek; do 29.08 mijają >3 dni robocze
    utworzona_at: '2026-08-24T08:00:00.000Z',
    ukryta_at: null,
    ...reszta,
  });
  const zamowienia = new Map([[101, { numer: 'MA260800101' }], [102, { numer: 'MA260800102' }]]);

  it('paczka bez ruchu ponad 3 dni robocze alarmuje z numerem listu i zamówienia', () => {
    const [w] = ostrzezeniaPrzesylek({ przesylki: [paczka(1)], zamowienia, teraz: TERAZ });
    expect(w.typ).toBe('przesylka');
    expect(w.klucz).toBe('przesylka:1:2026-08-24T09:00:00.000Z');
    expect(w.tekst).toContain('00001');
    expect(w.tekst).toContain('MA260800101');
    expect(w.tekst).toContain('bez ruchu');
    expect(w.przycisk).toEqual({ href: '/przesylki?pokaz=bez_ruchu', etykieta: 'Przesyłki' });
  });

  it('paczka ze świeżym zdarzeniem kuriera MILCZY', () => {
    const swieza = paczka(2, { status_kuriera_at: '2026-08-28T15:00:00.000Z' });
    expect(ostrzezeniaPrzesylek({ przesylki: [swieza], zamowienia, teraz: TERAZ })).toHaveLength(0);
  });

  it('paczka DORĘCZONA nie stoi, choćby zdarzenie było stare', () => {
    const doreczona = paczka(3, { status_kuriera: 'Przesyłka doręczona', status_kuriera_at: '2026-08-10T10:00:00.000Z' });
    expect(ostrzezeniaPrzesylek({ przesylki: [doreczona], zamowienia, teraz: TERAZ })).toHaveLength(0);
  });

  it('paczka UKRYTA milczy — człowiek już o niej zdecydował', () => {
    const ukryta = paczka(4, { ukryta_at: '2026-08-26T10:00:00.000Z' });
    expect(ostrzezeniaPrzesylek({ przesylki: [ukryta], zamowienia, teraz: TERAZ })).toHaveLength(0);
  });

  it('bez zdarzeń kuriera klucz i data liczą się od nadania', () => {
    const bezSkanu = paczka(5, { status_kuriera: null, status_kuriera_at: null, zamowienie_id: 102 });
    const [w] = ostrzezeniaPrzesylek({ przesylki: [bezSkanu], zamowienia, teraz: TERAZ });
    expect(w.klucz).toBe('przesylka:5:2026-08-24T08:00:00.000Z');
    expect(w.tekst).toContain('MA260800102');
  });
});

describe('ostrzezeniaWiadomosci — wątek czeka na odpowiedź', () => {
  const watek = (reszta = {}) => ({
    kanal: 'allegro_szkicownia',
    thread_id: 'w-1',
    interlocutor_login: 'kupujacy77',
    last_message_date_time: '2026-08-29T06:30:00.000Z',
    ostatnia_od_kupujacego: 1,
    ostatnia_tresc: 'Dzień dobry, czy da się zmienić rozmiar szablonu na 70x100?',
    ...reszta,
  });

  // ⚠️ `teraz: TERAZ` NIE JEST OZDOBNIKIEM. Bez niego domyslny `new Date()` bierze
  // PRAWDZIWY dzien, a fikstura ma date 29.08.2026 — test przechodzil, dopoki kalendarz
  // nie wyszedl poza okno swiezosci wiadomosci, i od tej pory swiecil na czerwono bez
  // zadnej zmiany w kodzie (zlapane 10.09.2026). Pozostale przypadki w tym opisie robily
  // to poprawnie od poczatku.
  it('ostatnia wiadomość od kupującego alarmuje z loginem', () => {
    const [w] = ostrzezeniaWiadomosci({ watki: [watek()], teraz: TERAZ });
    expect(w.typ).toBe('wiadomosc-allegro');
    expect(w.klucz).toBe('wiadomosc:allegro_szkicownia:w-1:2026-08-29T06:30:00.000Z');
    expect(w.tekst).toContain('Nowa wiadomość z Allegro');
    expect(w.tekst).toContain('kupujacy77');
    expect(w.przycisk).toEqual({ href: '/wiadomosci', etykieta: 'Wiadomości' });
  });

  it('skrót treści jedzie w title, nie w tekście wiersza', () => {
    const [w] = ostrzezeniaWiadomosci({ watki: [watek()], teraz: TERAZ });
    expect(w.title).toContain('zmienić rozmiar');
    expect(w.tekst).not.toContain('zmienić rozmiar');
  });

  it('wątek, w którym ostatnie słowo jest nasze, MILCZY', () => {
    expect(ostrzezeniaWiadomosci({ watki: [watek({ ostatnia_od_kupujacego: 0 })], teraz: TERAZ })).toHaveLength(0);
  });

  // ⚠️ ZMIERZONE NA PRODUKCJI 29.08 godzinę po wdrożeniu: 18 wierszy „nowa wiadomość"
  // z kwietnia–7 sierpnia. Prawdziwą przyczyną okazał się poller biorący z Allegro
  // NAJSTARSZĄ wiadomość zamiast najnowszej (naprawione w b9a14a3), ale okno ZOSTAJE:
  // definiuje, co znaczy „nowa" — i jest drugą linią obrony, gdyby lustro wątków znów
  // zestarzało się niepostrzeżenie. Szum 18 wierszy uczy ignorowania całej tabelki.
  it('wiadomość starsza niż 7 dni MILCZY — to nie jest już „nowa"', () => {
    const stara = watek({ last_message_date_time: '2026-08-21T09:00:00.000Z' }); // 8 dni przed TERAZ
    expect(ostrzezeniaWiadomosci({ watki: [stara], teraz: TERAZ })).toHaveLength(0);
  });

  it('wiadomość sprzed 6 dni jeszcze alarmuje', () => {
    const swieza = watek({ last_message_date_time: '2026-08-23T10:00:00.000Z' });
    expect(ostrzezeniaWiadomosci({ watki: [swieza], teraz: TERAZ })).toHaveLength(1);
  });

  it('wątek bez daty ostatniej wiadomości MILCZY — bez daty nie ma jak być świeżym', () => {
    const bezDaty = watek({ last_message_date_time: null });
    expect(ostrzezeniaWiadomosci({ watki: [bezDaty], teraz: TERAZ })).toHaveLength(0);
  });
});

describe('ostrzezeniaTerminow — zbiorczy wiersz z pasa długów', () => {
  const wiersz = (uuid, gr, termin = '2026-08-10') => ({
    uuid, numer: `${uuid}/07/2026`, payment_date: termin, pozostalo_gr: gr, sprawdzona_at: '2026-08-29T07:00:00.000Z',
  });

  it('dwie przeterminowane składają się w JEDEN wiersz z liczbą i sumą', () => {
    const wynik = ostrzezeniaTerminow({ poTerminie: [wiersz('u-40', 99000), wiersz('u-41', 42112, '2026-08-12')] });
    expect(wynik).toHaveLength(1);
    const [w] = wynik;
    expect(w.typ).toBe('faktura-termin');
    expect(w.klucz).toBe('faktura-termin:2:141112');
    expect(w.tekst).toContain('2 faktury po terminie płatności');
    expect(w.tekst).toContain('1411.12 zł');
    expect(w.przycisk).toEqual({ href: '/faktury', etykieta: 'Faktury' });
    expect(w.etykietaOdrzucenia).toBe('Ignoruj');
  });

  it('pojedyncza faktura odmienia się po polsku, a numery jadą w title', () => {
    const [w] = ostrzezeniaTerminow({ poTerminie: [wiersz('u-40', 99000)] });
    expect(w.tekst).toContain('1 faktura po terminie płatności');
    expect(w.title).toContain('u-40/07/2026');
    expect(w.title).toContain('2026-08-10');
  });

  it('pięć i więcej to „faktur", nie „faktury"', () => {
    const [w] = ostrzezeniaTerminow({ poTerminie: [1, 2, 3, 4, 5].map((n) => wiersz(`u-${n}`, 100)) });
    expect(w.tekst).toContain('5 faktur po terminie płatności');
  });

  it('bez przeterminowanych nie ma wiersza', () => {
    expect(ostrzezeniaTerminow({ poTerminie: [] })).toHaveLength(0);
  });

  // Klucz jest odciskiem ZBIORU (liczba + suma w groszach): nowa przeterminowana albo
  // częściowa spłata zmienia odcisk i odrzucone ostrzeżenie wraca samo.
  it('zmiana zbioru zmienia klucz — odrzucenie nie przeżywa nowej zaległości', () => {
    const [a] = ostrzezeniaTerminow({ poTerminie: [wiersz('u-40', 99000)] });
    const [b] = ostrzezeniaTerminow({ poTerminie: [wiersz('u-40', 99000), wiersz('u-41', 100)] });
    expect(a.klucz).not.toBe(b.klucz);
  });
});

describe('ostrzezeniaZwrotow — zwrot bez korekty w inFakcie', () => {
  const zwrot = (reszta = {}) => ({
    id: 9,
    zamowienie_id: 1234,
    zamowienie_numer: 'MA260800077',
    data: '2026-08-27',
    utworzony_at: '2026-08-28T14:00:00.000Z',
    ...reszta,
  });

  it('zwrot zarejestrowany przed dzisiejszym dniem alarmuje z numerem zamówienia', () => {
    const [w] = ostrzezeniaZwrotow({ zwroty: [zwrot()], dzis: DZIS });
    expect(w.typ).toBe('zwrot-korekta');
    expect(w.klucz).toBe('zwrot:9');
    expect(w.tekst).toContain('MA260800077');
    expect(w.tekst).toContain('korekty');
    expect(w.przycisk).toEqual({ href: '/zamowienia/1234', etykieta: 'Zamówienie' });
    expect(w.etykietaOdrzucenia).toBe('Ignoruj');
  });

  it('zwrot zarejestrowany DZISIAJ milczy — korekta po rejestracji to normalny tryb', () => {
    const dzisiejszy = zwrot({ utworzony_at: `${DZIS}T09:00:00.000Z` });
    expect(ostrzezeniaZwrotow({ zwroty: [dzisiejszy], dzis: DZIS })).toHaveLength(0);
  });
});

describe('ostrzezeniaIntegracji — z wyniku ocenZdrowie', () => {
  const zdrowe = () => ocenZdrowie({
    teraz: TERAZ,
    startAt: '2026-08-20T00:00:00.000Z',
    zrodla: ['woo_pro'],
    stanyPollera: [{ sklep: 'woo_pro', ostatni_przebieg_at: '2026-08-29T09:59:00.000Z', ostatni_blad: null }],
  });

  it('poller z błędem alarmuje treścią błędu PO POLSKU i kluczem źródła', () => {
    const zdrowie = ocenZdrowie({
      teraz: TERAZ,
      startAt: '2026-08-20T00:00:00.000Z',
      zrodla: ['woo_pro'],
      stanyPollera: [{ sklep: 'woo_pro', ostatni_przebieg_at: '2026-08-29T09:59:00.000Z', ostatni_blad: 'fetch failed' }],
    });
    const [w] = ostrzezeniaIntegracji({ zdrowie });
    expect(w.typ).toBe('integracja');
    expect(w.klucz).toBe('integracja:poller:woo_pro');
    expect(w.tekst).toContain('woo_pro');
    // ⚠️ ZGLOSZENIE WLASCICIELA 10.09.2026: „Poller allegro_amarka nie działa: The
    // operation was aborted due to timeout". Polska ramka, angielski srodek — bo srodek
    // pisze Node. Wiersz tabelki czyta czlowiek, wiec caly jest po polsku.
    expect(w.tekst).toContain('połączenie nie doszło do skutku');
    expect(w.tekst).not.toContain('fetch failed');
    expect(w.przycisk).toEqual({ href: '/ustawienia/lacznosc', etykieta: 'Łączność' });
    expect(w.etykietaOdrzucenia).toBe('Wycisz na 24 h');
  });

  it('timeout ze zgloszenia z 10.09.2026 czyta sie po polsku', () => {
    const zdrowie = ocenZdrowie({
      teraz: TERAZ,
      startAt: '2026-08-20T00:00:00.000Z',
      zrodla: ['allegro_amarka'],
      stanyPollera: [{
        sklep: 'allegro_amarka',
        ostatni_przebieg_at: '2026-08-29T09:59:00.000Z',
        ostatni_blad: 'The operation was aborted due to timeout',
        ostatni_blad_od_at: '2026-08-29T09:40:00.000Z',
        ostatni_blad_rodzaj: 'awaria',
        // Trzy nieudane przebiegi z rzedu — czyli nie czknieccie, tylko sprawa dla czlowieka.
        ostatni_blad_prob: 3,
      }],
    });
    const [w] = ostrzezeniaIntegracji({ zdrowie });
    expect(w.tekst).toBe('Poller allegro_amarka nie działa: przekroczony czas oczekiwania na odpowiedź');
  });

  it('⚠️ CZKNIECIE SIECI NIE MALUJE WIERSZA — usterki, ktora juz przeszla, nie pokazujemy', () => {
    // Dokladnie przypadek ze zgloszenia: jeden przebieg padl na timeout, nastepny (dwie
    // minuty pozniej) zgasil blad. Do 09.09.2026 tabelka zdazyla w tym oknie krzyknac,
    // a Ustawienia → Łączność mowily „wszystko ok" — dwie odpowiedzi na jednym panelu.
    const czknieccie = (proby) => ocenZdrowie({
      teraz: TERAZ,
      startAt: '2026-08-20T00:00:00.000Z',
      zrodla: ['allegro_amarka'],
      stanyPollera: [{
        sklep: 'allegro_amarka',
        ostatni_przebieg_at: '2026-08-29T09:59:00.000Z',
        ostatni_blad: 'The operation was aborted due to timeout',
        ostatni_blad_od_at: '2026-08-29T09:55:00.000Z',
        ostatni_blad_rodzaj: 'awaria',
        ostatni_blad_prob: proby,
      }],
    });
    expect(ostrzezeniaIntegracji({ zdrowie: czknieccie(1) })).toHaveLength(0);
    expect(ostrzezeniaIntegracji({ zdrowie: czknieccie(2) })).toHaveLength(0);
    // Trzeci nieudany przebieg z rzedu to juz nie czknieccie (decyzja wlasciciela 10.09.2026).
    expect(ostrzezeniaIntegracji({ zdrowie: czknieccie(3) })).toHaveLength(1);
  });

  it('⚠️ zegar STOJACY ze starym bledem mowi „stoi", a nie cytuje usterki, ktorej juz nie ma', () => {
    // Puls trzyma ostatni slad bledu takze po pozniejszym UDANYM przebiegu. Zdanie
    // „Czuwacz ostrzeżeń nie działa: <blad sprzed doby>" wskazywalo przyczyne nieaktualna
    // i przemilczalo prawdziwa — ze zegar po prostu stoi (zgloszenie 10.09.2026).
    const zdrowie = ocenZdrowie({
      teraz: TERAZ,
      startAt: '2026-08-20T00:00:00.000Z',
      zrodla: [],
      stanyPollera: [],
      ostrzezeniaWlaczone: true,
      pulsOstrzezen: {
        bladAt: '2026-08-28T05:00:00.000Z',
        blad: 'terminy płatności: inFakt nieosiągalny: The operation was aborted due to timeout',
        okAt: '2026-08-28T06:00:00.000Z', // sukces PO bledzie, ale sam sprzed doby
      },
    });
    const [w] = ostrzezeniaIntegracji({ zdrowie });
    expect(w.klucz).toBe('integracja:czuwacz-ostrzezen');
    expect(w.tekst).toContain('ostatni udany przebieg');
    expect(w.tekst).not.toContain('nie działa');
    expect(w.tekst).not.toContain('inFakt');
  });

  it('poller w postoju (bez błędu) alarmuje zdaniem o ostatnim przebiegu', () => {
    const zdrowie = ocenZdrowie({
      teraz: TERAZ,
      startAt: '2026-08-20T00:00:00.000Z',
      zrodla: ['woo_pro'],
      stanyPollera: [{ sklep: 'woo_pro', ostatni_przebieg_at: '2026-08-29T08:00:00.000Z', ostatni_blad: null }],
    });
    const [w] = ostrzezeniaIntegracji({ zdrowie });
    expect(w.klucz).toBe('integracja:poller:woo_pro');
    expect(w.tekst).toMatch(/ostatni przebieg .* temu/);
  });

  it('niezdrowy czuwacz KSeF alarmuje własnym kluczem', () => {
    const zdrowie = ocenZdrowie({
      teraz: TERAZ,
      startAt: '2026-08-20T00:00:00.000Z',
      zrodla: [],
      stanyPollera: [],
      ksefWlaczony: true,
      pulsKsef: { okAt: '2026-08-29T05:00:00.000Z', bladAt: '2026-08-29T09:00:00.000Z', blad: 'inFakt 500' },
    });
    const [w] = ostrzezeniaIntegracji({ zdrowie });
    expect(w.klucz).toBe('integracja:czuwacz-ksef');
    expect(w.tekst).toContain('inFakt 500');
  });

  it('niezdrowy czuwacz ostrzeżeń też alarmuje — stęchłe lustra mają krzyczeć', () => {
    const zdrowie = ocenZdrowie({
      teraz: TERAZ,
      startAt: '2026-08-20T00:00:00.000Z',
      zrodla: [],
      stanyPollera: [],
      ostrzezeniaWlaczone: true,
      pulsOstrzezen: { okAt: '2026-08-29T05:00:00.000Z', bladAt: '2026-08-29T09:00:00.000Z', blad: 'luki KSeF: inFakt 500' },
    });
    const [w] = ostrzezeniaIntegracji({ zdrowie });
    expect(w.klucz).toBe('integracja:czuwacz-ostrzezen');
    expect(w.tekst).toContain('inFakt 500');
  });

  it('kanały Allegro NIE wchodzą w ten typ — mają własny pas z wyjściem', () => {
    const zdrowie = ocenZdrowie({
      teraz: TERAZ,
      startAt: '2026-08-20T00:00:00.000Z',
      zrodla: ['woo_pro'],
      stanyPollera: [{ sklep: 'woo_pro', ostatni_przebieg_at: '2026-08-29T09:59:00.000Z', ostatni_blad: null }],
      kanaly: [{ kanal: 'allegro_szkicownia', zyje: false, pilne: true, powod: 'Kanał nie działa.' }],
    });
    expect(ostrzezeniaIntegracji({ zdrowie })).toHaveLength(0);
  });

  it('przy zdrowym panelu nie ma wierszy', () => {
    expect(ostrzezeniaIntegracji({ zdrowie: zdrowe() })).toHaveLength(0);
  });
});

describe('zlozOstrzezenia — odrzucenia, wygasanie, kolejność', () => {
  const wiersz = (typ, klucz) => ({
    typ, klucz, tekst: klucz, przycisk: { href: '/', etykieta: 'X' }, etykietaOdrzucenia: 'Ignoruj',
  });

  it('odrzucone ostrzeżenie trwałego typu znika na zawsze', () => {
    const odrzucone = new Map([['przesylka:1:a', '2026-07-01T00:00:00.000Z']]);
    const wynik = zlozOstrzezenia({
      wiersze: [wiersz('przesylka', 'przesylka:1:a'), wiersz('przesylka', 'przesylka:2:b')],
      odrzucone,
      teraz: TERAZ,
    });
    expect(wynik.map((w) => w.klucz)).toEqual(['przesylka:2:b']);
  });

  it('wyciszona integracja wraca po 24 godzinach', () => {
    const swiezo = new Map([['integracja:poller:woo_pro', '2026-08-29T09:59:00.000Z']]);
    const dawno = new Map([['integracja:poller:woo_pro', new Date(TERAZ.getTime() - WYGASANIE_INTEGRACJI_MS - 1).toISOString()]]);
    const wiersze = [wiersz('integracja', 'integracja:poller:woo_pro')];
    expect(zlozOstrzezenia({ wiersze, odrzucone: swiezo, teraz: TERAZ })).toHaveLength(0);
    expect(zlozOstrzezenia({ wiersze, odrzucone: dawno, teraz: TERAZ })).toHaveLength(1);
  });

  it('kolejność typów: integracje → KSeF → terminy → zwroty → paczki → wiadomości', () => {
    const wynik = zlozOstrzezenia({
      wiersze: [
        wiersz('wiadomosc-allegro', 'wiadomosc:a:b:c'),
        wiersz('przesylka', 'przesylka:1:a'),
        wiersz('zwrot-korekta', 'zwrot:9'),
        wiersz('faktura-termin', 'faktura-termin:2:141112'),
        wiersz('faktura-ksef', 'faktura-ksef:u-1'),
        wiersz('integracja', 'integracja:czuwacz-ksef'),
      ],
      odrzucone: new Map(),
      teraz: TERAZ,
    });
    expect(wynik.map((w) => w.typ)).toEqual([
      'integracja', 'faktura-ksef', 'faktura-termin', 'zwrot-korekta', 'przesylka', 'wiadomosc-allegro',
    ]);
  });
});

describe('kluczDozwolony — biała lista prefiksów dla trasy POST', () => {
  it.each([
    'faktura-ksef:u-1',
    'przesylka:7:2026-08-24T08:00:00.000Z',
    'wiadomosc:allegro_szkicownia:w-1:2026-08-29T06:30:00.000Z',
    'integracja:poller:woo_pro',
    'faktura-termin:2:141112',
    'zwrot:9',
  ])('przyjmuje %s', (klucz) => {
    expect(kluczDozwolony(klucz)).toBe(true);
  });

  it.each([
    ['pusty', ''],
    ['sam prefiks bez treści', 'przesylka:'],
    ['obcy typ', 'kosmos:1'],
    ['nie-napis', null],
  ])('odrzuca: %s', (_nazwa, klucz) => {
    expect(kluczDozwolony(klucz)).toBe(false);
  });

  it('odrzuca klucz dłuższy niż 300 znaków — śmieć nie wchodzi do bazy', () => {
    expect(kluczDozwolony(`przesylka:${'a'.repeat(300)}`)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PACZKA WRÓCIŁA, A FAKTURA ZOSTAŁA (31.08.2026)
//
// ⚠️⚠️ LUKA, KTÓRĄ TO ZAMYKA: czuwacz pobrań domyka pętlę pieniędzy w JEDNĄ stronę —
// paczka doręczona oznacza fakturę jako zapłaconą. Drugi biegun nie miał nikogo: paczka,
// która WRÓCIŁA, zostawia w KSeF fakturę dokumentującą dostawę, do której nie doszło.
// Anulować jej nie można (numer KSeF jest trwały), więc jedynym wyjściem jest korekta
// do zera — a o jej potrzebie panel dotąd milczał, dopóki człowiek sam nie zarejestrował
// zwrotu. Milczenie kosztuje tu VAT zapłacony od sprzedaży, której nie było.
describe('ostrzezeniaPobran — paczka bez gotówki przy wystawionej fakturze', () => {
  const kandydat = (nadpisz = {}) => ({
    zamowienie_id: 1259,
    zamowienie_numer: '1360',
    pobranie: 1,
    wysylka_reczna_json: null,
    faktura_numer: '60/08/2026',
    status_kuriera: 'Zwrot do nadawcy',
    status_kuriera_kod: null,
    status_kuriera_at: '2026-08-27T14:00:00.000',
    ...nadpisz,
  });

  it('zwrot do nadawcy alarmuje numerem zamówienia i numerem faktury', () => {
    const [w] = ostrzezeniaPobran({ pobrania: [kandydat()] });
    expect(w.typ).toBe('pobranie-korekta');
    expect(w.tekst).toContain('1360');
    expect(w.tekst).toContain('60/08/2026');
    expect(w.tekst).toMatch(/korekt/i);
    expect(w.przycisk).toEqual({ href: '/zamowienia/1259', etykieta: 'Zamówienie' });
  });

  // ⚠️ TA SAMA BRAMKA, CO W ŚCIEŻCE PIENIĘDZY (`czyPaczkaBezGotowki`). „Nie doręczono —
  // adresat nieobecny" wpada w `etapPrzesylki` jako `doreczona`, więc bez bezpiecznika
  // paczka bez gotówki wypadłaby z pola widzenia dokładnie wtedy, gdy wymaga człowieka.
  it('nieudane doręczenie („adresat nieobecny") też alarmuje', () => {
    const w = ostrzezeniaPobran({
      pobrania: [kandydat({ status_kuriera: 'Nie doręczono — adresat nieobecny' })],
    });
    expect(w).toHaveLength(1);
  });

  it('paczka doręczona MILCZY — pieniądze są u nas', () => {
    expect(ostrzezeniaPobran({
      pobrania: [kandydat({ status_kuriera: 'Przesyłka doręczona' })],
    })).toEqual([]);
  });

  it('paczka W DRODZE milczy — gotówki jeszcze nie ma, ale będzie', () => {
    expect(ostrzezeniaPobran({
      pobrania: [kandydat({ status_kuriera: 'Przesyłka w drodze' })],
    })).toEqual([]);
  });

  // Zamówienie bez pobrania: paczka wróciła, ale pieniądze przyszły przelewem przed
  // wysyłką — to sprawa zwrotu, nie tego ostrzeżenia.
  it('zamówienie BEZ pobrania milczy, choć paczka wróciła', () => {
    expect(ostrzezeniaPobran({
      pobrania: [kandydat({ pobranie: 0 })],
    })).toEqual([]);
  });

  // ⚠️ WARTOŚĆ EFEKTYWNA, NIE KOLUMNA — dokładnie jak w `czyPobranieRozliczone`.
  // Zamówienie przełączone RĘCZNIE na pobranie ma `pobranie = 0` w kolumnie.
  //
  // ⚠️ Nadpisanie MUSI nieść poprawną `metoda` z METODY_WYSYLKI — `odczytajNadpisanie`
  // (domain/wysylka.js) odrzuca obiekt bez niej i oddaje rządy kolumnie ze sklepu.
  // Fixture bez `metoda` przechodziłby więc gałęzią sklepową i nie sprawdzał niczego.
  it('ręczne nadpisanie na pobranie liczy się tak samo jak kolumna', () => {
    const w = ostrzezeniaPobran({
      pobrania: [kandydat({ pobranie: 0, wysylka_reczna_json: '{"metoda":"dpd","pobranie":true}' })],
    });
    expect(w).toHaveLength(1);
  });

  // Klucz niesie znacznik zdarzenia, więc RUCH PACZKI przywraca odrzucone ostrzeżenie —
  // ta sama zasada, co przy typie `przesylka`.
  it('klucz zmienia się razem ze zdarzeniem u kuriera', () => {
    const [a] = ostrzezeniaPobran({ pobrania: [kandydat()] });
    const [b] = ostrzezeniaPobran({
      pobrania: [kandydat({ status_kuriera_at: '2026-08-28T09:00:00.000' })],
    });
    expect(a.klucz).not.toBe(b.klucz);
    expect(a.klucz).toContain('1259');
  });

  it('uszkodzony wiersz nie zabiera pozostałych', () => {
    const w = ostrzezeniaPobran({ pobrania: [null, kandydat()] });
    expect(w).toHaveLength(1);
  });
});

describe('kluczDozwolony — prefiks pobrania', () => {
  it('przyjmuje klucz ostrzeżenia o pobraniu bez gotówki', () => {
    expect(kluczDozwolony('pobranie:1259:2026-08-27T14:00:00.000')).toBe(true);
  });
});
