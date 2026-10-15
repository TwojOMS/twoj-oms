import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { adresOdbiorcy, adresZeSklepu, polaReczneAdresu } from '../../../src/domena/adres-odbiorcy.js';
import { parsujAdresOdbiorcy } from '../../../src/domena/adres-formularza.js';
import { createDpdClient } from '../../../src/oms/kurierzy/dpd.js';
import { createInpostClient } from '../../../src/oms/kurierzy/inpost.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// Zgloszenie wlasciciela ze zrzutu (2026-08-04): karta zamowienia i ekran nadania pokazuja
// w polu „Firma" IMIE I NAZWISKO klienta przy KAZDYM zamowieniu od osoby prywatnej.
//
// ⚠️ TO NIE JEST KOSMETYKA — i dlatego ten plik istnieje osobno. Podstawienie nazwiska pod
// `company` bylo CELOWE (DPD wymaga niepustego <company> na etykiecie), ale siedzialo
// w `adresZeSklepu()` / `adresOdbiorcy()`, czyli we WSPOLNYM zrodle dla karty, ekranu
// nadania i klienta kuriera. Skutek zmierzony sonda na modulach domeny:
//
//   1. Operator, ktory WYKASUJE nazwisko z pola „Firma", widzi, ze pole wraca do tej samej
//      wartosci i NIE dostaje znacznika „zmienione recznie" — czyli klikniecie wyglada na
//      bezskuteczne. A w bazie lezy juz `{"company": null}`.
//   2. Od tej chwili to nadpisanie BLOKUJE prawdziwa nazwe firmy, gdyby ta kiedys przyszla
//      ze sklepu: zamowienie z `shipping.company = "Gammatech Sp. z o.o."` oddaje z powrotem
//      nazwisko. Paczka jedzie do firmy BEZ JEJ NAZWY na etykiecie.
//
// Naprawa: fallback schodzi z warstwy domenowej na GRANICE kuriera i formularza —
// `kurierzy/dpd.js` (`a.company ?? a.nazwa`) i `domain/adres-formularza.js`
// (`tekst(dane?.company) || nazwa`). Ten plik pilnuje OBU stron naraz: ze pole jest puste
// tam, gdzie patrzy czlowiek, i ze etykieta DPD dalej dostaje niepuste <company> — takze
// na sciezce, ktora formularza w ogole nie widzi (nadanie zbiorcze z listy).

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });
const OK_DPD = () => [odp(200, fixture('v10-ok.xml')), odp(200, fixture('v4-ok.xml')), odp(200, fixture('v4-ok-zpl.xml'))];

const NADAWCA = { nazwa: 'Lumina Marek Zywiecki', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL', phone: '338451234', email: 'sklep@szkicownia.pl' };

// Osoba prywatna: ANI shipping.company, ANI billing.company. Dokladnie ten przypadek, ktory
// wlasciciel widzial na zrzucie.
const osobaPrywatna = (nad = {}) => ({
  zrodlo_id: 1301,
  numer: '1301',
  kwota_brutto: '212.90',
  kwota_pobrania: null,
  metoda_wysylki: 'dpd',
  chce_fakture: 0,
  nip: null,
  status_woo: 'processing',
  oplacone_at: '2026-07-29T13:00:00',
  anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52',
  pozycje: [],
  dostawa: {
    first_name: 'Piotr', last_name: 'Wrona', company: '',
    address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL',
  },
  klient: { first_name: 'Piotr', last_name: 'Wrona', company: '', email: 'r@b.pl', phone: '+48500600700' },
  ...nad,
});

describe('pole „Firma": warstwa domenowa NIE podstawia juz nazwiska', () => {
  it('klient nie podal firmy → company jest NULL, a nie imieniem i nazwiskiem', () => {
    const a = adresOdbiorcy(osobaPrywatna());
    expect(a.nazwa).toBe('Piotr Wrona');
    expect(a.company).toBeNull();
  });

  // ⚠️ NULL, NIE PUSTY STRING. `kurierzy/dpd.js` sklada etykiete przez `a.company ?? a.nazwa`,
  // a `??` lapie null/undefined, ale NIE pusty string: gdyby domena oddawala '', DPD
  // dostaloby <company></company> i etykieta pojechalaby bez nazwy odbiorcy w tym polu.
  it('puste pole firmy oddaje NULL, nie pusty string (od tego zalezy `??` w dpd.js)', () => {
    expect(adresOdbiorcy(osobaPrywatna()).company).not.toBe('');
    expect(adresZeSklepu(osobaPrywatna()).company).not.toBe('');
    expect(adresZeSklepu(osobaPrywatna()).company).toBeNull();
  });

  it('nic sie nie zmienia dla PRAWDZIWEJ firmy ze sklepu — dalej dociera', () => {
    const z = osobaPrywatna({ dostawa: { ...osobaPrywatna().dostawa, company: 'Gammatech Sp. z o.o.' } });
    expect(adresOdbiorcy(z).company).toBe('Gammatech Sp. z o.o.');
    expect(adresZeSklepu(z).company).toBe('Gammatech Sp. z o.o.');
  });

  // firmaZPlatnosci() zostaje NIETKNIETA — to osobna regula (zamowienie 1277) i nie ma nic
  // wspolnego z fallbackiem na nazwisko.
  it('firma z bloku PLATNOSCI przy tym samym adresie dalej dziala', () => {
    const z = osobaPrywatna({
      klient: { ...osobaPrywatna().klient, company: 'Gammatech Sp. z o.o.', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki' },
    });
    expect(adresOdbiorcy(z).company).toBe('Gammatech Sp. z o.o.');
  });

  it('firma z platnosci przy INNYM adresie dalej NIE jest brana — teraz zostaje puste pole', () => {
    const z = osobaPrywatna({
      klient: { ...osobaPrywatna().klient, company: 'Gammatech Sp. z o.o.', address_1: 'Budowlana 7', postcode: '00-001', city: 'Warszawa' },
    });
    expect(adresOdbiorcy(z).company).toBeNull();
  });

  // Znacznik „zmienione recznie" liczy sie z ROZNICY adresZeSklepu vs adresOdbiorcy. Zdjecie
  // fallbacku nie ma prawa zaczac oznaczac pol, ktorych nikt nie tknal.
  it('bez zadnych nadpisan zadne pole nie jest oznaczone jako „zmienione recznie"', () => {
    expect(polaReczneAdresu(osobaPrywatna())).toEqual([]);
  });
});

// ⚠️ SEDNO ZGLOSZENIA. Nadpisanie `{"company": null}` powstaje wtedy, gdy operator wykasuje
// zawartosc pola „Firma" i zapisze formularz. Przed poprawka bylo NIEWIDOCZNE (pole wracalo
// do nazwiska, znacznika brak) i po cichu blokowalo prawdziwa nazwe firmy ze sklepu.
describe('nadpisanie {"company": null} znaczy „operator swiadomie wyczyscil"', () => {
  it('pole zostaje puste, a nie wraca do nazwiska', () => {
    const z = osobaPrywatna({ dostawa_reczna_json: JSON.stringify({ company: null }) });
    expect(adresOdbiorcy(z).company).toBeNull();
  });

  it('gdy sklep DOPISZE prawdziwa firme, wyczyszczenie dalej wygrywa — ale jest WIDOCZNE', () => {
    const z = osobaPrywatna({
      dostawa: { ...osobaPrywatna().dostawa, company: 'Gammatech Sp. z o.o.' },
      dostawa_reczna_json: JSON.stringify({ company: null }),
    });
    expect(adresZeSklepu(z).company).toBe('Gammatech Sp. z o.o.');
    expect(adresOdbiorcy(z).company).toBeNull();
    // Znacznik „zmienione recznie" jest jedynym sygnalem dla czlowieka, ze pole jest puste
    // Z DECYZJI, a nie z braku danych. Przed poprawka go NIE BYLO, bo obie strony
    // porownania podstawialy sobie nazwisko.
    expect(polaReczneAdresu(z)).toContain('company');
  });

  it('recznie WPISANA firma dalej wygrywa ze wszystkim', () => {
    const z = osobaPrywatna({ dostawa_reczna_json: JSON.stringify({ company: 'Inna Firma sp. z o.o.' }) });
    expect(adresOdbiorcy(z).company).toBe('Inna Firma sp. z o.o.');
    expect(polaReczneAdresu(z)).toContain('company');
  });
});

// ⚠️ GRANICA KURIERA. DPD wymaga niepustego <company> — po zdjeciu fallbacku z domeny
// odpowiada za to WYLACZNIE `a.company ?? a.nazwa` w kurierzy/dpd.js. Sprawdzamy OBIE
// sciezki, bo prowadza tam ROZNYMI drogami i tylko jedna dotyka formularza.
describe('etykieta DPD dostaje niepuste <company> — sciezka FORMULARZOWA', () => {
  it('parsujAdresOdbiorcy podstawia nazwisko pod puste pole firmy (fallback zostaje TUTAJ)', () => {
    const { adres } = parsujAdresOdbiorcy({
      nazwa: 'Piotr Wrona', company: '', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki', kraj: 'PL',
    });
    expect(adres.company).toBe('Piotr Wrona');
  });

  it('adres z formularza daje <company> z nazwiskiem w kopercie SOAP', async () => {
    const fetchImpl = vi.fn();
    OK_DPD().forEach((o) => fetchImpl.mockResolvedValueOnce(o));
    const c = createDpdClient({ url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216', nadawca: NADAWCA, fetchImpl });
    const { adres } = parsujAdresOdbiorcy({
      nazwa: 'Piotr Wrona', company: '', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki', kraj: 'PL',
    });
    await c.nadaj({ zamowienie: osobaPrywatna(), paczka: { waga: 1, dlugosc: 40, szerokosc: 30, wysokosc: 10 }, adres });
    const receiver = fetchImpl.mock.calls[0][1].body.match(/<receiver>[\s\S]*?<\/receiver>/)[0];
    expect(receiver).toContain('<company>Piotr Wrona</company>');
  });
});

describe('etykieta DPD dostaje niepuste <company> — sciezka HURTEM (bez formularza)', () => {
  // ⚠️ NAJWAZNIEJSZY PRZYPADEK TEJ POPRAWKI. Nadanie zbiorcze z listy zamowien NIE PRZECHODZI
  // przez parsujAdresOdbiorcy — do kuriera trafia wprost wynik adresOdbiorcy(). Gdyby
  // fallback zniknal takze z dpd.js, etykiety nadane hurtem pojechalyby z pustym <company>
  // i NIKT by tego nie zobaczyl, bo DPD i tak zwraca numer listu.
  it('klient DPD wolany BEZ jawnego adresu (fallback na adresOdbiorcy) dalej wysyla nazwisko', async () => {
    const fetchImpl = vi.fn();
    OK_DPD().forEach((o) => fetchImpl.mockResolvedValueOnce(o));
    const c = createDpdClient({ url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216', nadawca: NADAWCA, fetchImpl });
    await c.nadaj({ zamowienie: osobaPrywatna(), paczka: { waga: 1, dlugosc: 40, szerokosc: 30, wysokosc: 10 } });
    const receiver = fetchImpl.mock.calls[0][1].body.match(/<receiver>[\s\S]*?<\/receiver>/)[0];
    expect(receiver).toContain('<company>Piotr Wrona</company>');
  });

  it('nadanie.nadaj() BEZ przekazanego adresu — <company> z nazwiskiem dociera do DPD', async () => {
    const db = openOmsDb(':memory:');
    const fetchImpl = vi.fn();
    OK_DPD().forEach((o) => fetchImpl.mockResolvedValueOnce(o));
    const dpd = createDpdClient({ url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216', nadawca: NADAWCA, fetchImpl });
    const nadanie = createNadanie({
      db, kurierzy: { dpd }, klienci: {}, katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-firma-')),
    });
    const id = zapiszZamowienie(db, 'pro', osobaPrywatna(), {});
    await nadanie.nadaj(id);
    const receiver = fetchImpl.mock.calls[0][1].body.match(/<receiver>[\s\S]*?<\/receiver>/)[0];
    expect(receiver).toContain('<company>Piotr Wrona</company>');
  });

  // ⚠️ NIEZMIENNIK PRZENIESIONY z tests/oms/dane-reczne.test.js („nadpisane imie i nazwisko
  // wchodzi tez w fallback firmy"). Fallback ma isc za nazwiskiem PO recznej poprawce —
  // inaczej poprawione nazwisko trafialoby na etykiete tylko w jednym z dwoch pol. Po
  // zdjeciu podstawienia z domeny pilnuje tego juz WYLACZNIE `a.company ?? a.nazwa` w dpd.js,
  // wiec sprawdzamy to tam, gdzie teraz mieszka: w kopercie SOAP.
  it('poprawione recznie nazwisko wchodzi w <company>, nie tylko w <name>', async () => {
    const fetchImpl = vi.fn();
    OK_DPD().forEach((o) => fetchImpl.mockResolvedValueOnce(o));
    const c = createDpdClient({ url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216', nadawca: NADAWCA, fetchImpl });
    const z = osobaPrywatna({ dostawa_reczna_json: JSON.stringify({ nazwa: 'Anna Nowak' }) });
    await c.nadaj({ zamowienie: z, paczka: { waga: 1, dlugosc: 40, szerokosc: 30, wysokosc: 10 } });
    const receiver = fetchImpl.mock.calls[0][1].body.match(/<receiver>[\s\S]*?<\/receiver>/)[0];
    expect(receiver).toContain('<company>Anna Nowak</company>');
    expect(receiver).toContain('<name>Anna Nowak</name>');
  });

  // Ta sama droga, ale przez PRAWDZIWA trase masowa — ona przekazuje `adres: adresOdbiorcy(z)`
  // JAWNIE, wiec fallback `adres ?? adresOdbiorcy(z)` w nadanie.js nawet nie wchodzi w gre.
  // Wynik ma byc identyczny.
  it('POST /zamowienia/masowe/nadaj — etykieta ma <company> mimo pustej firmy w sklepie', async () => {
    const db = openOmsDb(':memory:');
    const fetchImpl = vi.fn();
    OK_DPD().forEach((o) => fetchImpl.mockResolvedValueOnce(o));
    const dpd = createDpdClient({ url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216', nadawca: NADAWCA, fetchImpl });
    const nadanie = createNadanie({
      db, kurierzy: { dpd }, klienci: {}, katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-firma-')),
    });
    const app = buildOmsServer({
      db,
      config: { auth: { user: 'adam', pass: 'x' } },
      poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) },
      nadanie,
    });
    await app.ready();
    const id = zapiszZamowienie(db, 'pro', osobaPrywatna(), {});
    const r = await app.inject({
      method: 'POST',
      url: '/zamowienia/masowe/nadaj',
      headers: { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' },
      payload: { id: String(id) },
    });
    expect(r.statusCode).toBe(200);
    const receiver = fetchImpl.mock.calls[0][1].body.match(/<receiver>[\s\S]*?<\/receiver>/)[0];
    expect(receiver).toContain('<company>Piotr Wrona</company>');
  });
});

// InPost, inaczej niz DPD, NIE wymaga nazwy firmy — powtorzenie nazwiska w drugim polu
// smiecilo etykiete. Warunek `company && company !== nazwa` w kurierzy/inpost.js ZOSTAJE
// nietkniety: po zmianie broni juz nie domeny, tylko sciezki FORMULARZOWEJ, gdzie fallback
// nakłada adres-formularza.js.
describe('InPost nie dostaje company_name, gdy firmy nie ma', () => {
  const json = (status, cialo) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(cialo) });
  const bin = (status, tresc) => ({
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => {
      const b = Buffer.from(tresc, 'latin1');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  });
  const PRZESYLKA = {
    id: 9993331, status: 'confirmed', service: 'inpost_locker_standard',
    tracking_number: '520000123456789012345678',
    custom_attributes: { target_point: 'SLN06M', sending_method: 'any_point' },
  };
  const paczkomatowe = () => ({
    ...osobaPrywatna(),
    metoda_wysylki: 'inpost_paczkomat',
    punkt_odbioru: 'SLN06M',
  });
  const klientInpost = () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(201, PRZESYLKA))
      .mockResolvedValueOnce(bin(200, '%PDF-1.4\n'))
      .mockResolvedValueOnce(bin(200, '^XA^FS^XZ'));
    return {
      c: createInpostClient({
        url: 'https://shipx.test/v1', token: 'TESTOWY-TOKEN', organizacja: 13235, nadawca: NADAWCA, fetchImpl,
      }),
      fetchImpl,
    };
  };
  const cialoPost = (fetchImpl) => JSON.parse(fetchImpl.mock.calls[0][1].body);

  it('sciezka HURTEM (adres z domeny, company null) → brak company_name', async () => {
    const { c, fetchImpl } = klientInpost();
    await c.nadaj({ zamowienie: paczkomatowe(), paczka: { waga: 1.2, gabaryt: 'A' } });
    expect(cialoPost(fetchImpl).receiver.company_name).toBeUndefined();
  });

  it('sciezka FORMULARZOWA (fallback z adres-formularza.js) → dalej brak company_name', async () => {
    const { c, fetchImpl } = klientInpost();
    const { adres } = parsujAdresOdbiorcy({
      nazwa: 'Piotr Wrona', company: '', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki', kraj: 'PL',
      phone: '+48500600700', email: 'r@b.pl',
    });
    expect(adres.company).toBe('Piotr Wrona');
    await c.nadaj({ zamowienie: paczkomatowe(), paczka: { waga: 1.2, gabaryt: 'A' }, adres });
    expect(cialoPost(fetchImpl).receiver.company_name).toBeUndefined();
  });

  it('PRAWDZIWA firma dalej jedzie jako company_name', async () => {
    const { c, fetchImpl } = klientInpost();
    const z = { ...paczkomatowe(), dostawa: { ...paczkomatowe().dostawa, company: 'Gammatech Sp. z o.o.' } };
    await c.nadaj({ zamowienie: z, paczka: { waga: 1.2, gabaryt: 'A' } });
    expect(cialoPost(fetchImpl).receiver.company_name).toBe('Gammatech Sp. z o.o.');
  });
});

// Objaw ze zrzutu, sprawdzony tam, gdzie patrzyl wlasciciel: na WIDOKACH.
describe('widoki: pole „Firma" jest puste przy zamowieniu osoby prywatnej', () => {
  let db, app;
  const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };

  beforeEach(async () => {
    db = openOmsDb(':memory:');
    const fetchImpl = vi.fn();
    OK_DPD().forEach((o) => fetchImpl.mockResolvedValueOnce(o));
    const dpd = createDpdClient({ url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216', nadawca: NADAWCA, fetchImpl });
    app = buildOmsServer({
      db,
      config: { auth: { user: 'adam', pass: 'x' } },
      poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) },
      nadanie: createNadanie({ db, kurierzy: { dpd }, klienci: {}, katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-firma-')) }),
    });
    await app.ready();
  });

  it('karta zamowienia: pole Firma w formularzu wysylki nie niesie nazwiska', async () => {
    const id = zapiszZamowienie(db, 'pro', osobaPrywatna(), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=wysylka`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/<input name="company" value="">/);
    expect(r.body).not.toContain('<input name="company" value="Piotr Wrona">');
  });

  it('ekran nadania: pole Firma jest puste', async () => {
    const id = zapiszZamowienie(db, 'pro', osobaPrywatna(), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/id="pole-company" name="company" value=""/);
  });
});
