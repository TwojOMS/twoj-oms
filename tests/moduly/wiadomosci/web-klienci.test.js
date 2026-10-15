import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { pobierzZamowienie, dodajPozycjeReczna, zapiszFaktyStatusu } from '../../../src/oms/db/zamowienia.js';
import { przeliczKwoteRecznego } from '../../../src/oms/db/zamowienia-reczne.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';
import { wszyscyKlienci, klientPoNip } from '../../../src/oms/db/klienci.js';

const config = { auth: { user: 'adam', pass: 'x' }, sprzedawca: { nazwa: 'Lumina Marek Zywiecki' } };
const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-08-21T09:00:00', ostatni_blad: null }) };

let db;
let app;
let gus;

// ⚠️ ATRAPA GUS-u, NIGDY PRAWDZIWY REGON. Test chodzacy po sieci zalezalby od tego, czy
// akurat dziala internet i czy BIR nie ma przerwy — a odpowiedz i tak trzeba by udawac,
// zeby sprawdzic obie galezie („znaleziono" i „nie znaleziono").
function atrapaGus({ firma = null, rzuca = null } = {}) {
  const pytania = [];
  return {
    pytania,
    firmaPoNip: async (nip) => {
      pytania.push(nip);
      if (rzuca) throw new Error(rzuca);
      return firma;
    },
  };
}

async function zbuduj({ gusKlient = atrapaGus() } = {}) {
  gus = gusKlient;
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller, gus: gusKlient });
  await app.ready();
}

beforeEach(() => zbuduj());

const post = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });
const get = (url) => app.inject({ method: 'GET', url, headers: naglowek });

// BETAMET — klient z prawdziwego zgloszenia (21.08.2026): zamowienie mailem, wysylka gratis,
// FV przelew 14 dni, kanal B2B.
const BETAMET = {
  nazwa: 'BETAMET sp. z o.o.', klucz: 'betamet', nip: '100-00-01-023',
  f_firma: 'BETAMET sp. z o.o.', f_ulica: 'Fabryczna 4', f_kod: '00-650', f_miasto: 'Pęki',
  f_email: 'faktury@betamet.pl',
  w_nazwa: 'Jan Kowalski', w_firma: 'BETAMET sp. z o.o.', w_ulica: 'Fabryczna 4',
  w_kod: '00-650', w_miasto: 'Pęki', w_telefon: '600100200', w_email: 'zamowienia@betamet.pl',
  b2b: 'on', rabat_procent: '30', chce_fakture: 'on',
  metoda_wysylki: 'dpd', koszt_dostawy_brutto: '0', platnosc: 'przelew', termin_platnosci: '14',
};

const dopisz = (nad = {}) => post('/klienci', { ...BETAMET, ...nad });

describe('baza stałych klientów', () => {
  it('dopisuje klienta i pokazuje go na liście', async () => {
    expect((await dopisz()).statusCode).toBe(302);
    const [k] = wszyscyKlienci(db);
    expect(k.nazwa).toBe('BETAMET sp. z o.o.');
    // ⚠️ NIP LEZY ZNORMALIZOWANY — same cyfry. Zapisany z myslnikami nie dopasowalby sie
    // do niczego, a wlasnie dopasowanie jest jedynym powodem tej kolumny.
    expect(k.nip).toBe('1000001023');
    expect(k.b2b).toBe(1);
    expect(k.rabat_procent).toBe(30);
    expect(k.koszt_dostawy_brutto).toBe('0.00');
    expect((await get('/klienci')).body).toContain('BETAMET');
  });

  it('klucz wyprowadza się z nazwy, gdy pole zostanie puste', async () => {
    await dopisz({ klucz: '', nazwa: 'Zetaklient Drogowe', nip: '' });
    expect(wszyscyKlienci(db)[0].klucz).toBe('zetaklient-drogowe');
  });

  // ⚠️ DWA WPISY NA JEDEN NIP to nie „duplikat do posprzatania", tylko dwa komplety danych
  // na jeden podmiot — a wtedy podpowiadanie musialoby wybrac jeden z nich i zrobiloby to
  // po cichu. Komunikat ma tlumaczyc, co zrobic, a nie mowic „UNIQUE constraint failed".
  it('drugi klient na ten sam NIP dostaje odmowę, która mówi co zrobić', async () => {
    await dopisz();
    const odp = await dopisz({ klucz: 'betamet-2', nazwa: 'BETAMET druga próba' });
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/ma już w bazie innego klienta/);
    expect(wszyscyKlienci(db)).toHaveLength(1);
  });

  it('dwóch klientów BEZ NIP-u to normalny stan, nie kolizja', async () => {
    await dopisz({ klucz: 'aa', nazwa: 'Anna Kowalska', nip: '', f_nip: '' });
    await dopisz({ klucz: 'bb', nazwa: 'Piotr Nowak', nip: '', f_nip: '' });
    expect(wszyscyKlienci(db)).toHaveLength(2);
  });

  it('rabat spoza zakresu odbija się z komunikatem i oddaje formularz', async () => {
    const odp = await dopisz({ rabat_procent: '150' });
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/dopuszczalne/);
    // Formularz WRACA wypelniony — piecnascie pol skasowanych komunikatem byloby kara
    // za literowke w jednym z nich.
    expect(odp.body).toContain('BETAMET sp. z o.o.');
  });

  // ⚠️ EKRAN ISTNIEJE PO TO, ZEBY ZOBACZYC BAZE (21.08.2026, prosba wlasciciela: „na gorze
  // strony lista klientow + przycisk Dodaj nowego klienta"). Formularz jest tu czynnoscia
  // rzadka — klient dopisuje sie zwykle przyciskiem na karcie zamowienia.
  it('lista jest od razu, a formularza domyślnie NIE MA', async () => {
    await dopisz();
    const body = (await get('/klienci')).body;
    expect(body).toContain('BETAMET sp. z o.o.');
    expect(body).toContain('Dodaj nowego klienta');
    // Pole `klucz` istnieje WYLACZNIE w formularzu — jego brak jest dowodem, ze formularz
    // sie nie rozwinal. Sam napis „Nowy stały klient" byłby slabszym sprawdzianem: mogłby
    // zostac w naglowku ukrytej sekcji.
    expect(body).not.toContain('name="klucz"');
  });

  it('„Dodaj nowego klienta" rozwija pusty formularz', async () => {
    const body = (await get('/klienci?nowy')).body;
    expect(body).toContain('name="klucz"');
    expect(body).toContain('Nowy stały klient');
    expect(body).toContain('Dopisz klienta');
  });

  // ⚠️ ADRES ZMIENIONY 21.08.2026: goly `/klienci/:id` nalezy teraz do KARTY klienta,
  // a formularz stoi pod `/klienci/:id/edytuj` (przycisk mowi „Edytuj", nie „Popraw").
  it('„Edytuj" rozwija formularz wypełniony danymi klienta', async () => {
    await dopisz();
    const { id } = wszyscyKlienci(db)[0];
    const body = (await get(`/klienci/${id}/edytuj`)).body;
    expect(body).toContain('name="klucz"');
    expect(body).toContain('value="betamet"');
    expect(body).toContain('Zapisz zmiany');
  });

  // ⚠️ Odmowa z ZAMKNIETYM formularzem pokazywalaby komunikat o polu, ktorego na ekranie nie ma.
  it('odmowa zostawia formularz otwarty razem z tym, co wpisano', async () => {
    const odp = await dopisz({ rabat_procent: '150' });
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toContain('name="klucz"');
    expect(odp.body).toContain('value="betamet"');
  });

  it('wygaszony klient znika z podpowiedzi, ale zostaje na ekranie klientów', async () => {
    await dopisz();
    const { id } = wszyscyKlienci(db)[0];
    await post('/klienci', { ...BETAMET, id: String(id), aktywny: '' });
    expect(wszyscyKlienci(db)).toHaveLength(0);
    expect(wszyscyKlienci(db, { tylkoAktywni: false })).toHaveLength(1);
    expect((await get('/klienci')).body).toContain('wygaszony');
  });
});

describe('wstawienie danych do nowego zamówienia', () => {
  beforeEach(() => dopisz());

  it('wypełnia oba komplety pól i ustalenia handlowe', async () => {
    const odp = await post('/zamowienia/nowe/klient', { klient_klucz: 'betamet' });
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('Fabryczna 4');
    expect(odp.body).toContain('faktury@betamet.pl');
    expect(odp.body).toContain('zamowienia@betamet.pl');
    expect(odp.body).toContain('value="30"');
    // Opis pod paskiem mowi WPROST o wysylce gratis — to jedyne ustalenie, ktorego po
    // wstawieniu nie widac w wypelnionym polu (zero wyglada jak pole niewypelnione).
    expect(odp.body).toMatch(/wysyłka gratis/);
  });

  // ⚠️⚠️ NIC NIE ZAPISUJE. Zamowienie powstaje wylacznie przyciskiem „Zaloz zamowienie" —
  // szukanie klienta nie ma prawa nadac numeru, ktorego nie da sie zwolnic.
  it('NIE zakłada żadnego zamówienia', async () => {
    await post('/zamowienia/nowe/klient', { klient_klucz: 'betamet' });
    expect(db.prepare('SELECT COUNT(*) AS ile FROM zamowienia').get().ile).toBe(0);
  });

  // ⚠️⚠️ WSTAWIENIE NADPISUJE — i to jest cala tresc tego przycisku. Wstawianie „tylko w puste
  // pola" brzmi ostrozniej, a jest gorsze: operator dostalby komplet pomieszany z dwoch zrodel
  // i nie mialby jak stwierdzic, ktore pole jest ktore. Dlatego pasek stoi NAD polami — zeby
  // reka trafiala tam ZANIM zacznie wpisywac.
  it('nadpisuje to, co operator zdążył wpisać — i nie dotyka pozycji', async () => {
    const odp = await post('/zamowienia/nowe/klient', {
      klient_klucz: 'betamet',
      w_ulica: 'Zupełnie inna 1', f_firma: 'Wpisane wcześniej sp. z o.o.',
      poz_nazwa: 'Szablon dodany wcześniej', poz_ilosc: '3', poz_cena_brutto: '74.90',
    });
    expect(odp.body).not.toContain('Zupełnie inna 1');
    expect(odp.body).not.toContain('Wpisane wcześniej sp. z o.o.');
    expect(odp.body).toContain('Fabryczna 4');
    // ⚠️ POZYCJE ZOSTAJA NIETKNIETE. Klient bywa wybierany PO dodaniu towaru z magazynu
    // i skasowanie wtedy pozycji byloby najgorszym mozliwym momentem.
    expect(odp.body).toContain('Szablon dodany wcześniej');
  });

  it('nieznany klucz odmawia i oddaje formularz z powrotem', async () => {
    const odp = await post('/zamowienia/nowe/klient', { klient_klucz: 'nie-ma', w_nazwa: 'Wpisane ręcznie' });
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toContain('Wpisane ręcznie');
  });

  it('założone zamówienie niesie B2B, termin i rabat', async () => {
    const wstawione = await post('/zamowienia/nowe/klient', { klient_klucz: 'betamet' });
    expect(wstawione.statusCode).toBe(200);
    await post('/zamowienia/nowe', {
      w_nazwa: 'Jan Kowalski', f_firma: 'BETAMET sp. z o.o.', f_nip: '1000001023',
      dostawa: 'dpd', platnosc: 'przelew', koszt_dostawy_brutto: '0',
      b2b: 'on', termin_platnosci: '14', rabat_procent: '30',
      poz_nazwa: 'Szablon inwalida 30x30', poz_ilosc: '10', poz_cena_brutto: '52.43',
      poz_cena_katalogowa: '74.90', poz_produkt_id: '', poz_wariant_id: '', poz_sku: '', poz_cena_netto: '',
    });
    const z = pobierzZamowienie(db, 1);
    expect(z.b2b).toBe(1);
    expect(z.termin_platnosci).toBe('14');
    expect(z.rabat_procent).toBe(30);
    expect(z.kwota_brutto).toBe('524.30');
    // Cena katalogowa przetrwala droge przez formularz — bez niej rabatu nie da sie ani
    // pokazac, ani przeliczyc, ani cofnac.
    expect(z.pozycje[0].cena_katalogowa).toBe('74.90');
  });
});

describe('zapamiętaj tego klienta', () => {
  const zalozZamowienie = () => zalozZamowienieReczne({
    db,
    znacznik: '2026-08-21T09:00:00.000Z',
    dane: {
      klient: { first_name: 'Jan', last_name: 'Kowalski', company: 'BETAMET sp. z o.o.', address_1: 'Fabryczna 4', postcode: '00-650', city: 'Pęki', email: 'zamowienia@betamet.pl' },
      dostawa: { first_name: 'Jan', last_name: 'Kowalski', company: 'BETAMET sp. z o.o.', address_1: 'Fabryczna 4', postcode: '00-650', city: 'Pęki' },
      nip: '1000001023', chce_fakture: 1, metoda_wysylki: 'dpd', koszt_dostawy_brutto: '0.00',
      metoda_platnosci: 'Przelew', b2b: 1, termin_platnosci: '14', rabat_procent: 0, pozycje: [],
    },
  });

  it('zakłada wpis z danych zamówienia', async () => {
    const { id } = zalozZamowienie();
    expect((await post(`/zamowienia/${id}/klient/zapamietaj`)).statusCode).toBe(302);
    const k = klientPoNip(db, '1000001023');
    expect(k.nazwa).toBe('BETAMET sp. z o.o.');
    expect(k.faktura.ulica).toBe('Fabryczna 4');
    expect(k.b2b).toBe(1);
  });

  // ⚠️ DRUGI KLIK MA UAKTUALNIC, A NIE ODBIC SIE OD INDEKSU UNIKALNEGO komunikatem
  // o duplikacie, ktorego operator nie zamawial.
  it('drugi raz uaktualnia, nie dubluje', async () => {
    const { id } = zalozZamowienie();
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    expect(wszyscyKlienci(db)).toHaveLength(1);
  });

  // ⚠️⚠️ MIGAWKA, NIE LACZE. Zmiana adresu w bazie klientow NIE MA PRAWA ruszyc adresu na
  // fakturze wystawionej trzy tygodnie temu.
  it('późniejsza poprawka w bazie NIE zmienia adresu na istniejącym zamówieniu', async () => {
    const { id } = zalozZamowienie();
    await post(`/zamowienia/${id}/klient/zapamietaj`);
    const k = klientPoNip(db, '1000001023');
    await post('/klienci', { ...BETAMET, id: String(k.id), f_ulica: 'Nowa 99', w_ulica: 'Nowa 99' });

    expect(klientPoNip(db, '1000001023').faktura.ulica).toBe('Nowa 99');
    expect(pobierzZamowienie(db, id).klient.address_1).toBe('Fabryczna 4');
    expect((await get(`/zamowienia/${id}`)).body).toContain('Fabryczna 4');
  });
});

describe('zmiana ustaleń na karcie', () => {
  const zZamowieniem = () => {
    const { id } = zalozZamowienieReczne({
      db,
      znacznik: '2026-08-21T09:00:00.000Z',
      dane: {
        klient: { email: 'zamowienia@betamet.pl' }, dostawa: { first_name: 'Jan', last_name: 'Kowalski', city: 'Pęki' },
        metoda_wysylki: 'dpd', koszt_dostawy_brutto: '0.00', metoda_platnosci: 'Przelew', pozycje: [],
      },
    });
    dodajPozycjeReczna(db, id, {
      nazwa: 'Szablon inwalida 30x30', sku: 'SZ-INW-30', ilosc: 10,
      cena_brutto: '74.90', brutto_linii: '749.00', cena_katalogowa: '74.90',
    });
    dodajPozycjeReczna(db, id, {
      nazwa: 'Usługa projektowa', sku: null, ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00',
    });
    przeliczKwoteRecznego(db, id);
    return id;
  };

  it('rabat przelicza pozycje z magazynu i podnosi kwotę zamówienia w dół', async () => {
    const id = zZamowieniem();
    expect(pobierzZamowienie(db, id).kwota_brutto).toBe('849.00');

    expect((await post(`/zamowienia/${id}/ustalenia`, { b2b: 'on', termin_platnosci: '14', rabat_procent: '30' })).statusCode).toBe(302);

    const z = pobierzZamowienie(db, id);
    expect(z.rabat_procent).toBe(30);
    expect(z.b2b).toBe(1);
    expect(z.termin_platnosci).toBe('14');
    // 52,43 × 10 = 524,30, plus nietknięta usługa 100,00.
    expect(z.kwota_brutto).toBe('624.30');
  });

  // ⚠️⚠️ POZYCJA WPISANA Z REKI ZOSTAJE NIETKNIETA — i dziennik ma o tym powiedzieć wprost.
  it('pozycji bez ceny katalogowej nie dotyka i mówi o tym w dzienniku', async () => {
    const id = zZamowieniem();
    await post(`/zamowienia/${id}/ustalenia`, { rabat_procent: '30' });
    const poz = pobierzZamowienie(db, id).pozycje;
    expect(poz.find((p) => p.nazwa === 'Usługa projektowa').cena_brutto).toBe('100.00');
    const log = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'ustalenia'").get(id);
    expect(log.wynik).toMatch(/849,00 zł → 624,30 zł|849.00 zł → 624.30 zł/);
  });

  // ⚠️ TO JEST DROGA POWROTU PO POMYLCE — i dziala wylacznie dlatego, ze cena katalogowa
  // jest zapisana przy pozycji.
  it('rabat 0 przywraca ceny katalogowe co do grosza', async () => {
    const id = zZamowieniem();
    await post(`/zamowienia/${id}/ustalenia`, { rabat_procent: '30' });
    await post(`/zamowienia/${id}/ustalenia`, { rabat_procent: '0' });
    expect(pobierzZamowienie(db, id).kwota_brutto).toBe('849.00');
  });

  // ⚠️⚠️ NAJWAZNIEJSZY TEST TEJ FUNKCJI. Operator wynegocjowal z klientem inna kwote na JEDNA
  // rzecz; automat uruchomiony przy zupelnie innej okazji (zmiana rabatu) nie ma prawa mu jej
  // skasowac. Ta sama regula, co w skrypcie kosztu dostawy: „podmieniamy wylacznie to, co sami
  // wpisalismy".
  it('cena wystukana ręcznie po rabacie przeżywa kolejną zmianę rabatu', async () => {
    const id = zZamowieniem();
    await post(`/zamowienia/${id}/ustalenia`, { rabat_procent: '30' });

    // Edycja idzie TA SAMA droga, co na karcie: formularz „Zapisz pozycje" odsyla WSZYSTKIE
    // wiersze rownoleglymi tablicami (domain/pozycje-reczne.js: parsujHurtPozycji).
    const poz = pobierzZamowienie(db, id).pozycje;
    const zapis = await post(`/zamowienia/${id}/pozycje/zapisz`, {
      klucz: poz.map((p) => p.klucz),
      nazwa: poz.map((p) => p.nazwa),
      ilosc: poz.map((p) => String(p.ilosc)),
      cena_brutto: poz.map((p) => (p.cena_katalogowa ? '50.00' : p.cena_brutto)),
    });
    expect(zapis.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).pozycje.find((p) => p.cena_katalogowa).cena_brutto).toBe('50.00');

    await post(`/zamowienia/${id}/ustalenia`, { rabat_procent: '10' });
    const po = pobierzZamowienie(db, id).pozycje.find((p) => p.cena_katalogowa);
    expect(po.cena_brutto).toBe('50.00');
  });

  it('rabat ułamkowy odbija się komunikatem i niczego nie zapisuje', async () => {
    const id = zZamowieniem();
    const odp = await post(`/zamowienia/${id}/ustalenia`, { rabat_procent: '7,5' });
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/pełnym procentem/);
    expect(pobierzZamowienie(db, id).rabat_procent).toBe(0);
    expect(pobierzZamowienie(db, id).kwota_brutto).toBe('849.00');
  });

  it('karta pokazuje cenę katalogową obok ceny po rabacie', async () => {
    const id = zZamowieniem();
    await post(`/zamowienia/${id}/ustalenia`, { rabat_procent: '30' });
    const body = (await get(`/zamowienia/${id}`)).body;
    expect(body).toContain('cena-katalogowa');
    expect(body).toContain('74.90');
    expect(body).toContain('52.43');
    expect(body).toMatch(/Rabat stałego klienta/);
  });
});

// ——— POBIERZ Z GUS I SKOPIUJ DO WYSYLKI (21.08.2026, prosba wlasciciela: „przy dodawaniu
// nowego klienta zrob wyszukiwanie w GUS po NIP tak jak jest w karcie zamowienia
// + przycisk skopiuj dane do wysylki").
describe('pobierz z GUS na ekranie klientów', () => {
  const FIRMA = {
    firma: '„BETAMET" SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
    nip: '1000001023',
    ulica: 'Fabryczna 4',
    kod: '00-650',
    miasto: 'Pęki',
    regon: '123456789',
  };

  it('wypełnia pola faktury i zostawia formularz otwarty', async () => {
    await zbuduj({ gusKlient: atrapaGus({ firma: FIRMA }) });
    const odp = await post('/klienci/gus', { f_nip: '100-00-01-023', nazwa: '' });
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('Fabryczna 4');
    expect(odp.body).toContain('00-650');
    expect(odp.body).toContain('REGON 123456789');
    expect(odp.body).toContain('name="klucz"');
    // NIP idzie do zapytania ZNORMALIZOWANY — z myślnikami REGON nie znajdzie niczego.
    expect(gus.pytania).toEqual(['1000001023']);
  });

  // ⚠️⚠️ NIC NIE ZAPISUJE. Ta sama obietnica, co przy dwóch pozostałych kopiach tego
  // przycisku: pobranie z GUS-u wypełnia pola do sprawdzenia, a nie zakłada klienta.
  it('NIE zapisuje klienta', async () => {
    await zbuduj({ gusKlient: atrapaGus({ firma: FIRMA }) });
    await post('/klienci/gus', { f_nip: '1000001023', nazwa: 'BETAMET' });
    expect(wszyscyKlienci(db, { tylkoAktywni: false })).toHaveLength(0);
  });

  // ⚠️ `nazwa` to WŁASNA etykieta operatora na listę wyboru, a REGON oddaje nazwę urzędową
  // w całej okazałości. Pusta uzupełnia się z GUS-u, wpisana ZOSTAJE.
  it('pustą nazwę uzupełnia z GUS-u, a wpisanej nie rusza', async () => {
    await zbuduj({ gusKlient: atrapaGus({ firma: FIRMA }) });
    expect((await post('/klienci/gus', { f_nip: '1000001023', nazwa: '' })).body)
      .toContain('SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ');
    const zWlasna = await post('/klienci/gus', { f_nip: '1000001023', nazwa: 'BETAMET sp. z o.o.' });
    expect(zWlasna.body).toContain('value="BETAMET sp. z o.o."');
  });

  it('nieznany NIP mówi wprost, że GUS go nie zna', async () => {
    await zbuduj({ gusKlient: atrapaGus({ firma: null }) });
    const odp = await post('/klienci/gus', { f_nip: '1111111111', nazwa: '' });
    expect(odp.body).toMatch(/GUS nie zna firmy/);
    expect(odp.body).toContain('name="klucz"');
  });

  // Awaria GUS-u nie ma prawa wywalić ekranu razem z tym, co operator zdążył wpisać.
  it('awaria GUS-u zostawia formularz z wpisanymi danymi', async () => {
    await zbuduj({ gusKlient: atrapaGus({ rzuca: 'BIR nie odpowiada' }) });
    const odp = await post('/klienci/gus', { f_nip: '1000001023', nazwa: 'Wpisane ręcznie' });
    expect(odp.body).toMatch(/Nie udało się zapytać GUS/);
    expect(odp.body).toContain('value="Wpisane ręcznie"');
  });

  // ⚠️ PANEL BEZ GUS-U to tryb POPRAWNY, nie awaria: przycisku nie ma, a trasa odmawia
  // czytelnie. Ta sama zasada, co przy poczcie i przy fakturach.
  it('bez skonfigurowanego GUS-u przycisku nie ma, a trasa tłumaczy dlaczego', async () => {
    await zbuduj({ gusKlient: null });
    expect((await get('/klienci?nowy')).body).not.toContain('Pobierz z GUS');
    expect((await post('/klienci/gus', { f_nip: '1000001023' })).body).toMatch(/GUS nie jest skonfigurowany/);
  });
});

describe('skopiuj dane do wysyłki na ekranie klientów', () => {
  const FORMULARZ = {
    nazwa: 'BETAMET sp. z o.o.',
    f_firma: 'BETAMET sp. z o.o.', f_ulica: 'Fabryczna 4', f_kod: '00-650', f_miasto: 'Pęki',
    f_email: 'faktury@betamet.pl',
    w_nazwa: 'Jan Kowalski', w_telefon: '600100200',
  };

  it('przepisuje firmę, adres i e-mail', async () => {
    const body = (await post('/klienci/kopiuj-do-wysylki', FORMULARZ)).body;
    expect(body).toContain('name="w_ulica" value="Fabryczna 4"');
    expect(body).toContain('name="w_miasto" value="Pęki"');
    expect(body).toContain('value="faktury@betamet.pl"');
  });

  // ⚠️ IMIĘ, NAZWISKO I TELEFON ZOSTAJĄ NIETKNIĘTE — kurier wymaga osoby do kontaktu,
  // a dane faktury jej nie niosą. To ta sama decyzja, co na ekranie zakładania zamówienia,
  // bo to ta sama funkcja domeny.
  it('nie rusza osoby do kontaktu ani telefonu', async () => {
    const body = (await post('/klienci/kopiuj-do-wysylki', FORMULARZ)).body;
    expect(body).toContain('name="w_nazwa" value="Jan Kowalski"');
    expect(body).toContain('name="w_telefon" value="600100200"');
  });

  it('NIE zapisuje klienta', async () => {
    await post('/klienci/kopiuj-do-wysylki', FORMULARZ);
    expect(wszyscyKlienci(db, { tylkoAktywni: false })).toHaveLength(0);
  });
});

// ——— KARTA KLIENTA (21.08.2026, prosba wlasciciela) ——————————————————————————————
// „Klikniecie w nazwe klienta otwiera strone z jego danymi oraz historia zamowien",
// „zamiast «popraw» to przycisk «edytuj»", „«Dodaj nowego klienta» — niech sie wyroznia".
describe('karta stałego klienta', () => {
  const dopiszIWez = async (nad = {}) => {
    await dopisz(nad);
    return wszyscyKlienci(db, { tylkoAktywni: false }).at(-1);
  };

  it('nazwa na liście jest ODNOŚNIKIEM do karty, a przycisk obok mówi „Edytuj"', async () => {
    const k = await dopiszIWez();
    const body = (await get('/klienci')).body;
    expect(body).toContain(`href="/klienci/${k.id}"`);
    expect(body).toContain(`href="/klienci/${k.id}/edytuj#formularz"`);
    expect(body).toMatch(/<a class="btn btn--maly" href="\/klienci\/\d+\/edytuj#formularz">Edytuj<\/a>/);
    expect(body).not.toMatch(/>Popraw</);
  });

  // ⚠️ Wyroznienie ma byc KLASA Z PALETY, nie kolorem wpisanym wprost: arkusz ma wariant
  // jasny i ciemny, wiec wartosc z palca zadzialalaby w jednym i po cichu zniknela w drugim.
  it('„Dodaj nowego klienta" jest przyciskiem GŁÓWNYM, bez koloru wpisanego wprost', async () => {
    const body = (await get('/klienci')).body;
    expect(body).toMatch(/<a class="btn btn--maly btn--glowny" href="\/klienci\?nowy#formularz">Dodaj nowego klienta<\/a>/);
    const tresc = body.slice(body.indexOf('<div class="tresc">'));
    expect(tresc).not.toMatch(/style="[^"]*(color|background)/i);
  });

  // ⚠️ ZDANIE ZDJETE NA PROSBE WLASCICIELA — ale nie skasowane z panelu: jego tresc jest
  // sednem calej tabeli (wpis to ZRODLO PODPOWIEDZI, nie stan zamowienia) i stoi teraz na
  // karcie klienta, przy ustaleniach, ktorych dotyczy.
  it('lista NIE niesie już zdania o kopii danych, karta klienta — owszem', async () => {
    const k = await dopiszIWez();
    expect((await get('/klienci')).body).not.toContain('wstawia się jednym kliknięciem');
    expect((await get(`/klienci/${k.id}`)).body).toContain('własną kopię');
  });

  it('karta pokazuje dane klienta i ustalenia', async () => {
    const k = await dopiszIWez();
    const body = (await get(`/klienci/${k.id}`)).body;
    expect(body).toContain('BETAMET sp. z o.o.');
    expect(body).toContain('1000001023');
    expect(body).toContain('Fabryczna 4');
    expect(body).toContain('faktury@betamet.pl');
    expect(body).toContain('600100200');
    // Ustalenia sklada DOMENA (`opisKlienta`) — ta sama funkcja, co pod paskiem wyboru.
    expect(body).toContain('30%');
    expect(body).toContain('B2B');
    // ⚠️ KARTA NIE MA FORMULARZA — pole `klucz` istnieje WYLACZNIE w nim.
    expect(body).not.toContain('name="klucz"');
    expect(body).toContain(`/klienci/${k.id}/edytuj`);
  });

  it('nieznany klient daje 404 na obu adresach', async () => {
    expect((await get('/klienci/9999')).statusCode).toBe(404);
    expect((await get('/klienci/9999/edytuj')).statusCode).toBe(404);
  });

  // ⚠️ Poprawka wraca NA KARTE tego klienta — czlowiek wchodzi w edycje z karty, wiec
  // odeslanie go na liste kazaloby szukac wpisu, przy ktorym przed chwila stal.
  it('zapis poprawki wraca na kartę, a dopisanie nowego — na listę', async () => {
    const k = await dopiszIWez();
    const poprawka = await post('/klienci', { ...BETAMET, id: String(k.id), rabat_procent: '20' });
    expect(poprawka.statusCode).toBe(302);
    expect(poprawka.headers.location).toBe(`/klienci/${k.id}`);
    const nowy = await dopisz({ nazwa: 'INNA sp. z o.o.', klucz: 'inna', nip: '5252674798' });
    expect(nowy.headers.location).toBe('/klienci');
  });
});

// ——— HISTORIA ZAMOWIEN NA KARCIE ————————————————————————————————————————————————
describe('historia zamówień na karcie klienta', () => {
  // Zamowienie recznie zalozone o zadanym NIP-ie i kwocie — ta sama droga, co przy
  // zakladaniu z ekranu (services/zamowienie-reczne.js).
  const zamowienie = ({ nip, cena, znacznik = '2026-08-21T09:00:00.000Z' }) => {
    const { id } = zalozZamowienieReczne({
      db,
      znacznik,
      dane: {
        klient: { first_name: 'Jan', last_name: 'Kowalski', company: 'BETAMET sp. z o.o.' },
        dostawa: { first_name: 'Jan', last_name: 'Kowalski', city: 'Pęki' },
        nip, chce_fakture: 1, metoda_wysylki: 'dpd', koszt_dostawy_brutto: '0.00',
        metoda_platnosci: 'Przelew', pozycje: [],
      },
    });
    dodajPozycjeReczna(db, id, {
      nazwa: 'Szablon inwalida 30x30', sku: 'SZ-INW-30', ilosc: 1,
      cena_brutto: cena, brutto_linii: cena,
    });
    przeliczKwoteRecznego(db, id);
    return id;
  };

  it('pokazuje zamówienia TEGO podmiotu i pomija cudze', async () => {
    await dopisz();
    const k = wszyscyKlienci(db).at(-1);
    const nasze = zamowienie({ nip: '1000001023', cena: '123.00' });
    const obce = zamowienie({ nip: '5252674798', cena: '999.00' });
    const body = (await get(`/klienci/${k.id}`)).body;
    expect(body).toContain(`/zamowienia/${nasze}"`);
    expect(body).not.toContain(`/zamowienia/${obce}"`);
    expect(body).toContain('123,00');
    expect(body).not.toContain('999,00');
  });

  // ⚠️⚠️ NIP zapisany z myslnikami („100-00-01-023") albo z prefiksem „PL" to NORMALNY stan
  // zamowienia ze sklepu. Porownanie napisow wprost nie znalazloby ani jednego zamowienia,
  // a ekran pokazalby pustke — czyli zdanie „ten klient nic nie zamawial", ktore jest falszem.
  it('dopasowuje NIP zapisany z myślnikami i z prefiksem PL', async () => {
    await dopisz();
    const k = wszyscyKlienci(db).at(-1);
    const a = zamowienie({ nip: 'PL 100-00-01-023', cena: '10.00' });
    expect((await get(`/klienci/${k.id}`)).body).toContain(`/zamowienia/${a}"`);
  });

  // ⚠️⚠️ NIP POPRAWIONY RECZNIE lezy w `klient_reczny_json`, a nie w kolumnie `nip` — i to
  // on jedzie na fakture. Dopasowanie po samej kolumnie gubiloby dokladnie te zamowienia,
  // przy ktorych ktos numer poprawial, czyli te najbardziej narazone na pomylke.
  it('widzi zamówienie, w którym NIP poprawiono ręcznie', async () => {
    await dopisz();
    const k = wszyscyKlienci(db).at(-1);
    const id = zamowienie({ nip: '1111111111', cena: '55.00' });
    expect((await post(`/zamowienia/${id}/dane/faktura`, {
      firma: 'BETAMET sp. z o.o.', nip: '1000001023', ulica: 'Fabryczna 4', kod: '00-650', miasto: 'Pęki', email: '',
    })).statusCode).toBe(302);
    expect((await get(`/klienci/${k.id}`)).body).toContain(`/zamowienia/${id}"`);
  });

  // ⚠️ Klient bez NIP-u to normalny wpis (osoba prywatna zamawiajaca regularnie) — ekran ma
  // powiedziec, DLACZEGO historii nie ma. Milczaca pustka czyta sie jak „nic nie zamawial".
  it('klient BEZ NIP-u dostaje zdanie, dlaczego historii nie ma', async () => {
    await dopisz({ nazwa: 'Osoba prywatna', klucz: 'osoba', nip: '' });
    const k = wszyscyKlienci(db).find((x) => x.klucz === 'osoba');
    expect((await get(`/klienci/${k.id}`)).body).toMatch(/wyłącznie po NIP-ie/);
  });

  it('klient z NIP-em i bez zamówień mówi to wprost', async () => {
    await dopisz();
    const k = wszyscyKlienci(db).at(-1);
    expect((await get(`/klienci/${k.id}`)).body).toMatch(/ani jednego zamówienia/);
  });

  // ⚠️⚠️ ANULOWANE NIE WCHODZI DO SUMY, ale WCHODZI DO LICZNIKA. „Klient zamowil dwa razy"
  // zostaje prawda; „klient zostawil u nas 1 023 zl" przestaje nia byc, gdy jedno z zamowien
  // anulowal. Cicho pominiete wygladaloby jak brak zamowienia.
  it('anulowane liczy się do liczby zamówień, ale NIE do kwoty', async () => {
    await dopisz();
    const k = wszyscyKlienci(db).at(-1);
    zamowienie({ nip: '1000001023', cena: '100.00' });
    const drugie = zamowienie({ nip: '1000001023', cena: '900.00' });
    zapiszFaktyStatusu(db, drugie, { anulowane_recznie: 1 });
    const body = (await get(`/klienci/${k.id}`)).body;
    expect(body).toContain('2 zamówienia');
    expect(body).toContain('w tym 1 anulowanych');
    expect(body).toContain('100,00');
    // Suma NIE zawiera anulowanego: 1 000,00 zl nie ma prawa nigdzie stanac.
    expect(body).not.toContain('1 000,00');
  });
});
