import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { createPotwierdzenie } from '../../../src/moduly/wiadomosci/services/potwierdzenie.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { wiadomosciZamowienia } from '../../../src/oms/db/wiadomosci.js';

// POTWIERDZENIE PRZYJĘCIA ZAMÓWIENIA — USŁUGA I ŚLAD PO NIEJ (21.08.2026, przepisane
// 22.08.2026 przy sprzątaniu po recenzji całości gałęzi).
//
// ⚠️⚠️ CO SIĘ TU ZMIENIŁO I DLACZEGO. Do 22.08 ten plik pukał do WŁASNEGO ekranu potwierdzenia
// (`GET/POST /zamowienia/:id/potwierdzenie` + `potwierdzenie-podglad.ejs`). Ten ekran był po
// przenosinach paska OSIEROCONY — nie prowadził do niego ani jeden odnośnik w panelu — i został
// usunięty. Testy, które pilnowały WYŁĄCZNIE tamtego ekranu (że pokazuje ramkę `srcdoc`, że mail
// nie wycieka poza atrybut), zniknęły razem z nim: ich odpowiedniki dla JEDYNEJ dziś drogi
// stoją w tests/oms/web-wiadomosci.test.js.
//
// ⚠️ ZOSTAJE WSZYSTKO, CO DOTYCZY USŁUGI, a nie ekranu: zapis do rejestru, wpis w logu,
// kolejność „nieudana wysyłka nie zostawia śladu wysłano" i trzy odmowy domeny (anulowane,
// bez adresu, bez pozycji). Te niezmienniki nie mają nic wspólnego z tym, który przycisk je
// wywołał — i muszą przeżyć każdą kolejną przeprowadzkę interfejsu.
//
// ⚠️ DROGA WYWOŁANIA TO DZIŚ SEKCJA „WIADOMOŚCI": POST /zamowienia/:id/wiadomosc/potwierdzenie
// → services/wiadomosci.js → DELEGACJA do services/potwierdzenie.js. Testujemy tędy CELOWO,
// bo to jedyna droga, którą naprawdę klika operator.

const config = { auth: { user: 'adam', pass: 'x' }, sprzedawca: { nazwa: 'Lumina Marek Zywiecki' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-08-21T09:00:00', ostatni_blad: null }) };

const zmapowane = (nad = {}) => ({
  zrodlo_id: 6001, numer: '202600014',
  klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'klient@firma.pl', company: 'BETAMET sp. z o.o.' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', company: 'BETAMET sp. z o.o.', address_1: 'Fabryczna 4', postcode: '00-650', city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '243.70', koszt_dostawy_brutto: '19.00', koszt_dostawy_netto: '15.45',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-21T09:15:00',
  pozycje: [{
    zrodlo_id: 7001, nazwa: 'Lampa stołowa Grzybek 30x45', sku: 'LMP-GRZ-30', ilosc: 3,
    cena_brutto: '74.90', cena_netto: '60.89', brutto_linii: '224.70', netto_linii: '182.68', vat: null,
  }],
  ...nad,
});

// ⚠️ ATRAPA POCZTY, NIGDY PRAWDZIWY SMTP. Test, ktory wysyla maila, wysyla go do KOGOS —
// a tu w danych stoi adres wygladajacy jak prawdziwy.
function atrapaPoczty({ blad = null } = {}) {
  const wyslane = [];
  return {
    wyslane,
    sendMail: async (m) => {
      if (blad) throw new Error(blad);
      wyslane.push(m);
      return { messageId: 'test' };
    },
  };
}

let db, app, poczta;
function zbuduj({ mailer = atrapaPoczty() } = {}) {
  poczta = mailer;
  db = openOmsDb(':memory:');
  const potwierdzenie = mailer
    ? createPotwierdzenie({ db, mailer, sprzedawca: config.sprzedawca, teraz: () => '2026-08-21T12:40:00.000Z' })
    : null;
  // ⚠️ OBIE USLUGI ALBO ZADNA — dokladnie tak sklada je bootstrap.js (obie wisza na tym samym
  // `config.poczta`). Serwer z samym `potwierdzenie`, bez `wiadomosci`, to uklad, ktory na
  // produkcji NIE ISTNIEJE: karta nie miala by wtedy gdzie odnotowac wyslanego maila, bo od
  // 22.08.2026 slad pokazuje sekcja „Wiadomosci" (`_wiadomosci.ejs`), a nie pasek na gorze.
  const wiadomosci = mailer
    ? createWiadomosci({ db, mailer, potwierdzenie, config, teraz: () => '2026-08-21T12:40:00.000Z' })
    : null;
  app = buildOmsServer({ db, config, poller, wiadomosci });
  return app.ready();
}

beforeEach(() => zbuduj());

const wyslij = (id) => app.inject({ method: 'POST', url: `/zamowienia/${id}/wiadomosc/potwierdzenie`, headers: naglowek });
const karta = (id, q = '') => app.inject({ method: 'GET', url: `/zamowienia/${id}${q}`, headers: naglowek });
const log = (id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);

describe('podgląd potwierdzenia na karcie', () => {
  // ⚠️⚠️ PODGLAD POKAZUJE TO, CO ZOBACZY KLIENT — czyli HTML-a, a nie sam tekst
  // (przebudowa 21.08.2026). Ramka `srcdoc` renderuje maila w izolacji, dokladnie tak, jak
  // zrobi to klient pocztowy; wersja tekstowa zostaje pod nia, zwinieta.
  it('pokazuje adresata, temat i całą treść, której nikt jeszcze nie wysłał', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const body = (await karta(id, '?wiadomosc=potwierdzenie')).body;
    // ⚠️ ZAKOTWICZONE W LIŚCIE `<dl class="dane">` PODGLĄDU, nie gołe `toContain`: karta
    // drukuje adres klienta w danych do wysyłki na KAŻDYM renderze, więc `toContain`
    // przechodziłby nawet gdyby ten podgląd w ogóle nie pokazał adresata.
    expect(body).toMatch(/<dt>Do<\/dt>\s*<dd>klient@firma\.pl<\/dd>/);
    expect(body).toContain('Potwierdzenie przyjęcia zamówienia nr 202600014');
    // Ramka z PRAWDZIWYM mailem: tabela pozycji i suma, obie wewnatrz `srcdoc`.
    expect(body).toContain('srcdoc=');
    expect(body).toContain('Razem brutto');
    expect(body).toContain('243,70 zł');
    // Wersja tekstowa dalej jest — to druga, prawdziwa czesc tej samej wiadomosci.
    expect(body).toContain('RAZEM: 243,70 zł brutto');
    // ⚠️ TA SAMA FRAZA, KTÓREJ BRAKU pilnuje test odmowy niżej — asercja negatywna bez tej
    // pozytywnej byłaby spełniona także przez literówkę w napisie na przycisku.
    expect(body).toContain('Mail idzie od razu i nie da się go cofnąć.');
    expect(poczta.wyslane).toHaveLength(0);
  });

  // ⚠️ ODMOWA MA TRAFIC NA EKRAN JAKO POWOD, nie jako 400 na pustej stronie: operator ma sie
  // dowiedziec, czego dopisac.
  it('brak adresu e-mail → ekran mówi, gdzie go dopisać, i nie ma czego wysyłać', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane({ klient: { first_name: 'Jan' } }), {});
    const body = (await karta(id, '?wiadomosc=potwierdzenie')).body;
    expect(body).toMatch(/adresu e-mail/);
    expect(body).not.toContain('Mail idzie od razu i nie da się go cofnąć.');
  });
});

describe('wysyłka potwierdzenia', () => {
  it('wysyła maila i odnotowuje to na karcie', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    expect((await wyslij(id)).statusCode).toBe(302);

    expect(poczta.wyslane).toHaveLength(1);
    const m = poczta.wyslane[0];
    expect(m.to).toBe('klient@firma.pl');
    expect(m.subject).toContain('202600014');
    expect(m.text).toContain('3 × Lampa stołowa Grzybek 30x45');
    // ⚠️ HTML MA NIESC TABELE, a nie „jakikolwiek znacznik". Poprzednia wersja tego testu
    // sprawdzala `toContain('<')` — i przechodzila takze wtedy, gdy mail wychodzil jako ciag
    // akapitow bez ani jednej komorki. Dokladnie tak bylo przez pol dnia.
    expect(m.html).toMatch(/<table[\s\S]*Razem brutto[\s\S]*<\/table>/);
    expect(m.html).toContain('243,70 zł');

    expect(pobierzZamowienie(db, id).potwierdzenie_wyslane_at).toBe('2026-08-21T12:40:00.000Z');
    // ⚠️ JEDEN WPIS W REJESTRZE, NIE DWA. Delegacja z `services/wiadomosci.js` do
    // `services/potwierdzenie.js` ma zostawić DOKŁADNIE jeden ślad — dopisanie własnego
    // `zapiszWiadomosc` po stronie wołającego dałoby kartę twierdzącą, że klient dostał
    // potwierdzenie dwa razy.
    expect(wiadomosciZamowienia(db, id)).toHaveLength(1);
    expect(wiadomosciZamowienia(db, id)[0].temat_id).toBe('potwierdzenie');

    // ⚠️ SLAD PRZENIOSL SIE NA DOL KARTY (22.08.2026): do listy wyslanych w sekcji
    // „Wiadomosci", z paska pod danymi klienta. Ta sama rzecz, inne miejsce — i inny FORMAT
    // DATY, co jest tu sednem, a nie szczegolem: pasek ciął napis (`slice(0,16)`) i pokazywał
    // gołe UTC, czyli godzinę o dwie wcześniejszą niż WSZYSTKIE pozostałe daty na tej samej
    // karcie. Lista czyta znacznik przez `fmtDataCzasKrotko`, więc 12:40 UTC to 14:40
    // w Warszawie — i tak ma być.
    const body = (await karta(id)).body;
    expect(body).toMatch(/<td>Potwierdzenie przyjęcia zamówienia<\/td>/);
    expect(body).toContain('2026-08-21 14:40');
    expect(body).not.toContain('2026-08-21 12:40');
  });

  // ⚠️⚠️ NAJWAZNIEJSZY TEST TEJ FUNKCJI. Karta twierdzaca „wyslano" przy mailu, ktorego nigdy
  // nie bylo, jest gorsza niz brak sladu — bo nikt juz tego nie sprawdzi.
  it('awaria poczty NIE zostawia śladu „wysłano"', async () => {
    await zbuduj({ mailer: atrapaPoczty({ blad: 'SMTP padło' }) });
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const odp = await wyslij(id);
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/NIE została wysłana/);
    expect(pobierzZamowienie(db, id).potwierdzenie_wyslane_at).toBeNull();
    expect(wiadomosciZamowienia(db, id)).toHaveLength(0);
    expect(log(id).at(-1).akcja).toBe('potwierdzenie.blad');
    // ⚠️ CAŁY LOG, NIE TYLKO OSTATNI WPIS — sam „ostatni wpis to potwierdzenie.blad"
    // przepuściłby przestawienie zapisu PRZED `sendMail`: taki log miałby DWA wpisy
    // ([wysłane, błąd]), a asercja na `.at(-1)` dalej widziałaby tylko drugi z nich.
    expect(log(id).map((l) => l.akcja)).not.toContain('potwierdzenie.wyslane');
  });

  it('zamówienie anulowane → odmowa, mail nie wychodzi', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane({ anulowane: 1 }), {});
    const odp = await wyslij(id);
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/anulowane/);
    expect(poczta.wyslane).toHaveLength(0);
  });

  it('zamówienie bez adresu e-mail → odmowa, mail nie wychodzi', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane({ klient: { first_name: 'Jan' } }), {});
    const odp = await wyslij(id);
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/adresu e-mail/);
    expect(poczta.wyslane).toHaveLength(0);
  });

  // ⚠️ WŁASNA, STARSZA REGUŁA POTWIERDZENIA („bez pozycji nie ma czego potwierdzać") — dlatego
  // `domain/wiadomosci.js` przy tym temacie DELEGUJE do `czyWolnoWyslacPotwierdzenie`, zamiast
  // przepisywać warunki u siebie. Bez tego testu nic w suicie nie pilnowałoby, że delegacja
  // naprawdę zatrzymuje wysyłkę, a nie tylko wygasza wiersz na ekranie wyboru.
  it('zamówienie bez ani jednej pozycji → odmowa, mail nie wychodzi', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane({ pozycje: [] }), {});
    const odp = await wyslij(id);
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/ani jednej pozycji/);
    expect(poczta.wyslane).toHaveLength(0);
  });

  // ⚠️ LOG NIESIE ADRESATA, NIE TRESC — ta sama zasada, co przy komentarzu wewnetrznym.
  it('log mówi, kto kliknął i na jaki adres poszło', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    await wyslij(id);
    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('potwierdzenie.wyslane');
    expect(wpis.wynik).toContain('klient@firma.pl');
    expect(wpis.wynik).toContain('DECYZJA CZŁOWIEKA');
    expect(wpis.wynik).not.toContain('Lampa stołowa');
  });

  // ⚠️⚠️ JEDYNY HAMULEC przed wysłaniem klientowi DRUGIEGO potwierdzenia — a maila nie da się
  // cofnąć. Ostrzeżenie i etykieta „Wyślij ponownie" liczą się dziś Z REJESTRU wiadomości.
  it('drugie wysłanie mówi wprost, że pierwsze już poszło', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    await wyslij(id);
    const body = (await karta(id, '?wiadomosc=potwierdzenie')).body;
    expect(body).toMatch(/Ta wiadomość poszła już/);
    expect(body).toContain('Wyślij ponownie');
  });

  it('nieznane zamówienie → 404', async () => {
    expect((await wyslij(9999)).statusCode).toBe(404);
  });
});

// ⚠️ PANEL BEZ SKONFIGUROWANEJ POCZTY to tryb POPRAWNY, nie awaria — ta sama zasada, co przy
// GUS-ie i przy fakturach: przycisk sie nie pokazuje, a trasa mowi wprost, czego brakuje.
describe('panel bez poczty', () => {
  beforeEach(() => zbuduj({ mailer: null }));

  // ⚠️ TEST „karta nie kusi przyciskiem" USUNIĘTY (recenzja 22.08.2026, Zadanie 10 — część B).
  // Asercja `not.toContain('Wyślij potwierdzenie')` była PUSTA od przenosin 22.08: ten napis
  // żył WYŁĄCZNIE na osobnym ekranie podglądu, którego dziś nie ma w ogóle — więc test nie
  // miał jak się zaczerwienić, niezależnie od tego, czy poczta jest skonfigurowana. Prawdziwy
  // strażnik TEGO SAMEGO niezmiennika („bez usługi wiadomości przycisk »Wyślij nową
  // wiadomość« znika z karty") stoi w tests/oms/web-wiadomosci.test.js.
  it('trasa odmawia z wyjaśnieniem, a nie 500', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const odp = await wyslij(id);
    expect(odp.statusCode).toBe(503);
    expect(odp.body).toMatch(/Poczta nie jest skonfigurowana/);
  });
});
