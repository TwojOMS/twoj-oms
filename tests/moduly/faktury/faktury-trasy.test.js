import { describe, it, expect } from 'vitest';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszWiersz, odnotujUdanyPrzebiegArchiwum } from '../../../src/moduly/faktury/db/archiwum-sprzedazy.js';
import { PREFIKS_BLEDU_ARCHIWUM } from '../../../src/moduly/faktury/trasy/faktury.js';
import { bladOperatora } from '../../../src/domena/bledy.js';

// ⚠️ Ta sama para naglowkow, co w pozostalych testach tras (okresy-trasy.test.js): Basic Auth
// panelu, a przy POST takze `origin`, bez ktorego ochrona CSRF slusznie odbija zadanie.
// Sam odczyt zakladki obchodzi sie bez `origin`.
//
// `serwerZBaza` oddaje TAKZE baze, bo pas archiwum czyta wprost z SQLite (tabele
// `archiwum_sprzedazy` i `stan_archiwum_sprzedazy`) — bez uchwytu do niej nie da sie
// przygotowac stanu, ktory ekran ma pokazac. Reszta pola z `opcje` jedzie do
// `buildOmsServer` bez zmian, wiec test moze podstawic np. `czuwaczArchiwumSprzedazy`.
function serwerZBaza({ dokumenty = [], nieoplacone = [], proformy = [], ...dodatkowe } = {}) {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({
    db,
    config: { auth: { user: 't', pass: 'h' } },
    fakturyWidok: {
      dokumenty: async () => dokumenty,
      nieoplacone: async () => nieoplacone,
      proformy: () => proformy,
    },
    ...dodatkowe,
  });
  return { app, db };
}
const serwer = (opcje) => serwerZBaza(opcje).app;
const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };
const AUTH_POST = { ...AUTH, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };

// PRZ-078: forma prawna nabywcy skrócona w OBU tabelach, pełna nazwa w `title`. Bez tego
// testu widok mógłby przestać wołać skrocFormePrawna, a zielony zostałby tylko test domeny.
describe('GET /faktury — nabywca ze skróconą formą prawną', () => {
  it('skraca w tabeli faktur i nieopłaconych, pełną nazwę zostawia w podpowiedzi', async () => {
    const pelna = 'PRZYKŁAD SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ';
    const dok = {
      uuid: 'u1', number: '1/10/2026', rodzaj: 'vat', invoice_date: '2026-10-03', sale_date: '2026-10-03',
      client_company_name: pelna, kwotaZl: '10.00', pozostaloZl: '10.00', stanKsef: 'jest',
      ksef_number: 'X', zamowienie: null, stanTerminu: 'wkrotce', opisTerminu: 'za 3 dni', payment_date: '2026-10-17',
    };
    const app = serwer({ dokumenty: [dok], nieoplacone: [dok] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body.match(/>PRZYKŁAD sp\. z o\.o\.</g)).toHaveLength(2);
    expect(r.body.match(new RegExp(`title="${pelna}"`, 'g'))).toHaveLength(2);
  });
});

describe('GET /faktury', () => {
  it('renderuje trzy pasy i domyślnie bieżący miesiąc po dacie wystawienia', async () => {
    const app = serwer({ dokumenty: [{
      uuid: 'u1', number: '1/08/2026', rodzaj: 'vat', invoice_date: '2026-08-03', sale_date: '2026-08-03',
      client_company_name: 'Firma X', kwotaZl: '123.00', pozostaloZl: '0.00', stanKsef: 'jest',
      ksef_number: '1234563218-20260806-5EB04B000005-18', zamowienie: { id: 7, numer: '3001' },
      stanTerminu: 'brak', opisTerminu: 'bez terminu',
    }] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('1/08/2026');
    expect(r.body).toContain('Firma X');
    expect(r.body).toContain('/zamowienia/7');
    expect(r.body).toContain('Proformy');
    expect(r.body).toContain('Nieopłacone');
  });

  it('pokazuje dni do terminu w pasie nieopłaconych', async () => {
    const app = serwer({ nieoplacone: [{
      uuid: 'u9', number: '19/12/2025', payment_date: '2025-12-24', pozostaloZl: '1378.50',
      client_company_name: 'Pracownia Przykładowa sp. z o.o.', stanTerminu: 'po_terminie',
      opisTerminu: 'po terminie o 225 dni', zamowienie: null, stanKsef: 'jest',
    }] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).toContain('po terminie o 225 dni');
    expect(r.body).toContain('1378.50');
  });

  // ⚠️ Zaznaczać wolno WYŁĄCZNIE to, co da się wysłać. Checkbox przy dokumencie z numerem
  // KSeF robiłby z licznika zaznaczeń nieprawdę, a z przycisku obietnicę bez pokrycia.
  it('checkbox stoi tylko przy dokumencie BEZ numeru KSeF', async () => {
    const app = serwer({ dokumenty: [
      { uuid: 'zKsef', number: '1/08/2026', rodzaj: 'vat', stanKsef: 'jest', ksef_number: 'X', client_tax_code: '1234563218', kwotaZl: '1.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
      { uuid: 'bezKsef', number: '2/08/2026', rodzaj: 'vat', stanKsef: 'brak', ksef_number: null, client_tax_code: '1234563218', kwotaZl: '1.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
    ] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).toContain('value="bezKsef"');
    expect(r.body).not.toContain('value="zKsef"');
  });

  // ⚠️ KOREKTA TEZ NIE DOSTAJE POLA WYBORU (decyzja wlasciciela 06.08.2026: korekty wysyla
  // sie w inFakcie). Bariera stoi w domain/wysylka-ksef.js, ale checkbox obiecywalby
  // operatorowi cos, czego bariera i tak nie przepusci — a licznik zaznaczen klamalby.
  it('checkbox NIE stoi przy korekcie, nawet bez numeru KSeF', async () => {
    const app = serwer({ dokumenty: [
      { uuid: 'korekta', number: '1/KOR/07/2026', rodzaj: 'korekta', stanKsef: 'brak', ksef_number: null, kwotaZl: '-138.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
    ] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).toContain('1/KOR/07/2026');
    expect(r.body).not.toContain('value="korekta"');
  });

  // ⚠️⚠️ FAKTURA KONSUMENCKA (NABYWCA BEZ NIP-u) NIE DOSTAJE POLA WYBORU — decyzja
  // wlasciciela 28.08.2026, blokada twarda jak przy korektach. KSeF jest przy dokumencie B2C
  // DOBROWOLNY (stanowisko Ministerstwa Finansow), a wysylki nie da sie cofnac. Pomiar na
  // zywym koncie: na 169 faktur VI–VIII.2026 taki dokument byl DOKLADNIE JEDEN (`30/06/2026`)
  // i byl zarazem jedyna czerwcowa faktura bez numeru KSeF — czyli „zaznacz wszystkie"
  // w czerwcu zaznaczaloby wylacznie jego i wyslalo.
  //
  // ⚠️ TEN TEST RENDERUJE TRASE, a nie wola regule. Bariera (domain/wysylka-ksef.js) ma wlasne
  // testy; tutaj chodzi o to, ze widok NIE OBIECUJE operatorowi wysylki, ktorej bariera i tak
  // nie przepusci — bo obietnica na ekranie jest jedynym miejscem, gdzie czlowiek ma szanse
  // zlapac pomylke przed operacja nieodwracalna.
  it('checkbox NIE stoi przy fakturze konsumenckiej (nabywca bez NIP-u), a przy firmowej stoi', async () => {
    const app = serwer({ dokumenty: [
      { uuid: 'konsument', number: '30/06/2026', rodzaj: 'vat', stanKsef: 'brak', ksef_number: null, client_tax_code: null, client_first_name: 'Jan', client_last_name: 'Kowalski', kwotaZl: '138.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
      { uuid: 'firma', number: '31/06/2026', rodzaj: 'vat', stanKsef: 'brak', ksef_number: null, client_tax_code: '1234563218', client_company_name: 'Firma X', kwotaZl: '246.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
    ] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    // Wiersz jest na ekranie — panel go NIE UKRYWA, tylko nie proponuje wysylki.
    expect(r.body).toContain('30/06/2026');
    expect(r.body).toContain('value="firma"');
    expect(r.body).not.toContain('value="konsument"');
    // ⚠️ POWOD MA BYC NAZWANY, tak jak „Korekta" przy korekcie. Wiersz bez pola wyboru
    // i bez slowa wygladalby jak usterka listy, a to jest stan NORMALNY.
    expect(r.body).toContain('>konsumencka</span>');
  });

  // ⚠️⚠️ NAJDROZSZA POMYLKA MOZLIWA W TEJ REGULE. Klient zagraniczny (WDT) ma w polu NIP-u
  // numer VAT UE z prefiksem literowym — to JEST podatnik, ktorego faktura idzie do KSeF
  // normalnie. Widok nie ma prawa wziac go za konsumenta.
  it('faktura WDT (zagraniczny numer VAT UE) MA pole wyboru — to podatnik, nie konsument', async () => {
    const app = serwer({ dokumenty: [
      { uuid: 'wdt', number: '12/08/2026', rodzaj: 'vat', stanKsef: 'brak', ksef_number: null, client_tax_code: 'SK1000000002', client_company_name: 'Slovak s.r.o.', kwotaZl: '900.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
    ] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).toContain('value="wdt"');
    expect(r.body).not.toContain('>konsumencka</span>');
  });

  // „Zaznacz wszystkie" jest ODNOSNIKIEM, nie skryptem — zaznacza wylacznie wiersze, ktore
  // MAJA pole wyboru. Odtworzenie CZERWCA z pomiaru: gdyby konsumencka miala pole wyboru,
  // ten jeden klik wyslalby ja do KSeF bezpowrotnie.
  it('„zaznacz wszystkie" nie zaznacza faktury konsumenckiej', async () => {
    const app = serwer({ dokumenty: [
      { uuid: 'konsument', number: '30/06/2026', rodzaj: 'vat', stanKsef: 'brak', ksef_number: null, client_tax_code: '', kwotaZl: '138.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
      { uuid: 'firma', number: '31/06/2026', rodzaj: 'vat', stanKsef: 'brak', ksef_number: null, client_tax_code: '1234563218', kwotaZl: '246.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
    ] });
    const r = await app.inject({ method: 'GET', url: '/faktury?zaznacz=1', headers: AUTH });
    expect(r.body).toContain('value="firma"');
    expect(r.body).not.toContain('value="konsument"');
  });

  // ⚠️⚠️ TRZECI STAN KSeF (recenzja calosci, Finding 1). Miedzy zleceniem wysylki a nadaniem
  // numeru mija ~70 sekund. Do poprawki wiersz mowil wtedy „brak", mial pole wyboru i wracal
  // do zaznaczenia — a zatwierdzenie i tak odbiloby sie od rezerwacji w bazie. Ekran, ktorego
  // jedynym zadaniem jest zlapac pomylke przed operacja nieodwracalna, klamal.
  it('dokument, którego wysyłkę panel już zlecił, NIE MA pola wyboru i mówi, że czeka na numer', async () => {
    const app = serwer({ dokumenty: [
      { uuid: 'czeka', number: '3/08/2026', rodzaj: 'vat', stanKsef: 'wyslana_czeka', ksef_number: null, ksefZleconaAt: '2026-08-06T14:00:00.000Z', client_tax_code: '1234563218', kwotaZl: '1.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
    ] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).toContain('3/08/2026');
    expect(r.body).not.toContain('value="czeka"');
    // ⚠️⚠️ ANI SLOWA O TYM, ZE DOKUMENT „JEST W KSeF" — panel tego NIE WIE, numer nadaje organ.
    expect(r.body).toMatch(/czeka na numer/i);
    expect(r.body).not.toMatch(/w KSeF<\/span>/);
  });

  // „Zaznacz wszystkie" jest ODNOSNIKIEM, nie skryptem — zaznacza wylacznie wiersze, ktore
  // MAJA pole wyboru. Dokument juz zlecony nie ma dokad pojechac drugi raz.
  it('„zaznacz wszystkie" nie zaznacza dokumentu czekającego na numer KSeF', async () => {
    const app = serwer({ dokumenty: [
      { uuid: 'czeka', number: '3/08/2026', rodzaj: 'vat', stanKsef: 'wyslana_czeka', ksef_number: null, ksefZleconaAt: '2026-08-06T14:00:00.000Z', client_tax_code: '1234563218', kwotaZl: '1.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
      { uuid: 'bezKsef', number: '2/08/2026', rodzaj: 'vat', stanKsef: 'brak', ksef_number: null, ksefZleconaAt: null, client_tax_code: '1234563218', kwotaZl: '1.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
    ] });
    const r = await app.inject({ method: 'GET', url: '/faktury?zaznacz=1', headers: AUTH });
    expect(r.body).toContain('value="bezKsef"');
    expect(r.body).not.toContain('value="czeka"');
  });

  // ⚠️ Ekran podgladu (Zadanie 9) przelicza zbior PONOWNIE z na nowo pobranej listy, wiec
  // bez tych dwoch pol nie ma jak odtworzyc, na ktora liste operator patrzyl.
  it('formularz wysyłki niesie miesiąc i pole daty, z którego zaznaczano', async () => {
    const app = serwer({ dokumenty: [
      { uuid: 'bezKsef', number: '2/08/2026', rodzaj: 'vat', stanKsef: 'brak', ksef_number: null, client_tax_code: '1234563218', kwotaZl: '1.00', pozostaloZl: '0.00', zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu' },
    ] });
    const r = await app.inject({ method: 'GET', url: '/faktury?miesiac=2026-07&pole=sale_date', headers: AUTH });
    expect(r.body).toContain('action="/faktury/ksef/podglad"');
    expect(r.body).toContain('name="miesiac" value="2026-07"');
    expect(r.body).toContain('name="pole" value="sale_date"');
  });

  // Faktura zbiorcza klienta dropshippingowego nie ma wiersza w `faktury` — jej powiazaniem
  // jest OKRES rozliczeniowy. Bez tej galezi caly pieniadz B2B wygladalby jak dokument
  // wystawiony poza panelem.
  it('dokument okresu rozliczeniowego prowadzi na kartę okresu, nie na zamówienie', async () => {
    const app = serwer({ dokumenty: [{
      uuid: 'uo', number: '5/08/2026', rodzaj: 'vat', stanKsef: 'brak', ksef_number: null,
      kwotaZl: '100.00', pozostaloZl: '0.00', zamowienie: null,
      okres: { id: 12, klient: 'przykladowa', rok: 2026, miesiac: 7 },
      stanTerminu: 'brak', opisTerminu: 'bez terminu',
    }] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).toContain('/okresy/12');
    expect(r.body).toContain('przykladowa');
  });

  // ⚠️ Recenzja II Zadania 7 (Finding 1): odkąd `dokumenty` i `nieoplacone` maja WLASNE
  // wyniki (patrz testy nizej), samo `dokumenty` rzucajace juz nie zabiera prawdziwej, pustej
  // odpowiedzi `nieoplacone` — a legalne zero NIE JEST tu klamstwem. Ten test wiec rzuca
  // W OBU zapytaniach naraz: to jedyny scenariusz, w ktorym cala strona wciaz ma zwrocic 200
  // (nie 500) i nigdzie nie pokazac zmyslonego zera.
  it('awaria inFaktu w obu zapytaniach daje czytelny komunikat, a nie 500', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({
      db, config: { auth: { user: 't', pass: 'h' } },
      fakturyWidok: {
        dokumenty: async () => { throw new Error('inFakt nieosiągalny: fetch failed'); },
        nieoplacone: async () => { throw new Error('inFakt nieosiągalny: fetch failed'); },
        proformy: () => [],
      },
    });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('inFakt');
    // ⚠️ I ANI SŁOWA O TYM, ŻE DŁUGU NIE MA. Zero jest ODPOWIEDZIĄ („nikt nic nie jest
    // winien"), a po awarii prawda brzmi „nie wiadomo" — pas nieopłaconych jest jedynym
    // miejscem, w którym właściciel widzi te pieniądze.
    expect(r.body).not.toContain('pozostało do zapłaty 0.00');
    expect(r.body).toMatch(/nie wiadomo/);
  });

  // ⚠️ Finding 2 (recenzja Zadania 7): `proformy()` czyta LOKALNA baze SQLite, nie inFakt —
  // inny system, inna awaria. Cały sens tej zakładki to DEGRADACJA: awaria bazy proform nie
  // ma prawa zabrać ze sobą pasów, które akurat działają (nieopłacone, faktury z inFaktu).
  it('awaria proform (lokalna baza) nie kładzie reszty ekranu, a nie 500', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({
      db, config: { auth: { user: 't', pass: 'h' } },
      fakturyWidok: {
        dokumenty: async () => [{
          uuid: 'u1', number: '1/08/2026', rodzaj: 'vat', invoice_date: '2026-08-03', sale_date: '2026-08-03',
          client_company_name: 'Firma X', kwotaZl: '123.00', pozostaloZl: '0.00', stanKsef: 'jest',
          ksef_number: '1234563218-20260806-5EB04B000005-18', zamowienie: { id: 7, numer: '3001' },
          stanTerminu: 'brak', opisTerminu: 'bez terminu',
        }],
        nieoplacone: async () => [],
        proformy: () => { throw new Error('database is locked'); },
      },
    });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    // Pas faktur z inFaktu dalej stoi — awaria proform go nie zabrała.
    expect(r.body).toContain('1/08/2026');
    expect(r.body).toContain('Firma X');
    // Pas proform mówi „nie wiadomo", a nie udaje pustego miesiąca.
    expect(r.body).toMatch(/Nie wiadomo — baza panelu nie odpowiedziała/);
  });

  // ⚠️ Finding 1 (recenzja II Zadania 7): `dokumenty` i `nieoplacone` to DWA NIEZALEZNE
  // zapytania do inFaktu. Zanim ta poprawka trafila do route'a, stały pod jednym wspólnym
  // `Promise.all`/`catch`, wiec porazka JEDNEGO z nich gasila CALA zakladke — takze pas, ktory
  // akurat dzialal. Te trzy testy pilnuja, ze kazdy pas dostaje wlasny wynik.
  it('awaria sekcji nieopłaconych nie gasi listy faktur miesiąca ani proform', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({
      db, config: { auth: { user: 't', pass: 'h' } },
      fakturyWidok: {
        dokumenty: async () => [{
          uuid: 'u1', number: '1/08/2026', rodzaj: 'vat', invoice_date: '2026-08-03', sale_date: '2026-08-03',
          client_company_name: 'Firma X', kwotaZl: '123.00', pozostaloZl: '0.00', stanKsef: 'jest',
          ksef_number: '1234563218-20260806-5EB04B000005-18', zamowienie: { id: 7, numer: '3001' },
          stanTerminu: 'brak', opisTerminu: 'bez terminu',
        }],
        nieoplacone: async () => { throw new Error('inFakt nieosiągalny: fetch failed'); },
        proformy: () => [{
          id: 1, numer: 'PF/1/08/2026', utworzona_at: '2026-08-01T10:00:00.000Z',
          zamowienie_id: 7, zamowienie_numer: '3001', kwota_brutto: '61.50', uniewazniona_at: null,
        }],
      },
    });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    // Pas faktur miesiąca dalej stoi.
    expect(r.body).toContain('1/08/2026');
    expect(r.body).toContain('Firma X');
    // Proformy dalej stoją.
    expect(r.body).toContain('PF/1/08/2026');
    // Pas nieopłaconych mówi wprost, że nie wiadomo — a nie milczy.
    expect(r.body).toMatch(/nie wiadomo/);
    expect(r.body).toContain('Nie udało się pobrać nieopłaconych faktur z inFaktu');
  });

  it('awaria listy faktur miesiąca nie gasi sekcji nieopłaconych ani proform', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({
      db, config: { auth: { user: 't', pass: 'h' } },
      fakturyWidok: {
        dokumenty: async () => { throw new Error('inFakt nieosiągalny: fetch failed'); },
        nieoplacone: async () => [{
          uuid: 'u9', number: '19/12/2025', payment_date: '2025-12-24', pozostaloZl: '1378.50',
          client_company_name: 'Pracownia Przykładowa sp. z o.o.', stanTerminu: 'po_terminie',
          opisTerminu: 'po terminie o 225 dni', zamowienie: null, stanKsef: 'jest',
        }],
        proformy: () => [{
          id: 1, numer: 'PF/1/08/2026', utworzona_at: '2026-08-01T10:00:00.000Z',
          zamowienie_id: 7, zamowienie_numer: '3001', kwota_brutto: '61.50', uniewazniona_at: null,
        }],
      },
    });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    // Pas nieopłaconych dalej stoi, z prawdziwą kwotą długu.
    expect(r.body).toContain('po terminie o 225 dni');
    expect(r.body).toContain('1378.50');
    // Proformy dalej stoją.
    expect(r.body).toContain('PF/1/08/2026');
    // Pas faktur miesiąca mówi wprost, że nie wiadomo.
    expect(r.body).toContain('Nie udało się pobrać faktur z inFaktu');
  });

  // ⚠️ Zero jest tu ODPOWIEDZIĄ („nikt nic nie jest winien"), a po awarii prawda brzmi
  // „nie wiadomo" — fałszywe „0.00 zł" przy pasie długu byłoby gorsze niż milczenie.
  it('awaria sekcji nieopłaconych nie pokazuje fałszywej sumy 0,00 zł', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({
      db, config: { auth: { user: 't', pass: 'h' } },
      fakturyWidok: {
        dokumenty: async () => [],
        nieoplacone: async () => { throw new Error('inFakt nieosiągalny: fetch failed'); },
        proformy: () => [],
      },
    });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('pozostało do zapłaty 0.00');
    expect(r.body).not.toMatch(/pozostało do zapłaty 0,00/);
  });

  // ⚠️ Finding 3 (recenzja Zadania 7): trasa przyjmuje KAZDY skladniowo poprawny „RRRR-MM",
  // a lista wyboru oferuje wylacznie 13 ostatnich miesiecy — bez tej poprawki tabela
  // pokazywalaby 2020-01, a select dalej wskazywalby pierwszy z oferowanych miesiecy.
  it('miesiąc spoza 13 oferowanych i tak trafia do listy wyboru (ekran nie przeczy sam sobie)', async () => {
    const app = serwer({ dokumenty: [{
      uuid: 'stary', number: '1/01/2020', rodzaj: 'vat', invoice_date: '2020-01-15', sale_date: '2020-01-15',
      client_company_name: 'Firma Stara', kwotaZl: '10.00', pozostaloZl: '0.00', stanKsef: 'brak',
      ksef_number: null, zamowienie: null, stanTerminu: 'brak', opisTerminu: 'bez terminu',
    }] });
    const r = await app.inject({ method: 'GET', url: '/faktury?miesiac=2020-01', headers: AUTH });
    expect(r.statusCode).toBe(200);
    // Tabela pokazuje 2020-01…
    expect(r.body).toContain('1/01/2020');
    // …a select TEŻ, i to jako zaznaczony — inaczej ekran przeczyłby sam sobie.
    expect(r.body).toContain('<option value="2020-01" selected>');
  });

  // ⚠️ Ikona w pasku prowadzaca w 404 wyglada jak usterka panelu — ta sama decyzja, co przy
  // /raporty i /ustawieniach. Panel bez skonfigurowanego inFaktu MA odpowiedziec.
  it('bez skonfigurowanego inFaktu zakładka mówi, że jest pusta celowo', async () => {
    const app = buildOmsServer({ db: openOmsDb(':memory:'), config: { auth: { user: 't', pass: 'h' } } });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('inFakt');
  });

  // Ekran bez wejscia to ekran, ktorego nikt nie znajdzie — pasek gorny jest jedyna
  // nawigacja panelu (ta sama asercja, co przy /okresy).
  it('pasek górny prowadzi na zakładkę faktur', async () => {
    const app = serwer();
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).toContain('href="/faktury"');
  });

  // ⚠️ Finding 5 (recenzja Zadania 7): asercja o kolejności `.btn` / `.btn--groza` w arkuszu
  // PRZENIESIONA do tests/oms/layout-przyciski.test.js — reguła żyje we wspólnym
  // layout-oms.ejs i pilnuje TRZECH ekranów (faktury, masowe-nadaj, masowe-wynik), nie
  // tylko tej zakładki. Zostawiona tutaj wskazywałaby na złą trasę, gdyby ktoś zepsuł ją,
  // zmieniając wyłącznie ekrany akcji masowych.

  // ⚠️⚠️ POPRAWKA PO RECENZJI (28.08.2026): do tego miejsca ŻADEN test nie renderował
  // faktury.ejs i nie sprawdzał treści kolumny „Płatność" — cała suita kończyła się na
  // usłudze (services/faktury-widok.js, domain/lista-faktur.js). Gdyby ktoś kiedyś podmienił
  // warunek gałęzi z powrotem na arytmetykę `Number(d.pozostaloZl) > 0` (dokładnie ta usterka,
  // którą naprawiono 28.08 — patrz komentarz przy tej kolumnie w faktury.ejs), cała suita
  // przeszłaby na zielono, bo usługa dalej liczyłaby `stanZaplaty` poprawnie. Cztery testy
  // niżej, po jednym na gałąź widoku, renderują TĘ SAMĄ trasę co reszta pliku i dopasowują
  // się do CAŁEGO znacznika komórki (klasa + treść), nie do gołego słowa — „zapłacona" i
  // „pozostało" wychodzą też gdzie indziej na stronie (nagłówek pasa długów, akapit
  // wyjaśnienia), więc luźne `toContain` łapałoby przypadkowe wystąpienie.
  it('kolumna „Płatność": faktura opłacona w inFakcie pokazuje „zapłacona", mimo niezerowego pozostaloZl', async () => {
    // Odtwarza żywy przypadek 51/08/2026: inFakt ma `status: paid` i `left_to_pay: 99000`
    // naraz. To jest sedno poprawki z 28.08 — gdyby widok wrócił do liczenia z kwoty zamiast
    // z `stanZaplaty`, ten dokument świeciłby na czerwono mimo że jest opłacony.
    const app = serwer({ dokumenty: [{
      uuid: 'u51', number: '51/08/2026', rodzaj: 'vat', invoice_date: '2026-08-26', sale_date: '2026-08-26',
      client_company_name: 'Firma Opłacona', kwotaZl: '990.00', pozostaloZl: '990.00',
      stanZaplaty: 'zaplacona', stanKsef: 'brak', ksef_number: null, zamowienie: null,
      stanTerminu: 'brak', opisTerminu: 'bez terminu',
    }] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    // Cały znacznik, nie gole słowo — „zapłacone" (inny przypadek) stoi też w akapicie
    // wyjaśnienia pod pasem długów.
    expect(r.body).toContain('<span class="znacznik znacznik--ok">zapłacona</span>');
    expect(r.body).not.toContain('pozostało 990.00 zł');
  });

  it('kolumna „Płatność": faktura realnie nieopłacona pokazuje „pozostało 54.89 zł"', async () => {
    const app = serwer({ dokumenty: [{
      uuid: 'u44', number: '44/08/2026', rodzaj: 'vat', invoice_date: '2026-08-20', sale_date: '2026-08-20',
      client_company_name: 'Firma Winna', kwotaZl: '54.89', pozostaloZl: '54.89',
      stanZaplaty: 'do_zaplaty', stanKsef: 'brak', ksef_number: null, zamowienie: null,
      stanTerminu: 'brak', opisTerminu: 'bez terminu',
    }] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).toContain('<span class="znacznik znacznik--blad">pozostało 54.89 zł</span>');
  });

  it('kolumna „Płatność": bez statusu i kwoty z inFaktu pokazuje „nie wiadomo", nie zgaduje', async () => {
    const app = serwer({ dokumenty: [{
      uuid: 'uN', number: '7/08/2026', rodzaj: 'vat', invoice_date: '2026-08-10', sale_date: '2026-08-10',
      client_company_name: 'Firma Niejasna', kwotaZl: '10.00', pozostaloZl: '0.00',
      stanZaplaty: 'nieznany', stanKsef: 'brak', ksef_number: null, zamowienie: null,
      stanTerminu: 'brak', opisTerminu: 'bez terminu',
    }] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).toContain(
      '<span class="znacznik znacznik--cichy" title="inFakt nie podał ani statusu, ani kwoty">nie wiadomo</span>',
    );
    expect(r.body).not.toContain('<span class="znacznik znacznik--ok">zapłacona</span>');
    expect(r.body).not.toContain('znacznik--blad">pozostało');
  });

  it('kolumna „Płatność": korekta pokazuje myślnik, niezależnie od stanZaplaty i kwoty', async () => {
    const app = serwer({ dokumenty: [{
      uuid: 'uK', number: '1/KOR/08/2026', rodzaj: 'korekta', invoice_date: '2026-08-15', sale_date: '2026-08-15',
      client_company_name: 'Firma Korekta', kwotaZl: '-100.00', pozostaloZl: '100.00',
      stanZaplaty: 'zaplacona', stanKsef: 'brak', ksef_number: null, zamowienie: null,
      stanTerminu: 'brak', opisTerminu: 'bez terminu',
    }] });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).toContain('<span class="znacznik znacznik--cichy">—</span>');
  });

  it('bez hasła odmawia', async () => {
    const app = serwer();
    expect((await app.inject({ method: 'GET', url: '/faktury' })).statusCode).toBe(401);
  });
});

// Pas archiwum PDF-ow na NAS-ie (spec 2026-09-02). Ekran mowi, KIEDY archiwum ostatnio
// zadzialalo i ILE dokumentow ma u siebie, a przycisk wymusza przebieg poza pora nocna.
describe('archiwum sprzedazy na /faktury', () => {
  // ⚠️ BEZ INFAKT_ARCHIWUM PRZYCISKU NIE MA — i to jest stan POPRAWNY, nie usterka. Przycisk
  // bez czuwacza obiecywalby operatorowi robote, ktorej panel nie ma czym wykonac; ekran ma
  // za to POWIEDZIEC, ze archiwum jest wylaczone (ta sama zasada, co przy zakladce bez inFaktu).
  it('bez czuwacza ekran mówi „archiwum wyłączone" i nie ma przycisku', async () => {
    const app = serwer();
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Archiwum na serwerze: wyłączone');
    expect(r.body).not.toContain('/faktury/archiwum/uruchom');
  });

  it('z czuwaczem pokazuje stan i liczniki oraz przycisk', async () => {
    const { app, db } = serwerZBaza({ czuwaczArchiwumSprzedazy: { przebieg: async () => ({}) } });
    zapiszWiersz(db, {
      uuid: 'a', rodzaj: 'vat', numer: '1/08/2026', invoiceDate: '2026-08-01',
      odcisk: '{}', sciezkaPdf: 'x', zapisanyAt: '2026-09-02T02:10:00.000Z',
    });
    odnotujUdanyPrzebiegArchiwum(db, { chwila: '2026-09-02T02:10:00Z', podlogaZrobiona: true });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Archiwum na serwerze');
    expect(r.body).toContain('/faktury/archiwum/uruchom');
    expect(r.body).not.toContain('Archiwum na serwerze: wyłączone');
  });

  // ⚠️ ASERCJA „TOMATCH(/1 dokument/)" NIE ODROZNIA „1 dokument" OD „1 dokumentów" — ten
  // drugi napis TEZ zawiera podnapis „1 dokument". Test wiec przeszedlby na zielono nawet
  // gdyby `ile()` zawsze wybieral forme mnoga. Dopasowanie musi wymusic, ze po „1 dokument"
  // NIE stoi kolejna litera (koncowka liczby mnogiej) — a przy okazji sprawdzic obie
  // pozostale formy liczebnika: dwie sztuki i piec sztuk.
  it('liczebnik dokumentow w linii stanu archiwum ma poprawna forme dla 1, 2 i 5 wierszy', async () => {
    const jedenWiersz = () => {
      const { app, db } = serwerZBaza({ czuwaczArchiwumSprzedazy: { przebieg: async () => ({}) } });
      zapiszWiersz(db, {
        uuid: 'j1', rodzaj: 'vat', numer: '1/08/2026', invoiceDate: '2026-08-01',
        odcisk: '{}', sciezkaPdf: 'x', zapisanyAt: '2026-09-02T02:10:00.000Z',
      });
      return { app };
    };
    const { app: app1 } = jedenWiersz();
    const r1 = await app1.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r1.body).toMatch(/1 dokument(?![a-ząćęłńóśźż])/);

    const { app: app2, db: db2 } = serwerZBaza({ czuwaczArchiwumSprzedazy: { przebieg: async () => ({}) } });
    ['d1', 'd2'].forEach((uuid, i) => zapiszWiersz(db2, {
      uuid, rodzaj: 'vat', numer: `${i + 1}/08/2026`, invoiceDate: '2026-08-01',
      odcisk: '{}', sciezkaPdf: 'x', zapisanyAt: '2026-09-02T02:10:00.000Z',
    }));
    const r2 = await app2.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r2.body).toMatch(/2 dokumenty(?![a-ząćęłńóśźż])/);

    const { app: app5, db: db5 } = serwerZBaza({ czuwaczArchiwumSprzedazy: { przebieg: async () => ({}) } });
    ['p1', 'p2', 'p3', 'p4', 'p5'].forEach((uuid, i) => zapiszWiersz(db5, {
      uuid, rodzaj: 'vat', numer: `${i + 1}/08/2026`, invoiceDate: '2026-08-01',
      odcisk: '{}', sciezkaPdf: 'x', zapisanyAt: '2026-09-02T02:10:00.000Z',
    }));
    const r5 = await app5.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r5.body).toMatch(/5 dokumentów/);
  });

  // ⚠️ ZERO SKASOWANYCH NIE MA PRAWA STAC NA EKRANIE. „skasowanych: 0" czyta sie jak alarm,
  // ktorego nie ma — a to jest stan normalny kazdego zdrowego archiwum.
  it('licznik skasowanych milczy, gdy nikt nic nie skasował', async () => {
    const { app, db } = serwerZBaza({ czuwaczArchiwumSprzedazy: { przebieg: async () => ({}) } });
    zapiszWiersz(db, {
      uuid: 'a', rodzaj: 'vat', numer: '1/08/2026', invoiceDate: '2026-08-01',
      odcisk: '{}', sciezkaPdf: 'x', zapisanyAt: '2026-09-02T02:10:00.000Z',
    });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).not.toContain('skasowanych: 0');
  });

  // Archiwum wlaczone, ale jeszcze ani razu nieodpalone — ekran ma to powiedziec wprost,
  // zamiast milczec (milczenie wyglada jak ekran, ktory sie nie wczytal).
  it('włączone archiwum bez ani jednego przebiegu mówi „nigdy"', async () => {
    const { app } = serwerZBaza({ czuwaczArchiwumSprzedazy: { przebieg: async () => ({}) } });
    const r = await app.inject({ method: 'GET', url: '/faktury', headers: AUTH });
    expect(r.body).toMatch(/ostatni udany przebieg nigdy/);
  });

  // ⚠️ PRZEBIEG Z PRZYCISKU JEST WYMUSZONY, ZAWSZE. Zwykly `przebieg()` sprawdza pore (raz na
  // dobe, w nocy), wiec przycisk wcisniety w dzien nie zrobilby NIC i wygladalby na zepsuty —
  // dokladnie ten sam blad, ktory poprawiono przy POST /koszty/odswiez.
  it('POST uruchamia przebieg WYMUSZONY i wraca na ten sam filtr z komunikatem', async () => {
    let dostal = null;
    const { app } = serwerZBaza({
      czuwaczArchiwumSprzedazy: {
        przebieg: async (o) => {
          dostal = o;
          return {
            pobranych: 2, adoptowanych: 0, nadpisanych: 0, bezZmian: 5,
            skasowanych: 0, niedokonczone: false, miesiecy: 3,
          };
        },
      },
    });
    const r = await app.inject({
      method: 'POST', url: '/faktury/archiwum/uruchom', headers: AUTH_POST,
      payload: 'miesiac=2026-08&pole=sale_date',
    });
    expect(dostal).toEqual({ wymuszony: true });
    expect(r.statusCode).toBe(303);
    // ⚠️ FILTR WRACA Z OPERATOREM. Bez niego przycisk przerzucalby go na biezacy miesiac —
    // czyli na inna liste niz ta, ktora ogladal, gdy klikal.
    expect(r.headers.location).toContain('/faktury?miesiac=2026-08&pole=sale_date');
    expect(decodeURIComponent(r.headers.location)).toMatch(/pobranych 2/);
  });

  // Przebieg pominiety (np. „poprzedni jeszcze trwa") NIE JEST pobraniem — operator ma
  // zobaczyc, ze nic sie nie stalo, i to z powodem.
  it('pominięty przebieg mówi, że nic nie zrobiono, i podaje powód', async () => {
    const { app } = serwerZBaza({
      czuwaczArchiwumSprzedazy: {
        przebieg: async () => ({ pominiety: true, powod: 'poprzedni przebieg jeszcze trwa' }),
      },
    });
    const r = await app.inject({
      method: 'POST', url: '/faktury/archiwum/uruchom', headers: AUTH_POST,
      payload: 'miesiac=2026-08&pole=invoice_date',
    });
    expect(r.statusCode).toBe(303);
    expect(decodeURIComponent(r.headers.location)).toMatch(/nic nie zrobiono — poprzedni przebieg jeszcze trwa/);
  });

  // ⚠️ AWARIA CZUWACZA NIE MA PRAWA WYWALIC PIECSETKI. Operator ma wrocic na liste ze zdaniem
  // o tym, co poszlo nie tak — ekran faktur dziala dalej, bo czyta inFakt, a nie NAS.
  //
  // ⚠️ BLAD BEZ `dlaOperatora` NIE POWTARZA SZCZEGOLOW TECHNICZNYCH W KOMUNIKACIE. „ENOSPC:
  // brak miejsca na NAS-ie" to surowy blad techniczny (bez `bladOperatora()` z domain/bledy.js)
  // — komunikat na ekranie ma odeslac operatora do linii stanu archiwum, ktora czuwacz i tak
  // zapisze w `ostatni_blad`, a nie zmyslac wlasna tresc bledu.
  it('błąd techniczny (bez dlaOperatora) wraca zdaniem odsyłającym do linii stanu, a nie 500', async () => {
    const { app } = serwerZBaza({
      czuwaczArchiwumSprzedazy: { przebieg: async () => { throw new Error('ENOSPC: brak miejsca na NAS-ie'); } },
    });
    const r = await app.inject({
      method: 'POST', url: '/faktury/archiwum/uruchom', headers: AUTH_POST,
      payload: 'miesiac=2026-08',
    });
    expect(r.statusCode).toBe(303);
    const lokacja = decodeURIComponent(r.headers.location);
    expect(lokacja).toContain(`${PREFIKS_BLEDU_ARCHIWUM} — szczegóły w linii stanu archiwum poniżej.`);
    // Surowy tekst bledu technicznego NIE ma prawa wyciec na ekran.
    expect(lokacja).not.toContain('ENOSPC');
  });

  // ⚠️ BLAD Z `dlaOperatora` NIESIE WLASNA TRESC — to jest zdanie, ktore SAMI napisalismy po
  // polsku dla czlowieka (domain/bledy.js: `bladOperatora`), wiec komunikat ma je POKAZAC,
  // a nie zastapic ogolnym odeslaniem do linii stanu.
  it('błąd z dlaOperatora pokazuje właściwą treść komunikatu', async () => {
    const { app } = serwerZBaza({
      czuwaczArchiwumSprzedazy: {
        przebieg: async () => { throw bladOperatora('inFakt odrzucił żądanie: limit zapytań.'); },
      },
    });
    const r = await app.inject({
      method: 'POST', url: '/faktury/archiwum/uruchom', headers: AUTH_POST,
      payload: 'miesiac=2026-08',
    });
    expect(r.statusCode).toBe(303);
    const lokacja = decodeURIComponent(r.headers.location);
    expect(lokacja).toContain(`${PREFIKS_BLEDU_ARCHIWUM} — inFakt odrzucił żądanie: limit zapytań.`);
  });

  // ⚠️ PASEK MA SWIECIC WLASCIWYM KOLOREM. Widok liczy klase z `komunikatZly`, ktory trasa
  // wylicza z `PREFIKS_BLEDU_ARCHIWUM` (Finding recenzji — dopasowanie przedrostka nie ma
  // prawa zyc w dwoch miejscach naraz). Te dwa testy pilnuja calego lancucha: adres →
  // `komunikatZly` → klasa paska.
  //
  // ⚠️ `toContain('pasek-blokada')`/`toContain('pasek-info')` GOLE NIE WYSTARCZAJA — obie
  // nazwy klas stoja TAKZE w arkuszu `<style>` layoutu, ktory jedzie na KAZDEJ stronie
  // niezaleznie od tego, czy pasek akurat sie renderuje. Asercja musi trafic w SAM ZNACZNIK
  // z komunikatem, nie w dowolne wystapienie nazwy klasy na calej stronie.
  it('komunikat błędu archiwum świeci pasek-blokada, nie pasek-info', async () => {
    const { app } = serwerZBaza({ czuwaczArchiwumSprzedazy: { przebieg: async () => ({}) } });
    const r = await app.inject({
      method: 'GET',
      url: `/faktury?komunikat=${encodeURIComponent(`${PREFIKS_BLEDU_ARCHIWUM} — szczegóły w linii stanu archiwum poniżej.`)}`,
      headers: AUTH,
    });
    expect(r.body).toContain('<p class="pasek-blokada">Archiwum: błąd');
    expect(r.body).not.toContain('<p class="pasek-info">Archiwum: błąd');
  });

  it('komunikat udanego przebiegu archiwum świeci pasek-info', async () => {
    const { app } = serwerZBaza({ czuwaczArchiwumSprzedazy: { przebieg: async () => ({}) } });
    const r = await app.inject({
      method: 'GET',
      url: `/faktury?komunikat=${encodeURIComponent('Archiwum: pobranych 2, adoptowanych 0.')}`,
      headers: AUTH,
    });
    expect(r.body).toContain('<p class="pasek-info">Archiwum: pobranych 2');
  });

  // Komunikat z adresu ma DOJSC NA EKRAN — inaczej przekierowanie gubi jedyny slad operacji.
  it('komunikat z adresu ląduje na ekranie /faktury', async () => {
    const { app } = serwerZBaza({ czuwaczArchiwumSprzedazy: { przebieg: async () => ({}) } });
    const r = await app.inject({
      method: 'GET',
      url: `/faktury?komunikat=${encodeURIComponent('Archiwum: pobranych 2, adoptowanych 0.')}`,
      headers: AUTH,
    });
    expect(r.body).toContain('Archiwum: pobranych 2, adoptowanych 0.');
  });

  // ⚠️ TRESC Z ADRESU JEST OBCA — idzie przez `<%= %>`, wiec znacznik ma wyjsc jako TEKST.
  it('komunikat z adresu nie wstrzykuje znaczników na stronę', async () => {
    const { app } = serwerZBaza({ czuwaczArchiwumSprzedazy: { przebieg: async () => ({}) } });
    const r = await app.inject({
      method: 'GET', url: `/faktury?komunikat=${encodeURIComponent('<script>alert(1)</script>')}`, headers: AUTH,
    });
    expect(r.body).not.toContain('<script>alert(1)</script>');
    expect(r.body).toContain('&lt;script&gt;');
  });

  // Brak sekcji INFAKT_ARCHIWUM to tryb POPRAWNY, ale wtedy nie ma czego uruchomic —
  // i odmowa ma to powiedziec zdaniem (jak przy pobieraniu PDF-u bez inFaktu).
  it('POST bez czuwacza = 503 zdaniem', async () => {
    const app = serwer();
    const r = await app.inject({
      method: 'POST', url: '/faktury/archiwum/uruchom', headers: AUTH_POST,
      payload: 'miesiac=2026-08',
    });
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatch(/INFAKT_ARCHIWUM/);
  });

  it('POST bez hasła odmawia', async () => {
    const { app } = serwerZBaza({ czuwaczArchiwumSprzedazy: { przebieg: async () => ({}) } });
    const r = await app.inject({
      method: 'POST', url: '/faktury/archiwum/uruchom',
      headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'miesiac=2026-08',
    });
    expect(r.statusCode).toBe(401);
  });
});

// ——— PACZKA DLA BIURA RACHUNKOWEGO (spec 2026-09-02, Czesc D) ——————————————————————
//
// ⚠️ TRASA SYNCHRONICZNA i taka ma zostac: nic nie laduje na dysku, przegladarka dostaje
// bajty wprost. Cala robota (skad wziac PDF-y, w jakiej kolejnosci je zszyc, kiedy odmowic)
// stoi w `services/paczka-dla-biura.js` — tutaj sprawdzamy WYLACZNIE to, co robi trasa:
// naglowki pobrania, dwie odmowy (zly miesiac, brak uslugi) i przelozenie `dlaOperatora`
// na zdanie z NUMEREM dokumentu, zamiast na piecsetke.
describe('GET /faktury/paczka', () => {
  it('GET /faktury/zestawienie-przychodow oddaje jeden PDF za wybrany miesiąc', async () => {
    const wolania = [];
    const { app } = serwerZBaza({
      paczkaDlaBiura: {
        zbudujZestawieniePrzychodow: async (m) => {
          wolania.push(m);
          return { bajty: Buffer.from('%PDF-1.4 p'), nazwa: `zestawienie-przychodow-${m}.pdf` };
        },
      },
    });
    const r = await app.inject({ method: 'GET', url: '/faktury/zestawienie-przychodow?miesiac=2026-08', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('zestawienie-przychodow-2026-08.pdf');
    expect(wolania).toEqual(['2026-08']);
  });

  it('oddaje PDF z nazwa pliku miesiaca i czesci', async () => {
    const wolania = [];
    const { app } = serwerZBaza({
      paczkaDlaBiura: {
        zbuduj: async (m, czesc) => {
          wolania.push([m, czesc]);
          return {
            bajty: Buffer.from('%PDF-1.4 p'), nazwa: `paczka-dla-biura-${m}-${czesc}.pdf`, dokumentow: 3, stron: 9,
          };
        },
      },
    });
    const r = await app.inject({ method: 'GET', url: '/faktury/paczka?miesiac=2026-08&czesc=sprzedaz', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('paczka-dla-biura-2026-08-sprzedaz.pdf');
    const k = await app.inject({ method: 'GET', url: '/faktury/paczka?miesiac=2026-08&czesc=koszty', headers: AUTH });
    expect(k.headers['content-disposition']).toContain('paczka-dla-biura-2026-08-koszty.pdf');
    // ⚠️ CZESC JEDZIE DO USLUGI, a nie ginie po drodze — bez tego oba odnosniki oddawalyby
    // ten sam plik pod dwiema nazwami.
    expect(wolania).toEqual([['2026-08', 'sprzedaz'], ['2026-08', 'koszty']]);
  });

  // ⚠️⚠️ BRAK CZESCI ODMAWIA, a nie wraca do domyslnej (decyzja wlasciciela 2026-09-02
  // wieczorem: paczka to DWA pliki). Plik sprzedazowy i kosztowy wygladaja identycznie,
  // dopoki sie ich nie otworzy — „niech bedzie sprzedaz" oddawaloby ksiegowej cichaczem
  // nie ten rejestr, o ktory prosila. To ta sama zasada, co przy miesiacu.
  it('brak albo nieznana czesc = 400 zdaniem wymieniajacym oba pliki', async () => {
    let wolan = 0;
    const { app } = serwerZBaza({ paczkaDlaBiura: { zbuduj: async () => { wolan += 1; return {}; } } });
    for (const url of ['/faktury/paczka?miesiac=2026-08', '/faktury/paczka?miesiac=2026-08&czesc=wszystko']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('sprzedaz');
      expect(r.body).toContain('koszty');
    }
    // Odmowa PRZED robota: usluga nie ma po co pytac inFaktu o miesiac, ktorego i tak nie odda.
    expect(wolan).toBe(0);
  });

  // ⚠️ „WSZYSTKO ALBO NIC" MA BYC SLYCHAC. Usluga odmawia z NUMEREM dokumentu, ktorego
  // zabraklo — i ten numer musi dojsc do czlowieka, bo bez niego nie wie, co poprawic
  // przed drugim klknieciem. Ogolne „nie udalo sie" byloby tu bezuzyteczne.
  it('odmowa uslugi (dlaOperatora) = 400 zdaniem', async () => {
    const { app } = serwerZBaza({
      paczkaDlaBiura: {
        zbuduj: async () => {
          const e = new Error('brak dokumentu 2/08/2026');
          e.dlaOperatora = true;
          throw e;
        },
      },
    });
    const r = await app.inject({ method: 'GET', url: '/faktury/paczka?miesiac=2026-08&czesc=sprzedaz', headers: AUTH });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('2/08/2026');
  });

  // ⚠️ MIESIAC W ADRESIE ODMAWIA, a nie wraca do domyslnego — inaczej niz filtr na /faktury
  // wyzej. Powod: to jest POBRANIE PLIKU dla ksiegowej, wiec paczka za inny miesiac niz ten,
  // o ktory ktos poprosil, wygladalaby dokladnie tak samo jak paczka poprawna.
  it('zly miesiac = 400; bez uslugi = 503', async () => {
    const { app } = serwerZBaza({ paczkaDlaBiura: { zbuduj: async () => ({}) } });
    expect((await app.inject({ method: 'GET', url: '/faktury/paczka?miesiac=sierpien&czesc=sprzedaz', headers: AUTH })).statusCode).toBe(400);
    expect((await serwer().inject({ method: 'GET', url: '/faktury/paczka?miesiac=2026-08&czesc=sprzedaz', headers: AUTH })).statusCode).toBe(503);
  });

  // Odnośnik niesie miesiąc, NA KTÓRY OPERATOR PATRZY — inaczej pobrałby zestawienie za
  // miesiąc bieżący, mimo że tabela obok pokazuje inny. Paczki z dokumentami nie mogą wrócić
  // bocznym przyciskiem: właściciel zostawił na tym ekranie tylko samą listę przychodów.
  it('jedyny odnośnik PDF na /faktury prowadzi do zestawienia przychodów wybranego miesiąca', async () => {
    const { app } = serwerZBaza({ paczkaDlaBiura: { zbudujZestawieniePrzychodow: async () => ({}) } });
    const r = await app.inject({ method: 'GET', url: '/faktury?miesiac=2026-07', headers: AUTH });
    expect(r.body).toContain('href="/faktury/zestawienie-przychodow?miesiac=2026-07"');
    expect(r.body).toContain('Pobierz zestawienie (PDF)');
    expect(r.body).not.toContain('Paczka dla biura — sprzedaż (PDF)');
    expect(r.body).not.toContain('Paczka dla biura — koszty (PDF)');
  });

  // ⚠️⚠️ JEDNA PACZKA NARAZ (recenzja calej galezi). Trasa jest SYNCHRONICZNA i potrafi chodzic
  // do minuty (do ~90 pobran z inFaktu), a przegladarka przez ten czas nic nie pokazuje — wiec
  // drugie klikniecie w przycisk jest zachowaniem NORMALNYM, nie bledem operatora. Bez tej
  // blokady dwa przebiegi ciagnelyby rownolegle te same dokumenty z inFaktu i scalaly je
  // w pamieci procesu, ktory obsluguje tez nadania i faktury: dwa razy wiecej zadan do API,
  // dwa razy wiecej bajtow w pamieci — a operator i tak dostaje tylko jeden plik.
  //
  // Ta sama zasada, co straznik „jeden przebieg naraz" w czuwaczach; roznica jest taka, ze tam
  // pomijamy po cichu, a tutaj czlowiek CZEKA i musi zobaczyc, czemu nic nie przyszlo.
  it('⚠️ drugie klikniecie w trakcie skladania = 409, a nie druga paczka', async () => {
    let odblokuj; let wystartowala;
    const wTrakcie = new Promise((res) => { odblokuj = res; });
    // ⚠️ SYNCHRONIZACJA PRZEZ WEJSCIE DO USLUGI, A NIE PRZEZ KOLEJNOSC WYWOLAN. `app.inject`
    // dopiero KOLEJKUJE zadanie (pierwsze wymusza jeszcze `ready()`), wiec bez tej obietnicy
    // drugie zadanie potrafi dojsc do trasy PRZED pierwszym — i test sprawdzalby wtedy zbieg
    // okolicznosci zamiast blokady.
    const wStarcie = new Promise((res) => { wystartowala = res; });
    let wolan = 0;
    const { app } = serwerZBaza({
      paczkaDlaBiura: {
        zbuduj: async (m) => {
          wolan += 1;
          wystartowala();
          await wTrakcie;
          return { bajty: Buffer.from('%PDF-1.4 p'), nazwa: `paczka-dla-biura-${m}.pdf` };
        },
      },
    });
    // ⚠️ ZATRZASK JEST GLOBALNY, NIE „PER CZESC": dwie czesci to te same ~90 dokumentow
    // i ten sam proces, wiec drugie klikniecie w DRUGI przycisk ma sie odbic tak samo.
    const url = '/faktury/paczka?miesiac=2026-08&czesc=sprzedaz';
    const pierwsze = app.inject({ method: 'GET', url, headers: AUTH });
    await wStarcie;
    // Drugie zadanie leci, gdy pierwsze WISI na `zbuduj` — dokladnie tak, jak drugie klikniecie.
    const drugie = await app.inject({ method: 'GET', url: '/faktury/paczka?miesiac=2026-08&czesc=koszty', headers: AUTH });
    expect(drugie.statusCode).toBe(409);
    expect(drugie.body).toContain('składana');
    odblokuj();
    expect((await pierwsze).statusCode).toBe(200);
    // ⚠️ Usluga zawolana RAZ — 409 ma odbic zadanie PRZED robota, a nie po niej.
    expect(wolan).toBe(1);

    // Po skonczeniu pierwszej paczki blokada schodzi: kolejne klikniecie ma dzialac.
    expect((await app.inject({ method: 'GET', url, headers: AUTH })).statusCode).toBe(200);
    expect(wolan).toBe(2);
  });

  // ⚠️ BLOKADA ZWALNIANA W `finally`, tak samo jak w czuwaczach. Zostawiona po bledzie
  // wyciszylaby przycisk NA ZAWSZE — az do restartu panelu, bez ani jednego sladu, a operator
  // widzialby tylko „paczka jest wlasnie skladana" na trasie, ktora nic nie robi.
  it('⚠️ blad skladania NIE zostawia zatrzasnietej blokady', async () => {
    const { app } = serwerZBaza({
      paczkaDlaBiura: {
        zbuduj: async () => { throw new Error('inFakt 500'); },
      },
    });
    const url = '/faktury/paczka?miesiac=2026-08&czesc=sprzedaz';
    expect((await app.inject({ method: 'GET', url, headers: AUTH })).statusCode).toBe(500);
    // Drugie podejscie ma dojsc do uslugi (i znowu sie wywalic), a NIE odbic sie od blokady.
    expect((await app.inject({ method: 'GET', url, headers: AUTH })).statusCode).not.toBe(409);
  });

  // Panel bez inFaktu ma zakladke pusta celowo — i wtedy nie ma czego obiecywac przyciskiem
  // (ta sama zasada, co przy `mozliwyOdswiez` i `mozliwyPdf` na zakladce KOSZTY).
  it('bez uslugi przycisku na /faktury NIE MA', async () => {
    const { app } = serwerZBaza();
    const r = await app.inject({ method: 'GET', url: '/faktury?miesiac=2026-07', headers: AUTH });
    expect(r.body).not.toContain('/faktury/paczka');
  });
});
