import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import {
  DOSTAWY, parsujNoweZamowienie, skopiujFaktureDoWysylki,
} from '../../../src/domena/nowe-zamowienie.js';
import { punktOdbioru, metodaWysylki } from '../../../src/domena/wysylka.js';
import { adresOdbiorcy } from '../../../src/domena/adres-odbiorcy.js';
import { zapiszUstawienia } from '../../../src/oms/db/ustawienia.js';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { dopiszKlienta } from '../../../src/oms/db/klienci.js';

// Poprawki ekranu „Nowe zamówienie" z 07.08.2026 (druga porcja próśb właściciela):
//   • paczkomat na liście dostaw + kod punktu odbioru,
//   • „Skopiuj dane do wysyłki" — ten sam przycisk co na karcie, ale BEZ zapisu,
//   • koszt dostawy domyślnie 19 zł,
//   • nagłówek sekcji skrócony do „Pozycje".

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

const ekran = (url = '/zamowienia/nowe') => app.inject({ method: 'GET', url, headers: naglowek });
const wyslij = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });

describe('paczkomat na ekranie zakładania', () => {
  // ⚠️ Metoda istniała w panelu od 01.08, ale ten ekran jej NIE OFEROWAŁ — zamówienie
  // telefoniczne do paczkomatu trzeba było zakładać jako DPD i poprawiać na karcie.
  it('jest na liście dostaw i widać go w formularzu', async () => {
    expect(DOSTAWY.inpost_paczkomat).toBeTruthy();
    const body = (await ekran()).body;
    expect(body).toContain('value="inpost_paczkomat"');
    expect(body).toContain('name="punkt_odbioru"');
  });

  // ⚠️ KOD PACZKOMATU JEST ADRESEM — zamówienie założone bez niego nie ma czego nadać.
  it('kod punktu zapisuje się z zamówieniem i wielkimi literami', async () => {
    const r = await wyslij('/zamowienia/nowe', {
      w_nazwa: 'Jan Kowalski', dostawa: 'inpost_paczkomat', platnosc: 'przelew',
      punkt_odbioru: ' kty01m ', koszt_dostawy_brutto: '12,90',
      poz_nazwa: 'Lampa', poz_ilosc: '1', poz_cena_brutto: '61.50', poz_sku: '', poz_cena_netto: '',
    });
    expect(r.statusCode).toBeLessThan(400);
    const z = pobierzZamowienie(db, 1);
    expect(metodaWysylki(z)).toBe('inpost_paczkomat');
    expect(punktOdbioru(z)).toBe('KTY01M');
  });

  // ⚠️ Kod zostawiony przy innej dostawie byłby ŚMIECIEM UDAJĄCYM ADRES — ta sama zasada,
  // co w `sprawdzZmianeMetody` na karcie.
  it('przy DPD kod NIE zapisuje się wcale', () => {
    const dane = parsujNoweZamowienie({ dostawa: 'dpd', platnosc: 'przelew', punkt_odbioru: 'KTY01M' });
    expect(dane.punkt_odbioru).toBeNull();
  });

  it('pusty kod przy paczkomacie zostaje pusty, nie pustym napisem', () => {
    const dane = parsujNoweZamowienie({ dostawa: 'inpost_paczkomat', platnosc: 'przelew', punkt_odbioru: '   ' });
    expect(dane.punkt_odbioru).toBeNull();
  });
});

describe('„Skopiuj dane do wysyłki" przy zakładaniu', () => {
  const faktura = {
    f_firma: 'Zetaklient Drogowe sp. z o.o.', f_ulica: 'Przemysłowa 4', f_kod: '00-650',
    f_miasto: 'Pęki', f_email: 'faktury@zetaklient.pl',
  };

  it('przepisuje firmę, adres i e-mail', () => {
    const wynik = skopiujFaktureDoWysylki({ ...faktura, w_nazwa: 'Jan Kowalski', w_telefon: '600100200' });
    expect(wynik).toMatchObject({
      w_firma: 'Zetaklient Drogowe sp. z o.o.', w_ulica: 'Przemysłowa 4',
      w_kod: '00-650', w_miasto: 'Pęki', w_email: 'faktury@zetaklient.pl',
    });
  });

  // ⚠️ Kurier wymaga OSOBY DO KONTAKTU, a dane faktury jej nie niosą — nadpisanie
  // zostawiłoby paczkę bez nikogo, kogo można zapytać o drzwi.
  it('imienia, nazwiska ani telefonu NIE RUSZA', () => {
    const wynik = skopiujFaktureDoWysylki({ ...faktura, w_nazwa: 'Jan Kowalski', w_telefon: '600100200' });
    expect(wynik.w_nazwa).toBe('Jan Kowalski');
    expect(wynik.w_telefon).toBe('600100200');
  });

  // Pusty e-mail z faktury nie ma prawa skasować adresu, pod który idzie powiadomienie o paczce.
  it('pusty e-mail faktury zostawia e-mail wysyłki', () => {
    const wynik = skopiujFaktureDoWysylki({ ...faktura, f_email: '  ', w_email: 'jan@dom.pl' });
    expect(wynik.w_email).toBe('jan@dom.pl');
  });

  it('nie rusza pozycji ani reszty formularza', () => {
    const wynik = skopiujFaktureDoWysylki({ ...faktura, poz_nazwa: ['A', 'B'], koszt_dostawy_brutto: '19,00' });
    expect(wynik.poz_nazwa).toEqual(['A', 'B']);
    expect(wynik.koszt_dostawy_brutto).toBe('19,00');
  });

  it('trasa oddaje formularz z wypełnionymi polami i NICZEGO nie zapisuje', async () => {
    const r = await wyslij('/zamowienia/nowe/kopiuj-do-wysylki', { ...faktura, w_nazwa: 'Jan Kowalski' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="w_firma" value="Zetaklient Drogowe sp. z o.o."');
    expect(r.body).toContain('name="w_miasto" value="Pęki"');
    // Ani jednego zamówienia w bazie — przycisk tylko przestawia pola.
    expect(db.prepare('SELECT COUNT(*) AS ile FROM zamowienia').get().ile).toBe(0);
  });

  it('przycisk stoi na ekranie', async () => {
    expect((await ekran()).body).toContain('/zamowienia/nowe/kopiuj-do-wysylki');
  });

  // Sedno: po skopiowaniu i zapisie paczka jedzie POD ADRES Z FAKTURY.
  it('po skopiowaniu i zapisie adres paczki jest adresem z faktury', async () => {
    const skopiowany = skopiujFaktureDoWysylki({ ...faktura, w_nazwa: 'Jan Kowalski', w_telefon: '600100200' });
    await wyslij('/zamowienia/nowe', { ...skopiowany, dostawa: 'dpd', platnosc: 'przelew' });
    const adres = adresOdbiorcy(pobierzZamowienie(db, 1));
    expect(adres).toMatchObject({ nazwa: 'Jan Kowalski', ulica: 'Przemysłowa 4', miasto: 'Pęki' });
  });
});

describe('koszt dostawy domyślnie 19 zł', () => {
  it('puste wejście na ekran podstawia 19,00', async () => {
    expect((await ekran()).body).toContain('name="koszt_dostawy_brutto" value="19,00"');
  });

  // ⚠️ ODRÓŻNIENIE „pierwsze wejście" od „operator ŚWIADOMIE wyczyścił pole". Formularz wraca
  // do operatora po GUS-ie, po skopiowaniu danych i po odmowie zapisu — podstawienie 19 zł
  // drugi raz przywracałoby kwotę, którą właśnie skasował.
  it('wyczyszczone pole zostaje puste po powrocie formularza', async () => {
    const r = await wyslij('/zamowienia/nowe/kopiuj-do-wysylki', { koszt_dostawy_brutto: '' });
    expect(r.body).toContain('name="koszt_dostawy_brutto" value=""');
    expect(r.body).not.toContain('name="koszt_dostawy_brutto" value="19,00"');
  });

  it('wpisana własna kwota wraca nietknięta', async () => {
    const r = await wyslij('/zamowienia/nowe/kopiuj-do-wysylki', { koszt_dostawy_brutto: '8,90' });
    expect(r.body).toContain('name="koszt_dostawy_brutto" value="8,90"');
  });

  it('domyślne 19 zł naprawdę ląduje w zamówieniu, gdy nikt go nie tknie', async () => {
    await wyslij('/zamowienia/nowe', {
      w_nazwa: 'Jan', dostawa: 'dpd', platnosc: 'przelew', koszt_dostawy_brutto: '19,00',
    });
    expect(pobierzZamowienie(db, 1).koszt_dostawy_brutto).toBe('19.00');
  });
});

describe('nagłówek sekcji pozycji', () => {
  it('to sam „Pozycje", bez dopisku', async () => {
    const body = (await ekran()).body;
    expect(body).toContain('<h2>Pozycje</h2>');
    expect(body).not.toContain('co spakować');
  });
});

describe('podgląd kwoty jest podpięty do strony', () => {
  it('tabela ma znacznik podglądu, wiersz „Razem" i skrypt z pliku', async () => {
    const body = (await ekran()).body;
    expect(body).toContain('data-podglad-kwoty');
    expect(body).toContain('data-suma-linii');
    expect(body).toContain('data-razem');
    // ⚠️ Z PLIKU, nie ze skryptu w stronie — inaczej test w suma-podglad.test.js pilnowałby
    // kopii reguły zamiast kodu, który naprawdę wykonuje przeglądarka.
    expect(body).toContain('<script type="module" src="/public/suma-podglad.js"></script>');
  });

  it('plik podglądu jest naprawdę serwowany', async () => {
    const r = await app.inject({ method: 'GET', url: '/public/suma-podglad.js', headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('kwotaFormularzaGrosze');
  });
});

describe('koszt dostawy z ustawień', () => {
  it('pole startuje kwotą DPD z ustawień', async () => {
    zapiszUstawienia(db, { 'dostawa.dpd': '2500' });

    const r = await ekran();

    expect(r.body).toContain('name="koszt_dostawy_brutto" value="25,00"');
  });

  // ⚠️ Bez ustawień ekran zachowuje się DOKŁADNIE jak przed zmianą.
  it('bez ustawień pole startuje kwotą 19,00', async () => {
    const r = await ekran();

    expect(r.body).toContain('name="koszt_dostawy_brutto" value="19,00"');
  });

  // ⚠️ TO JEST POWÓD, DLA KTÓREGO TA FUNKCJA POWSTAŁA. Sama wartość startowa nie pomaga przy
  // paczkomacie — przełączenie metody musi zmienić kwotę, a robi to skrypt czytający mapę.
  it('mapa metoda → kwota jedzie do przeglądarki i zgadza się z ustawieniami', async () => {
    zapiszUstawienia(db, { 'dostawa.dpd': '1900', 'dostawa.inpost_paczkomat': '1300', 'dostawa.odbior_osobisty': '0' });

    const r = await ekran();
    const i = r.body.indexOf('id="kwoty-dostawy"');
    expect(i, 'brak mapy kwot dostawy w stronie').toBeGreaterThan(-1);
    const mapa = JSON.parse(r.body.slice(r.body.indexOf('>', i) + 1, r.body.indexOf('</script>', i)));

    expect(mapa).toEqual({ dpd: '19,00', inpost_paczkomat: '13,00', odbior_osobisty: '0,00' });
  });

  // ⚠️ POLE ŚWIADOMIE WYCZYSZCZONE ZOSTAJE PUSTE. `=== undefined` odróżnia pierwsze wejście
  // na ekran od nawrotu formularza — podstawienie kwoty drugi raz przywracałoby wartość,
  // którą operator właśnie skasował.
  it('po nawrocie formularza wyczyszczone pole zostaje puste', async () => {
    zapiszUstawienia(db, { 'dostawa.dpd': '2500' });

    const r = await wyslij('/zamowienia/nowe/kopiuj-do-wysylki', { koszt_dostawy_brutto: '' });

    expect(r.body).toContain('name="koszt_dostawy_brutto" value=""');
    expect(r.body).not.toContain('name="koszt_dostawy_brutto" value="25,00"');
  });

  // ⚠️ NAWRÓT FORMULARZA NIESIE WYBRANĄ METODĘ, więc pole startowe ma iść ZA NIĄ, a nie
  // za DPD — inaczej operator zakładający zamówienie do paczkomatu po odmowie zapisu
  // dostawałby z powrotem kwotę kuriera.
  it('wybrany paczkomat startuje kwotą paczkomatu, nie kwotą DPD', async () => {
    zapiszUstawienia(db, { 'dostawa.dpd': '1900', 'dostawa.inpost_paczkomat': '1300' });

    const r = await wyslij('/zamowienia/nowe/kopiuj-do-wysylki', { dostawa: 'inpost_paczkomat' });

    expect(r.body).toContain('name="koszt_dostawy_brutto" value="13,00"');
  });
});

// ——— EKRAN NIE SKACZE DO GÓRY (21.08.2026, zgłoszenie właściciela: „bardzo denerwujące przy
// dodawaniu zamówienia jest to, że ekran co chwilę skacze do góry przy dodaniu jakiejś opcji").
//
// ⚠️ PRZYCZYNĄ NIE JEST BRAK SKRYPTÓW, tylko natura tych przycisków: każdy wysyła CAŁY
// formularz, więc serwer renderuje stronę od nowa i przeglądarka ląduje na jej górze.
// Lekarstwo jest BEZ JavaScriptu — `formaction` z KOTWICĄ: przeglądarka nawiguje pod adres
// z fragmentem, więc po wyrenderowaniu odpowiedzi ustawia się tam, gdzie operator pracował.
//
// ⚠️ Test pilnuje MECHANIZMU, nie wyglądu. Kotwica zgubiona przy następnej zmianie szablonu
// wraca dokładnie do tej samej uciążliwości, a nic jej nie zgłosi — kotwica bez elementu też
// nie jest błędem HTML-a, po prostu cicho nic nie robi.
describe('ekran zakładania nie skacze do góry', () => {
  // Przyciski, które są na ekranie ZAWSZE.
  it.each([
    ['/zamowienia/nowe/kopiuj-do-wysylki#wysylka', 'wysylka'],
    ['/zamowienia/nowe/magazyn#magazyn', 'magazyn'],
  ])('%s wraca na swoje miejsce', async (adres, id) => {
    const body = (await ekran()).body;
    expect(body).toContain(`formaction="${adres}"`);
    expect(body).toContain(`id="${id}"`);
  });

  // ⚠️ „Pobierz z GUS" istnieje WYŁĄCZNIE przy skonfigurowanym GUS-ie, a „Wstaw dane" —
  // wyłącznie gdy baza klientów nie jest pusta. Test bez tych warunków przechodziłby na
  // ekranie, na którym tych przycisków po prostu nie ma.
  it('„Pobierz z GUS" wraca do danych faktury', async () => {
    const zGusem = buildOmsServer({ db, config, poller, gus: { firmaPoNip: async () => null } });
    await zGusem.ready();
    const body = (await zGusem.inject({ method: 'GET', url: '/zamowienia/nowe', headers: naglowek })).body;
    expect(body).toContain('formaction="/zamowienia/nowe/gus#faktura"');
    expect(body).toContain('id="faktura"');
  });

  it('„Wstaw dane" stałego klienta wraca do paska wyboru', async () => {
    dopiszKlienta(db, {
      klucz: 'betamet', nazwa: 'BETAMET sp. z o.o.', nip: '1000001023', b2b: 1, rabat_procent: 0,
      chce_fakture: 1, metoda_wysylki: 'dpd', koszt_dostawy_brutto: '19.00', platnosc: 'przelew',
      termin_platnosci: '14', komentarz: null, aktywny: 1, faktura: {}, wysylka: {},
    });
    const body = (await ekran()).body;
    expect(body).toContain('formaction="/zamowienia/nowe/klient#klient"');
    expect(body).toContain('id="klient"');
  });

  // ⚠️ „Dodaj" pojawia się dopiero przy WYNIKACH szukania — i to jest ten przycisk, który
  // klika się pięć razy pod rząd, więc jego kotwica boli najbardziej.
  it('„Dodaj" z magazynu wraca do wyszukiwarki i potwierdza, co dodał', async () => {
    zapiszProduktSklepowy(db, {
      kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', nazwa: 'Lampa stołowa Grzybek',
      sku_sklepu: 'LMP-GRZ-30', cena_gr: 7490, rozmiar_tekst: '30x45', kategorie: [], zdjecia: [],
      adres: 'https://szkicownia.pl/produkt/grzybek', odczytane_at: '2026-08-21T08:00:00',
    });
    const zWynikami = await wyslij('/zamowienia/nowe/magazyn', { magazyn: 'grzybek', cennik: 'szkicownia' });
    expect(zWynikami.body).toContain('formaction="/zamowienia/nowe/magazyn/dodaj#magazyn"');

    const poDodaniu = await wyslij('/zamowienia/nowe/magazyn/dodaj', {
      magazyn: 'grzybek', cennik: 'szkicownia', wybrany: '0',
      mag_kanal: 'szkicownia', mag_produkt_id: '28040', mag_wariant_id: '', mag_ilosc: '3',
    });
    // Potwierdzenie stoi przy wyszukiwarce, bo tam wraca ekran — dopisana pozycja jest wyżej,
    // często poza widokiem.
    expect(poDodaniu.body).toMatch(/Dodano do zamówienia:[\s\S]{0,120}Lampa stołowa Grzybek/);
  });
});
