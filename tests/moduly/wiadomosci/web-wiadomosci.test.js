import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszProforme } from '../../../src/moduly/faktury/db/proformy.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createPotwierdzenie } from '../../../src/moduly/wiadomosci/services/potwierdzenie.js';
import { wiadomosciZamowienia } from '../../../src/oms/db/wiadomosci.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
// ⚠️ TEN SAM FORMATER, KTÓRYM RENDERUJE WIDOK — asercja na dacie liczy oczekiwany napis
// tą samą funkcją, którą naprawia znalezisko 2 (schema.sql: znaczniki są w UTC, obcięcie
// napisu pokazałoby operatorowi godzinę o dwie wcześniejszą niż naprawdę).
import { fmtDataCzasKrotko } from '../../../src/domena/format-daty.js';

const config = {
  auth: { user: 'adam', pass: 'x' },
  sprzedawca: { nazwa: 'Lumina Marek Zywiecki' },
  proforma: { rachunek: '07 1090 1014 0000 0000 0000 0001' },
  nadawca: { nazwa: 'Lumina Marek Zywiecki' },
};

const zmapowane = (nad = {}) => ({
  zrodlo_id: 6001, numer: '202600014',
  klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'klient@firma.pl', company: 'BETAMET sp. z o.o.' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Fabryczna 4', postcode: '00-650', city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '990.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-21T09:15:00',
  termin_platnosci: '14',
  pozycje: [{
    zrodlo_id: 7001, nazwa: 'Szablon', sku: 'SZ-1', ilosc: 10,
    cena_brutto: '99.00', cena_netto: '80.49', brutto_linii: '990.00', netto_linii: '804.88', vat: null,
  }],
  ...nad,
});

function atrapaPoczty({ blad = null } = {}) {
  const wyslane = [];
  return { wyslane, sendMail: async (m) => { if (blad) throw new Error(blad); wyslane.push(m); return { messageId: 't' }; } };
}

let db, poczta, uslugi, wywolaniaPdfFaktury;
function zbuduj({ mailer = atrapaPoczty(), proformaPdf = null, fakturaBajty = null } = {}) {
  db = openOmsDb(':memory:');
  poczta = mailer;
  wywolaniaPdfFaktury = 0;
  uslugi = createWiadomosci({
    db, mailer,
    potwierdzenie: createPotwierdzenie({ db, mailer, sprzedawca: config.sprzedawca, teraz: () => '2026-08-22T10:00:00.000Z' }),
    proforma: proformaPdf ? { pdf: () => proformaPdf } : null,
    // ⚠️ LICZNIK WYWOŁAŃ — bez niego nic w suicie nie sprawdza, że PDF faktury pobiera się
    // z inFaktu DOKŁADNIE RAZ na jedno złożenie (patrz test „faktura: PDF pobierany raz").
    infakt: fakturaBajty
      ? { pobierzPdf: async () => { wywolaniaPdfFaktury += 1; return fakturaBajty; } }
      : null,
    config,
    teraz: () => '2026-08-22T10:00:00.000Z',
  });
  return uslugi;
}

beforeEach(() => { zbuduj(); });

describe('usługa wiadomości', () => {
  it('podgląd przypomnienia niesie adres, temat i obie postacie treści', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane());
    const p = await uslugi.podglad(id, 'przypomnienie');
    expect(p.do).toBe('klient@firma.pl');
    expect(p.temat).toContain('Przypomnienie o płatności');
    expect(p.html).toContain('990,00 zł');
    expect(p.tekst).toContain('Tytuł przelewu');
    expect(p.zalacznik).toBeNull();
  });

  it('podgląd odmawia z powodem, gdy tematu nie wolno wysłać', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane());
    await expect(uslugi.podglad(id, 'faktura')).rejects.toThrow(/Najpierw wystaw fakturę/);
  });

  it('wysyła i zapisuje ślad w rejestrze oraz w logu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane());
    const wynik = await uslugi.wyslij(id, 'przypomnienie', { ktoKlikal: 'adam' });
    expect(wynik.do).toBe('klient@firma.pl');
    expect(poczta.wyslane).toHaveLength(1);
    expect(poczta.wyslane[0].html).toContain('990,00 zł');
    expect(poczta.wyslane[0].text).toContain('DO ZAPŁATY');

    const rejestr = wiadomosciZamowienia(db, id);
    expect(rejestr).toHaveLength(1);
    expect(rejestr[0]).toMatchObject({ temat_id: 'przypomnienie', adresat: 'klient@firma.pl', kto: 'adam' });

    const log = db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);
    expect(log.at(-1).akcja).toBe('wiadomosc.wyslana');
    expect(log.at(-1).wynik).toContain('klient@firma.pl');
    // ⚠️ Log NIE niesie treści maila — czyta się go na głos przy reklamacji.
    expect(log.at(-1).wynik).not.toContain('Rachunek');
  });

  // ⚠️⚠️ NAJWAŻNIEJSZY TEST TEJ USŁUGI: nieudana wysyłka NIE MA PRAWA zostawić śladu
  // „wysłano". Odwrotna kolejność dawałaby kartę twierdzącą, że klient dostał maila,
  // którego nigdy nie było — i nikt by tego nie sprawdził.
  it('nieudana wysyłka nie zapisuje wpisu do rejestru', async () => {
    zbuduj({ mailer: atrapaPoczty({ blad: 'SMTP padł' }) });
    const id = zapiszZamowienie(db, 'pro', zmapowane());
    await expect(uslugi.wyslij(id, 'przypomnienie', { ktoKlikal: 'adam' })).rejects.toThrow('SMTP padł');
    expect(wiadomosciZamowienia(db, id)).toHaveLength(0);
    const log = db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);
    expect(log.at(-1).akcja).toBe('wiadomosc.blad');
    // ⚠️ CAŁY LOG, NIE TYLKO OSTATNI WPIS — sam „ostatni wpis to wiadomosc.blad" przepuściłby
    // mutację, która przenosi dopiszLog('wiadomosc.wyslana') PRZED sendMail: taki log miałby
    // DWA wpisy ([wysłana, błąd]), a asercja na `.at(-1)` dalej widziałaby tylko drugi z nich.
    expect(log.map((l) => l.akcja)).not.toContain('wiadomosc.wyslana');
  });

  it('potwierdzenie idzie starą usługą i też trafia do rejestru', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane());
    await uslugi.wyslij(id, 'potwierdzenie', { ktoKlikal: 'adam' });
    // PRAWDZIWA usługa potwierdzenia wysyła naprawdę (przez atrapę poczty) — inaczej test
    // sprawdzałby atrapę usługi, a nie to, że obie drogi zapisują ślad.
    expect(poczta.wyslane).toHaveLength(1);
    // ⚠️ DŁUGOŚĆ REJESTRU SPRAWDZONA PRZED temat_id — inaczej podwójny zapis (gdyby
    // services/wiadomosci.js dopisał TU JESZCZE WŁASNY zapiszWiadomosc obok delegacji)
    // przechodzi niezauważony: [0].temat_id jest 'potwierdzenie' także wtedy, gdy wierszy
    // jest dwa. To dokładnie błąd, przed którym ostrzega reszta tego pliku.
    expect(wiadomosciZamowienia(db, id)).toHaveLength(1);
    expect(wiadomosciZamowienia(db, id)[0].temat_id).toBe('potwierdzenie');
  });

  // ⚠️ PUŁAPKA WPROST Z BRIEFU: numer dokumentu ma ukośniki („PF/1/08/2026"). Bez
  // `bezpiecznaNazwa` ukośnik stałby się separatorem katalogu — klient dostałby błąd zapisu
  // albo plik pod inną ścieżką, niż panel myśli, że zapisał. Sprawdzone w TRZECH miejscach,
  // bo każde z nich mogłoby po cichu zgubić sanityzację niezależnie od pozostałych.
  it('proforma: załącznik ma bezpieczną nazwę z numeru z ukośnikami — w mailu, w rejestrze i w logu', async () => {
    zbuduj({ proformaPdf: { bajty: Buffer.from('%PDF-proforma'), numer: 'PF/1/08/2026' } });
    const id = zapiszZamowienie(db, 'pro', zmapowane());
    zapiszProforme(db, id, {
      kwotaBrutto: '990.00', plikSciezka: '/dane/proformy/fake.pdf', utworzonaAt: '2026-08-20T10:00:00.000Z',
    });

    await uslugi.wyslij(id, 'proforma', { ktoKlikal: 'adam' });

    expect(poczta.wyslane[0].attachments).toHaveLength(1);
    expect(poczta.wyslane[0].attachments[0].filename).toBe('Proforma_PF_1_08_2026.pdf');

    const rejestr = wiadomosciZamowienia(db, id);
    expect(rejestr[0].zalacznik).toBe('Proforma_PF_1_08_2026.pdf');

    const log = db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);
    expect(log.at(-1).wynik).toContain('Proforma_PF_1_08_2026.pdf');
  });

  it('faktura: PDF pobierany z inFaktu dokładnie raz na jedno złożenie, nazwa przez bezpiecznaNazwa', async () => {
    zbuduj({ fakturaBajty: Buffer.from('%PDF-faktura') });
    const id = zapiszZamowienie(db, 'pro', zmapowane());
    db.prepare(
      'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)',
    ).run(id, 'uuid-real-1', 'FV/12/08/2026', '2026-08-21T09:00:00.000Z');

    await uslugi.wyslij(id, 'faktura', { ktoKlikal: 'adam' });

    // ⚠️ NA ŚWIEŻO Z INFAKTU, DOKŁADNIE RAZ — nie z kopii i nie dwukrotnie przy jednym
    // złożeniu treści (podgląd i wysyłka to dwa OSOBNE złożenia, ale jedno złożenie ma
    // pobrać PDF raz, nie przy każdym odczycie załączników wewnątrz `zloz`).
    expect(wywolaniaPdfFaktury).toBe(1);
    expect(poczta.wyslane[0].attachments[0].filename).toBe('Faktura_FV_12_08_2026.pdf');
  });

  it('przypomnienie z aktualną proformą dokłada jej PDF i zdanie o załączniku z tym samym numerem', async () => {
    zbuduj({ proformaPdf: { bajty: Buffer.from('%PDF-proforma'), numer: 'PF/1/08/2026' } });
    const id = zapiszZamowienie(db, 'pro', zmapowane());
    zapiszProforme(db, id, {
      kwotaBrutto: '990.00', plikSciezka: '/dane/proformy/fake.pdf', utworzonaAt: '2026-08-20T10:00:00.000Z',
    });

    await uslugi.wyslij(id, 'przypomnienie', { ktoKlikal: 'adam' });

    expect(poczta.wyslane[0].attachments).toHaveLength(1);
    expect(poczta.wyslane[0].attachments[0].filename).toBe('Proforma_PF_1_08_2026.pdf');
    // ⚠️ SPAROWANIE FAKTU Z TREŚCIĄ: zdanie ma nazywać TEN SAM numer, który naprawdę jedzie
    // w kopercie — mail zapowiadający dokument, którego nie ma w załączniku, jest gorszy niż
    // mail bez dokumentu.
    expect(poczta.wyslane[0].text).toContain('W załączeniu proforma PF/1/08/2026.');
  });

  it('przypomnienie bez proformy idzie bez załącznika i bez zdania o nim', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane());
    await uslugi.wyslij(id, 'przypomnienie', { ktoKlikal: 'adam' });
    expect(poczta.wyslane[0].attachments).toBeUndefined();
    expect(poczta.wyslane[0].text).not.toContain('W załączeniu proforma');
  });

  // ⚠️⚠️ ZNALEZISKO RECENZJI CAŁOŚCI GAŁĘZI (22.08.2026, styk usługi i domeny): reguła
  // „proforma → faktura → numer zamówienia" stoi w TRZECH miejscach (makieta zatwierdzona,
  // oba komentarze przy `modelWiadomosci` w wiadomosc-platnicza.js), ale `dokument` liczony
  // TU, w usłudze, dotąd realizował wyłącznie „proforma → numer zamówienia" — faktura nigdy
  // tu nie trafiała. Realny scenariusz: zamówienie B2B z fakturą i terminem 14 dni, BEZ
  // proformy (typowa ścieżka B2B). Faktura prosiła o przelew z tytułem FV/…, przypomnienie
  // trzy dni później — z tytułem NUMERU ZAMÓWIENIA. Dwa maile o tym samym długu, dwa różne
  // tytuły, a księgowość dopasowuje wpłatę po numerze dokumentu.
  it('przypomnienie z fakturą i BEZ proformy: tytuł przelewu to numer faktury, bez załącznika i bez zdania o nim', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane());
    db.prepare(
      'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)',
    ).run(id, 'uuid-real-2', 'FV/9/08/2026', '2026-08-19T09:00:00.000Z');

    await uslugi.wyslij(id, 'przypomnienie', { ktoKlikal: 'adam' });

    expect(poczta.wyslane[0].text).toContain('Tytuł przelewu: FV/9/08/2026');
    // ⚠️ SPAROWANIE FAKTU Z TREŚCIĄ, odwrotna strona tego samego testu co przy proformie
    // wyżej: faktury do przypomnienia NIE DOKŁADAMY (klient dostał ją już własnym mailem,
    // drugi egzemplarz dokumentu księgowego tylko myli) — skoro w kopercie nie ma żadnego
    // pliku, zdanie „W załączeniu proforma …" ma milczeć, a nie nazywać proformą fakturę.
    expect(poczta.wyslane[0].attachments).toBeUndefined();
    expect(poczta.wyslane[0].text).not.toContain('W załączeniu proforma');
  });

  // Zachowanie sprzed poprawki MUSI przeżyć: gdy proforma JEST, wygrywa ona — nawet gdy
  // zamówienie ma też fakturę. Bez tego testu literówka w kolejności (`k.faktura ?? k.proforma`
  // zamiast `k.proforma ?? k.faktura`) przeszłaby całą resztę suity niezauważona, bo żaden
  // inny test nie stawia obu dokumentów jednocześnie.
  it('przypomnienie z fakturą I proformą: proforma wygrywa w tytule przelewu', async () => {
    // ⚠️ NUMER PROFORMY W TYTULE POCHODZI Z WIERSZA `proformy` (zapiszProforme go nadaje
    // sam, sekwencyjnie — PIERWSZA proforma w świeżej bazie za sierpień 2026 zawsze dostaje
    // „PF/1/08/2026"), NIE z atrapy `proforma.pdf()` niżej — ta odpowiada wyłącznie za bajty
    // i nazwę PLIKU załącznika. Obie wartości muszą się tu zgadzać, żeby test w ogóle miał
    // sens, więc atrapa dostaje TEN SAM numer, jakiego użyje `zapiszProforme`.
    zbuduj({ proformaPdf: { bajty: Buffer.from('%PDF-proforma'), numer: 'PF/1/08/2026' } });
    const id = zapiszZamowienie(db, 'pro', zmapowane());
    zapiszProforme(db, id, {
      kwotaBrutto: '990.00', plikSciezka: '/dane/proformy/fake.pdf', utworzonaAt: '2026-08-20T10:00:00.000Z',
    });
    db.prepare(
      'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)',
    ).run(id, 'uuid-real-3', 'FV/9/08/2026', '2026-08-21T09:00:00.000Z');

    await uslugi.wyslij(id, 'przypomnienie', { ktoKlikal: 'adam' });

    expect(poczta.wyslane[0].text).toContain('Tytuł przelewu: PF/1/08/2026');
    expect(poczta.wyslane[0].text).toContain('W załączeniu proforma PF/1/08/2026.');
  });
});

// ⚠️ TEST OKABLOWANIA, a nie usługi: pilnuje DROGI od `buildOmsServer` do karty zamówienia.
// Usługa może być zbudowana i przetestowana co do joty, a mimo to nie dojść do tras — i wtedy
// cała suita świeci na zielono, a na produkcji sekcji po prostu NIE MA. Ta klasa cichej awarii
// zdarzyła się w tym projekcie już przy `fakturaAllegro`, `fakturyWidok` i `wysylkaKsef`.
describe('okablowanie', () => {
  it('serwer przyjmuje usługę wiadomości i karta pokazuje sekcję', async () => {
    const bazaTestowa = openOmsDb(':memory:');
    const id = zapiszZamowienie(bazaTestowa, 'pro', zmapowane());
    const app = buildOmsServer({
      db: bazaTestowa, config, poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) },
      wiadomosci: createWiadomosci({ db: bazaTestowa, mailer: atrapaPoczty(), config, teraz: () => '2026-08-22T10:00:00.000Z' }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'GET', url: `/zamowienia/${id}`,
      headers: { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Wyślij nową wiadomość');
  });
});

describe('trasy sekcji wiadomości', () => {
  let app, bazaW, idZ;
  const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };

  beforeEach(async () => {
    bazaW = openOmsDb(':memory:');
    idZ = zapiszZamowienie(bazaW, 'pro', zmapowane());
    app = buildOmsServer({
      db: bazaW, config, poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) },
      wiadomosci: createWiadomosci({ db: bazaW, mailer: atrapaPoczty(), config, teraz: () => '2026-08-22T10:00:00.000Z' }),
    });
    await app.ready();
  });

  const karta = (q = '') => app.inject({ method: 'GET', url: `/zamowienia/${idZ}${q}`, headers: naglowek });

  it('spoczynek: przycisk i lista wysłanych, bez podglądu', async () => {
    const res = await karta();
    expect(res.body).toContain('Wyślij nową wiadomość');
    expect(res.body).not.toContain('Wybierz temat');
  });

  // ⚠️⚠️ PIĄTA FAŁSZYWA ZIELEŃ TEJ GAŁĘZI (recenzja całości gałęzi, 22.08.2026). Do tej pory
  // stało tu gołe `toContain('Proforma')` — a ten napis jest na KAŻDYM renderze karty,
  // w metryczce dokumentów (zamowienie.ejs: wiersz „Proforma" i zdanie „Proforma: data
  // dzisiejsza…"). Test przechodził więc także wtedy, gdy lista tematów renderowała się
  // PUSTA. Czwarty temat, „Faktura", nie był asertowany w ogóle.
  //
  // Kotwiczymy w ZNACZNIKU WIERSZA TEMATU (`<span class="temat-nazwa">…`), którego nic poza
  // tą listą nie drukuje.
  it('?wiadomosc=nowa pokazuje cztery tematy', async () => {
    const res = await karta('?wiadomosc=nowa');
    expect(res.body).toContain('Wybierz temat');
    expect(res.body).toContain('<span class="temat-nazwa">Potwierdzenie przyjęcia zamówienia</span>');
    expect(res.body).toContain('<span class="temat-nazwa">Proforma</span>');
    expect(res.body).toContain('<span class="temat-nazwa">Faktura</span>');
    expect(res.body).toContain('<span class="temat-nazwa">Przypomnienie o płatności</span>');
  });

  // ⚠️ DRUGA POŁOWA TEGO SAMEGO: test wyżej dowodzi, że wiersz „Faktura" W OGÓLE jest, a test
  // „temat zablokowany…" niżej — że przy braku faktury NIE jest odnośnikiem. Nic w suicie nie
  // dowodziło dotąd, że przy fakturze WYSTAWIONEJ ten wiersz staje się klikalny i mówi, co
  // pojedzie — czyli że ścieżka „mam fakturę, wysyłam ją klientowi" w ogóle istnieje.
  it('temat „Faktura" jest klikalnym wierszem ze stanem, gdy faktura JEST wystawiona', async () => {
    bazaW.prepare(
      'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)',
    ).run(idZ, 'uuid-real-9', 'FV/12/08/2026', '2026-08-21T09:00:00.000Z');

    const res = await karta('?wiadomosc=nowa');
    expect(res.body).toMatch(
      /<a class="temat" href="\?wiadomosc=faktura#wiadomosci">\s*<span class="temat-nazwa">Faktura<\/span>/,
    );
    expect(res.body).toContain('FV/12/08/2026 · PDF z inFaktu');
    expect(res.body).not.toContain('Najpierw wystaw fakturę');
  });

  // ⚠️ Temat zablokowany NIE JEST odnośnikiem — inaczej operator klika i dostaje 400
  // zamiast dowiedzieć się, czego brakuje.
  it('temat zablokowany pokazuje powód i nie jest odnośnikiem', async () => {
    const res = await karta('?wiadomosc=nowa');
    expect(res.body).toContain('Najpierw wystaw fakturę');
    expect(res.body).not.toContain(`?wiadomosc=faktura`);
  });

  it('?wiadomosc=przypomnienie pokazuje podgląd z adresem i tematem', async () => {
    const res = await karta('?wiadomosc=przypomnienie');
    // ⚠️ ZAKOTWICZONE W LIŚCIE `<dl class="dane">` PODGLĄDU (recenzja 22.08.2026), nie gołe
    // `toContain`: karta drukuje adres klienta w danych do wysyłki na KAŻDYM renderze, więc
    // `toContain` przechodziłby nawet gdyby ten konkretny podgląd w ogóle nie pokazał adresata.
    expect(res.body).toMatch(/<dt>Do<\/dt>\s*<dd>klient@firma\.pl<\/dd>/);
    expect(res.body).toContain('Przypomnienie o płatności — zamówienie nr');
    expect(res.body).toContain('srcdoc');
  });

  // ⚠️ MAIL JEST KOMPLETNYM DOKUMENTEM (własny <html>, własne tło, style inline). Wpuszczony
  // wprost w kartę pomieszałby się z jej stylami i pokazałby coś, czego klient nigdy nie
  // zobaczy — a cała wartość podglądu polega na tym, że pokazuje to, co pójdzie. Ta sama
  // asercja stoi przy podglądzie potwierdzenia (tests/oms/web-potwierdzenie.test.js).
  it('podgląd siedzi w RAMCE sandbox, a nie wklejony w kartę', async () => {
    const res = await karta('?wiadomosc=przypomnienie');
    expect(res.body).toMatch(/<iframe[^>]*sandbox[^>]*srcdoc=/);
    // Dokument maila NIE MOŻE wyjść poza atrybut — gdyby wyszedł, strona miałaby dwa <html>.
    expect(res.body.match(/<html/g)).toHaveLength(1);
  });

  it('?wiadomosc=faktura bez faktury pokazuje powód, nie 500', async () => {
    const res = await karta('?wiadomosc=faktura');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Najpierw wystaw fakturę');
  });

  it('POST wysyła i wraca na kartę', async () => {
    const res = await app.inject({ method: 'POST', url: `/zamowienia/${idZ}/wiadomosc/przypomnienie`, headers: naglowek });
    expect(res.statusCode).toBe(302);
    expect(wiadomosciZamowienia(bazaW, idZ)).toHaveLength(1);
  });

  // ⚠️⚠️ LUKA W POKRYCIU DOMKNIĘTA (recenzja 22.08.2026, Zadanie 10 — część B). Test wyżej
  // sprawdza tylko status 302 i długość rejestru — NIGDY nie ogląda karty PO przeładowaniu.
  // Niesprawdzone zostawały: tabela „Wysłane" dla tematu innego niż potwierdzenie, ostrzeżenie
  // „Ta wiadomość poszła już…" i etykieta „Wyślij ponownie" na przycisku. To jest JEDYNY
  // hamulec przed wysłaniem DRUGIEGO maila do tego samego klienta — a maila nie da się cofnąć.
  it('po wysłaniu karta ostrzega przed drugim mailem i pokazuje wpis w „Wysłane"', async () => {
    const wyslano = await app.inject({ method: 'POST', url: `/zamowienia/${idZ}/wiadomosc/przypomnienie`, headers: naglowek });
    expect(wyslano.statusCode).toBe(302);

    // Ten sam temat otwarty PONOWNIE (np. operator wraca do niego z historii przeglądarki)
    // ma ostrzec, że mail już poszedł, i przezwać przycisk na „Wyślij ponownie".
    const podglad = (await karta('?wiadomosc=przypomnienie')).body;
    expect(podglad).toMatch(/Ta wiadomość poszła już/);
    expect(podglad).toContain('Wyślij ponownie');

    // I na karcie W SPOCZYNKU, BEZ ponownego otwierania tematu — wpis ma być widoczny
    // w tabeli „Wysłane" od razu, inaczej operator sprawdzający historię z góry karty nie ma
    // jak się dowiedzieć, że mail już wyszedł. Zakotwiczone w komórkach tabeli (nie gołe
    // `toContain`), z tego samego powodu co poprawka adresu wyżej w tym pliku.
    const spoczynek = (await karta()).body;
    expect(spoczynek).toMatch(/<p class="etykieta-bloku">Wysłane<\/p>/);
    expect(spoczynek).toMatch(/<td>Przypomnienie o płatności<\/td>/);
    expect(spoczynek).toMatch(/<td>klient@firma\.pl<\/td>/);
  });

  // ⚠️⚠️ ZNALEZISKO RECENZJI CAŁOŚCI GAŁĘZI (22.08.2026, styk trasy i starej kolumny). Schema.sql
  // obiecuje wprost: `potwierdzenie_wyslane_at` „ZOSTAJE i dalej jest zapisywana […] karta ma
  // mówić prawdę także o mailach wysłanych PRZED powstaniem rejestru" — ale `daneWiadomosci`
  // czytał WYŁĄCZNIE rejestr `wiadomosci`, który istnieje dopiero od 22.08.2026. Zamówienie
  // potwierdzone WCZEŚNIEJ (rejestru wtedy jeszcze nie było) traciło JEDYNY hamulec przed
  // wysłaniem klientowi DRUGIEGO potwierdzenia: ekran wyboru mówił „jeszcze nie wysłane",
  // podgląd nie pokazywał paska „Ta wiadomość poszła już…", a przycisk „Wyślij" zamiast
  // „Wyślij ponownie" — a maila nie da się cofnąć.
  it('zamówienie potwierdzone PRZED powstaniem rejestru: stara kolumna działa jako rezerwa', async () => {
    bazaW.prepare('UPDATE zamowienia SET potwierdzenie_wyslane_at = ? WHERE id = ?')
      .run('2026-08-21T12:40:00.000Z', idZ);
    // Rejestr milczy — dokładnie scenariusz z briefu: potwierdzone ZANIM rejestr zaczął
    // cokolwiek zapisywać.
    expect(wiadomosciZamowienia(bazaW, idZ)).toHaveLength(0);

    // Ekran wyboru: temat „Potwierdzenie" ma mówić „wysłane…", nie kłamać „jeszcze nie wysłane".
    const wybor = (await karta('?wiadomosc=nowa')).body;
    expect(wybor).not.toContain('jeszcze nie wysłane');
    expect(wybor).toContain(`wysłane ${fmtDataCzasKrotko('2026-08-21T12:40:00.000Z')}`);

    // Ekran podglądu (druga, NIEZALEŻNA droga do tej samej odpowiedzi — liczy z `w.lista`,
    // nie z tematów wyżej): pasek ostrzeżenia z TĄ SAMĄ datą i „Wyślij ponownie" na przycisku.
    const podglad = (await karta('?wiadomosc=potwierdzenie')).body;
    expect(podglad).toMatch(/Ta wiadomość poszła już/);
    expect(podglad).toContain(fmtDataCzasKrotko('2026-08-21T12:40:00.000Z'));
    expect(podglad).toContain('Wyślij ponownie');
  });

  it('POST na zablokowany temat odmawia z powodem', async () => {
    const res = await app.inject({ method: 'POST', url: `/zamowienia/${idZ}/wiadomosc/faktura`, headers: naglowek });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Najpierw wystaw fakturę');
  });

  // ⚠️⚠️ ASYMETRIA ŚLADU DOMKNIĘTA (recenzja całości gałęzi, 22.08.2026 — najpoważniejsza
  // z odłożonych). `try/catch` obejmował WYŁĄCZNIE `sendMail`, a złożenie treści stało poza
  // nim: padnięty inFakt, zniknięty plik proformy i odmowa domeny oddawały operatorowi 400
  // i ZERO śladu na karcie. „Kliknąłem, coś mrugnęło, karta pusta" to dokładnie ten stan,
  // którego reszta modułu unika.
  it('nieudane złożenie zostawia ślad w logu — i NIE twierdzi, że cokolwiek wysyłano', async () => {
    const res = await app.inject({ method: 'POST', url: `/zamowienia/${idZ}/wiadomosc/faktura`, headers: naglowek });
    expect(res.statusCode).toBe(400);

    const log = bazaW.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(idZ);
    expect(log.at(-1).akcja).toBe('wiadomosc.nieudane-zlozenie');
    expect(log.at(-1).wynik).toContain('Najpierw wystaw fakturę');
    expect(log.at(-1).wynik).toContain('Faktura');
    // ⚠️ OSOBNA AKCJA, NIE `wiadomosc.blad`. Tamten wpis mówi „BŁĄD wysyłki … do <adres>",
    // czyli opisuje maila, którego PRÓBOWANO wysłać — a tu nie próbowano niczego i nie ma
    // nawet adresata. Wpis „BŁĄD wysyłki" przy mailu, którego nikt nie składał, byłby drugą
    // odmianą tego samego kłamstwa, przed którym broni cała reszta tego pliku.
    expect(log.map((l) => l.akcja)).not.toContain('wiadomosc.blad');
    expect(log.map((l) => l.akcja)).not.toContain('wiadomosc.wyslana');
    expect(log.at(-1).wynik).not.toContain('klient@firma.pl');
  });

  // PRZ-074 (14.10.2026, prośba właściciela): komentarz wewnętrzny wrócił NAD Pozycje, obok uwag
  // klienta — do tej pory test pilnował odwrotnego miejsca (przy wiadomościach, decyzja 22.08).
  it('komentarz wewnętrzny stoi nad Pozycjami, a nie przy wiadomościach', async () => {
    const res = await karta();
    const iKomentarz = res.body.indexOf('id="komentarz"');
    const iPozycje = res.body.indexOf('id="pozycje"');
    expect(iKomentarz).toBeGreaterThan(0);
    expect(iKomentarz).toBeLessThan(iPozycje);
    expect(res.body.indexOf(`action="/zamowienia/${idZ}/komentarz"`)).toBeLessThan(iPozycje);
  });

  // ⚠️⚠️ KOMENTARZ WEWNĘTRZNY NIE ZALEŻY OD POCZTY — a przez przenosiny na dół karty łatwo
  // go w tę zależność wpuścić (pierwsza wersja tej zmiany to zrobiła). Panel bez skonfigurowanej
  // poczty ma DALEJ pokazywać pole notatki: inaczej pierwszej notatki nie ma jak założyć,
  // a stara notatka znika z ekranu bez śladu. Pilnuje tego też tests/oms/web-komentarz.test.js,
  // ale tam nikt nie wie, że pole zjechało do `_wiadomosci.ejs` — tutaj wiadomo.
  it('bez usługi wiadomości sekcja znika, ale komentarz wewnętrzny ZOSTAJE', async () => {
    const bezPoczty = buildOmsServer({
      db: bazaW, config, poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) },
    });
    await bezPoczty.ready();
    const res = await bezPoczty.inject({ method: 'GET', url: `/zamowienia/${idZ}`, headers: naglowek });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Wyślij nową wiadomość');
    // PRZ-074: bez notatki pole jest zwinięte pod „+ Dodaj komentarz wewnętrzny" (małą literą);
    // nagłówek „Komentarz wewnętrzny" stoi tylko przy zapisanej notatce. Sens testu — pole jest
    // ZAWSZE — niesie adres formularza i <textarea> poniżej.
    expect(res.body).toContain('Dodaj komentarz wewnętrzny');
    expect(res.body).toContain(`/zamowienia/${idZ}/komentarz`);
    expect(res.body).toMatch(/<textarea[^>]*name="komentarz"/);
  });

  // ⚠️ DOKŁADNIE JEDNO POLE PISZĄCE DO KOLUMNY `komentarz_wewnetrzny`. Blok 4b był
  // PRZENOSINAMI, nie kopią: dwa pola na jedną kolumnę rozjechałyby się przy pierwszym
  // zapisie — operator wpisuje notatkę w górne pole, przeglądarka wysyła formularz z pustym
  // dolnym i notatka znika, bez błędu i bez śladu.
  //
  // ⚠️ LICZYMY TRASĘ, NIE `name="komentarz"`: karta ma DRUGIE, niespokrewnione pole o tej
  // samej nazwie — komentarz do przesyłki nadanej poza panelem (`/przesylki/reczna`).
  // Zliczanie po samej nazwie dawałoby tu 2 niezależnie od tego, ile jest pól notatki.
  it('karta ma dokładnie jedno pole komentarza wewnętrznego', async () => {
    const res = await karta();
    expect(res.body.match(new RegExp(`action="/zamowienia/${idZ}/komentarz"`, 'g'))).toHaveLength(1);
    expect(res.body.match(/<textarea[^>]*name="komentarz"/g)).toHaveLength(1);
  });
});

// ⚠️⚠️ TRZY WSTRZYKNIĘTE USŁUGI, TRZY STRAŻNIKI (recenzja całości gałęzi, 22.08.2026).
// `proforma`, `infakt` i `potwierdzenie` mają w `createWiadomosci` domyślne `null`, a ekran
// wyboru pokazuje odpowiadające im tematy jako DOSTĘPNE — bariera domeny pyta o wiersz
// w bazie (proforma, faktura z uuid i numerem), a nie o to, czy usługa jest podpięta.
// Bez strażników operator dostawał `TypeError` opakowany w „Wiadomość NIE została wysłana:
// Cannot read properties of null" — zdanie, z którego nie wynika ani co jest zepsute, ani
// gdzie to naprawić.
//
// ⚠️ UKŁAD Z PRODUKCJI, NIE WYMYŚLONY: panel ma pocztę (więc `wiadomosci` powstaje), ale nie
// ma katalogu proform ani sekcji `INFAKT_*` — i ma w bazie dokumenty sprzed tej zmiany.
describe('brakująca usługa: powód dla operatora, nigdy TypeError', () => {
  let app, baza, idZ;
  const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };

  beforeEach(async () => {
    baza = openOmsDb(':memory:');
    idZ = zapiszZamowienie(baza, 'pro', zmapowane());
    app = buildOmsServer({
      db: baza, config, poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) },
      // BEZ `proforma`, BEZ `infakt`, BEZ `potwierdzenie` — same domyślne `null`.
      wiadomosci: createWiadomosci({ db: baza, mailer: atrapaPoczty(), config, teraz: () => '2026-08-22T10:00:00.000Z' }),
    });
    await app.ready();
  });

  const wyslij = (temat) => app.inject({ method: 'POST', url: `/zamowienia/${idZ}/wiadomosc/${temat}`, headers: naglowek });
  const log = () => baza.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(idZ);

  // ⚠️ `not.toContain('błąd techniczny panelu')` JEST TU SEDNEM, nie ozdobą: dokładnie to
  // zdanie oddaje `komunikatDlaOperatora` każdemu błędowi BEZ `dlaOperatora` — czyli także
  // `TypeError`-owi sprzed poprawki. Bez tej asercji test przechodziłby też wtedy, gdyby
  // strażnika nie było wcale, a 400 niósł techniczny bełkot.
  it('proforma bez usługi proform', async () => {
    zapiszProforme(baza, idZ, {
      kwotaBrutto: '990.00', plikSciezka: '/dane/proformy/fake.pdf', utworzonaAt: '2026-08-20T10:00:00.000Z',
    });
    const res = await wyslij('proforma');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('usługi proform');
    expect(res.body).not.toContain('błąd techniczny panelu');
    expect(log().at(-1).akcja).toBe('wiadomosc.nieudane-zlozenie');
  });

  it('faktura bez połączenia z inFaktem', async () => {
    baza.prepare(
      'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)',
    ).run(idZ, 'uuid-stary', 'FV/1/07/2026', '2026-07-11T09:00:00.000Z');
    const res = await wyslij('faktura');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('połączenia z inFaktem');
    expect(res.body).not.toContain('błąd techniczny panelu');
    expect(log().at(-1).akcja).toBe('wiadomosc.nieudane-zlozenie');
  });

  it('potwierdzenie bez usługi potwierdzeń', async () => {
    const res = await wyslij('potwierdzenie');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('usługi potwierdzeń');
    expect(res.body).not.toContain('błąd techniczny panelu');
    expect(log().at(-1).akcja).toBe('wiadomosc.nieudane-zlozenie');
  });

  // ⚠️ ODMOWA MA TRAFIĆ NA EKRAN JUŻ W PODGLĄDZIE, zanim operator kliknie „Wyślij" — inaczej
  // dowiaduje się o brakującej usłudze dopiero po kliknięciu operacji nieodwracalnej.
  it('powód widać już w podglądzie na karcie, nie dopiero po kliknięciu', async () => {
    zapiszProforme(baza, idZ, {
      kwotaBrutto: '990.00', plikSciezka: '/dane/proformy/fake.pdf', utworzonaAt: '2026-08-20T10:00:00.000Z',
    });
    const res = await app.inject({ method: 'GET', url: `/zamowienia/${idZ}?wiadomosc=proforma`, headers: naglowek });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('usługi proform');
  });
});
