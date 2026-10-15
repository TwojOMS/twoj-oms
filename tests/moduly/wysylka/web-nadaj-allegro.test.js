import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { createDpdClient } from '../../../src/oms/kurierzy/dpd.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// ZGŁOSZENIE WŁAŚCICIELA 2026-08-07, dwa zamówienia na produkcji:
//   1120 — allegrowe, pierwsza paczka pojechała etykietą z Allegro (a OMS o niej NIE WIE),
//          trzeba dosłać brakujący produkt WŁASNYM DPD albo paczkomatem;
//   1126 — allegrowe do paczkomatu; ekran nadania pokazywał formularz DPD z wymiarami
//          110×75×1 cm i BEZ wyboru gabarytu.
//
// Wspólna przyczyna: `wybierzKuriera` zna tylko `dpd` i `inpost_paczkomat`, a metody
// allegrowe nie mają wpisu w `DLA_METODY` — i to jest CELOWA bariera przed drugą, płatną
// paczką do klienta, który swoją już dostał. Poprawka nie zdejmuje bariery, tylko dokłada
// drogę przez świadome wskazanie kuriera przez człowieka.
//
// ⚠️ ANI JEDNO WYWOŁANIE NIE IDZIE DO PRAWDZIWEGO DPD — klient rozmawia z fiksturami.

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const NADAWCA = { nazwa: 'Lumina Marek Zywiecki', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL' };

const ADRES = {
  nazwa: 'Julia Lis', company: '', ulica: 'Radosna 7', kod: '78-100',
  miasto: 'Niekanin', kraj: 'PL', phone: '+48500900009', email: 'a@allegromail.pl',
};
const ONE_COURIER = '0d83955a-4297-4169-adef-9790d53b11ff';
const PACZKA = { waga: '1', dlugosc: '110', szerokosc: '75', wysokosc: '1', kolejnosc: '1',
  delivery_method_id_allegro: ONE_COURIER, ...ADRES };

const zmapowane = (nad = {}) => ({
  zrodlo_id: '91671e40-9025-11f1-9622-afa983ea653b', numer: '91671e40-9025-11f1-9622-afa983ea653b',
  klient: { email: 'a@allegromail.pl', phone: '+48500900009' },
  dostawa: { first_name: 'Julia', last_name: 'Lis', company: '', address_1: 'Radosna 7', postcode: '78-100', city: 'Niekanin', country: 'PL' },
  metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '99.00',
  status_woo: 'processing', oplacone_at: '2026-08-04T18:58:24', anulowane: 0,
  utworzone_at: '2026-08-04T18:58:08', pozycje: [], ...nad,
});

function dpdKlient() {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(odp(200, fixture('v10-ok.xml')))
    .mockResolvedValueOnce(odp(200, fixture('v4-ok.xml')));
  const dpd = createDpdClient({ url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216', nadawca: NADAWCA, fetchImpl });
  return { dpd, fetchImpl };
}

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

function zServerem({ nad = {}, sklep = 'allegro_szkicownia', inpost, wza } = {}) {
  const katalogEtykiet = mkdtempSync(join(tmpdir(), 'oms-allegro-'));
  const kurierzy = { dpd: dpdKlient().dpd };
  if (inpost) kurierzy.inpost = inpost;
  if (wza) kurierzy.allegro_wza = wza;
  const nadanie = createNadanie({ db, kurierzy, katalogEtykiet });
  const serwer = buildOmsServer({ db, config, poller, nadanie, kurierzy });
  const id = zapiszZamowienie(db, sklep, zmapowane(nad), {});
  return { serwer, id, nadanie };
}

const get = async (serwer, url) => {
  await serwer.ready();
  return serwer.inject({ method: 'GET', url, headers: naglowek });
};
const post = async (serwer, url, payload) => {
  await serwer.ready();
  return serwer.inject({ method: 'POST', url, headers: naglowek, payload });
};

// ⚠️⚠️ 19.09.2026: EKRAN WYBORU ZSZEDL Z PRZEPLYWU (decyzja właściciela). Odkad metody allegrowe
// maja droge domyslna przez „Wysylam z Allegro", `GET /nadaj` prowadzi prosto na formularz,
// a ten ekran staje tylko w dwoch przypadkach: gdy panel NIE MA czego zaproponowac (usluga
// nieznana slownikowi) albo gdy czlowiek poprosi o niego jawnie (`?wybor=1`, furtka na dosylke).
//
// Testy nizej mierza DOKLADNIE TE SAME reguly, co przed zmiana — zmienil sie wylacznie adres,
// pod ktorym ekran zyje. Skasowanie ich zabraloby ochrone, ktora nadal ma sens.
describe('ekran wyboru kuriera dla zamówienia z Allegro', () => {
  it('przy usłudze, której panel nie zna, pyta o kuriera zamiast pokazywać formularz DPD', async () => {
    const { serwer, id } = zServerem({ nad: { metoda_wysylki: 'allegro_metoda_z_przyszlosci' } });
    const r = await get(serwer, `/zamowienia/${id}/nadaj`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Czym nadać paczkę');
    expect(r.body).toContain(`/zamowienia/${id}/nadaj?kurier=dpd`);
    expect(r.body).toContain(`/zamowienia/${id}/nadaj?kurier=inpost_paczkomat`);
    // Formularza nadania na tym ekranie NIE MA — to jest cała różnica wobec stanu sprzed
    // poprawki, gdzie panel pokazywał komplet pól i obiecywał nadanie, którego nie umiał.
    expect(r.body).not.toContain('name="waga"');
  });

  it('na jawną prośbę (dosyłka) pyta o kuriera także przy usłudze znanej', async () => {
    const { serwer, id } = zServerem();
    const r = await get(serwer, `/zamowienia/${id}/nadaj?wybor=1`);
    expect(r.body).toContain('Czym nadać paczkę');
    expect(r.body).toContain(`/zamowienia/${id}/nadaj?kurier=dpd`);
  });

  // ⚠️ Ekran ma powiedzieć wprost to, czego panel NIE WIE — bo „Brak paczek" na karcie 1120
  // znaczyło „nie dociągnęliśmy numeru", a nie „nic nie pojechało".
  it('ostrzega, że brak paczki w panelu nie znaczy, że żadna nie pojechała', async () => {
    const { serwer, id } = zServerem();
    const r = await get(serwer, `/zamowienia/${id}/nadaj?wybor=1`);
    expect(r.body).toMatch(/nie znaczy, że żadna nie/i);
  });

  it('zamówienie ze sklepu ekranu wyboru NIE dostaje — idzie prosto do formularza', async () => {
    const { serwer, id } = zServerem({ nad: { metoda_wysylki: 'dpd' }, sklep: 'pro' });
    const r = await get(serwer, `/zamowienia/${id}/nadaj`);
    expect(r.body).not.toContain('Czym nadać paczkę');
    expect(r.body).toContain('name="waga"');
  });

  // ⚠️ PIENIĄDZE: pobranie w paczkomacie nie jest potwierdzone na naszej umowie z InPostem
  // (44 przesyłki konta, wszystkie z pustym `cod`) — paczka pojechałaby bez inkasa.
  it('przy pobraniu na paczce nr 1 zostaje sam DPD, z podanym powodem', async () => {
    const { serwer, id } = zServerem({ nad: { pobranie: 1, kwota_pobrania: '220.89' } });
    const r = await get(serwer, `/zamowienia/${id}/nadaj?wybor=1`);
    expect(r.body).toContain('kurier=dpd');
    expect(r.body).not.toContain('kurier=inpost_paczkomat');
    expect(r.body).toMatch(/bez inkasa/i);
  });
});

describe('formularz nadania po wskazaniu kuriera', () => {
  it('DPD daje pola wymiarów i niesie wskazanie dalej', async () => {
    const { serwer, id } = zServerem();
    const r = await get(serwer, `/zamowienia/${id}/nadaj?kurier=dpd`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="dlugosc"');
    expect(r.body).toContain('name="kurier"');
    expect(r.body).toContain('value="dpd"');
  });

  // ⚠️ SEDNO ZGŁOSZENIA O ZAM. 1126: paczkomat MUSI dostać gabaryt i kod automatu,
  // a NIE wymiary 110×75×1 cm, które nie mieszczą się w żadnej skrytce.
  it('paczkomat daje gabaryt A/B/C i kod automatu, a NIE wymiary', async () => {
    const { serwer, id } = zServerem({
      nad: { metoda_wysylki: 'allegro_paczkomat', punkt_odbioru: 'MALK01APP', punkt_odbioru_opis: 'Przy sklepie spożywczym' },
    });
    const r = await get(serwer, `/zamowienia/${id}/nadaj?kurier=inpost_paczkomat`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="gabaryt"');
    expect(r.body).toContain('MALK01APP');
    expect(r.body).not.toContain('name="dlugosc"');
  });

  // Kod paczkomatu jest ADRESEM przesyłki. Odmowa musi paść PRZED wypełnieniem formularza.
  it('paczkomat bez kodu automatu → odmowa z instrukcją, nie formularz', async () => {
    const { serwer, id } = zServerem({ nad: { metoda_wysylki: 'allegro_paczkomat', punkt_odbioru: null } });
    const r = await get(serwer, `/zamowienia/${id}/nadaj?kurier=inpost_paczkomat`);
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/kodu paczkomatu/i);
  });

  it('wskazanie kuriera spoza listy → odmowa', async () => {
    const { serwer, id } = zServerem();
    const r = await get(serwer, `/zamowienia/${id}/nadaj?kurier=poczta`);
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/Nie umiem nadać/);
  });

  // ⚠️⚠️ ODWRÓCONE 2026-09-01 NA PROŚBĘ WŁAŚCICIELA. Do tego dnia pole stało PUSTE, bo panel nie
  // wie, czy pierwsza paczka nie pojechała już z pobraniem (numery listów z Allegro
  // dociągają się tylko dopóki `wyslane_at` jest puste). Ta niewiedza NIE ZNIKŁA — zniknęło
  // wyłącznie przepisywanie kwoty z karty do pola ręką przy każdej allegrowej paczce.
  //
  // ⚠️ CO ZOSTAJE OSTRZEŻENIEM, gdy tekst przy polu znika: (1) ekran WYBORU KURIERA, przez
  // który przechodzi każda allegrowa paczka, mówi wprost „brak paczki w panelu nie znaczy,
  // że żadna nie pojechała" (test wyżej w tym pliku), (2) paczka nr 2 i dalsze pola kwoty
  // nie dostają w ogóle — mają czerwony pas „TA PACZKA JEDZIE BEZ POBRANIA"
  // (tests/oms/kwota-pobrania-nadania.test.js, „pole ISTNIEJE wyłącznie przy paczce nr 1").
  it('kwota pobrania JEST podstawiona także przy zamówieniu z Allegro', async () => {
    const { serwer, id } = zServerem({ nad: { pobranie: 1, kwota_pobrania: '220.89' } });
    const r = await get(serwer, `/zamowienia/${id}/nadaj?kurier=dpd`);
    expect(r.body).toContain('name="kwota_pobrania" value="220.89"');
    expect(r.body).not.toMatch(/nie jest podstawiona celowo/i);
  });

  // ——— „NADAJ I DRUKUJ" (zgłoszenie właściciela 2026-09-01: „teraz nie działa") ———————————————
  it('WzA pokazuje oba przyciski i wyjaśnia wybór niezmiennego formatu', async () => {
    const { serwer, id } = zServerem({ wza: { pobierzMetodeDostawy: async () => ONE_COURIER } });
    const r = await get(serwer, `/zamowienia/${id}/nadaj?kurier=wza`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('value="nadaj"');
    expect(r.body).toContain('value="nadaj_i_drukuj"');
    expect(r.body).toMatch(/PDF.*ZPL/s);
    expect(r.body).toMatch(/nie.*zmienić.*formatu/s);
  });

  // ⚠️ DRUGA POŁOWA TEGO SAMEGO TESTU: nasza umowa DPD daje ZPL, więc przycisk ZOSTAJE.
  // Bez tej asercji zmiana „ukryj zawsze" przechodziłaby na zielono.
  it('nasza umowa DPD dalej ma „Nadaj i drukuj"', async () => {
    const { serwer, id } = zServerem();
    const r = await get(serwer, `/zamowienia/${id}/nadaj?kurier=dpd`);
    expect(r.body).toContain('value="nadaj_i_drukuj"');
    expect(r.body).not.toMatch(/nie ma tu „Nadaj i drukuj"/);
  });
});

describe('POST /nadaj — bariera przeżywa żądanie z ręki', () => {
  // ⚠️ NAJWAŻNIEJSZY TEST W PLIKU. Ekran nie jest barierą — barierą jest domena.
  //
  // ⚠️ 11.08.2026 ZMIENIŁ SIĘ SKUTEK BRAKU WSKAZANIA, ale nie sens tego testu. Dotąd brak
  // wskazania był odmową; dziś prowadzi do „Wysyłam z Allegro". Tym, czego pilnujemy, jest
  // rzecz niezmieniona: **żądanie z ręki NIE MA prawa nadać allegrowej paczki NASZĄ umową
  // DPD**. Ten serwer nie ma podpiętego `allegro_wza` (jak panel bez kanału Allegro), więc
  // odmowa następuje już przy obowiązkowym sprawdzeniu żywej usługi, przed DPD.
  it('POST bez wskazania kuriera NIE nadaje naszym DPD', async () => {
    const { serwer, id } = zServerem();
    const r = await post(serwer, `/zamowienia/${id}/nadaj`, PACZKA);
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatch(/usługi dostawy Allegro/i);
    expect(r.body).not.toMatch(/nadano|numer listu/i);
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(0);
  });

  it('POST z wymyślonym kurierem NIE nadaje niczego', async () => {
    const { serwer, id } = zServerem();
    const r = await post(serwer, `/zamowienia/${id}/nadaj`, { ...PACZKA, kurier: 'allegro_dpd' });
    expect(r.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(0);
  });

  it('POST ze wskazanym DPD nadaje paczkę i zapisuje kuriera dpd', async () => {
    const { serwer, id } = zServerem();
    const r = await post(serwer, `/zamowienia/${id}/nadaj`, { ...PACZKA, kurier: 'dpd' });
    expect(r.statusCode).toBe(302);
    const w = db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id);
    expect(w.kurier).toBe('dpd');
    expect(w.numer_listu).toBeTruthy();
  });

  // Odstępstwo od metody zamówienia MUSI zostawić ślad — inaczej za miesiąc nikt nie
  // odpowie, dlaczego allegrowa paczka pojechała naszym DPD.
  it('wskazanie kuriera idzie do logu jako decyzja człowieka', async () => {
    const { serwer, id } = zServerem();
    await post(serwer, `/zamowienia/${id}/nadaj`, { ...PACZKA, kurier: 'dpd' });
    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'nadanie.kurier'").get(id);
    expect(wpis).toBeTruthy();
    expect(wpis.wynik).toMatch(/DECYZJA CZŁOWIEKA/);
    expect(wpis.wynik).toContain('allegro_dpd');
  });

  // ⚠️ NAJWAŻNIEJSZY TEST OCHRONNY. Gdyby wskazanie działało wszędzie, jedno pole
  // formularza zamieniałoby sklepowe zamówienie ZA POBRANIEM w przesyłkę paczkomatową bez
  // inkasa — omijając tablicę dostaw, która istnieje właśnie po to, żeby tego pilnować.
  it('dla zamówienia ZE SKLEPU wskazanie jest ignorowane — jedzie metoda zamówienia', async () => {
    const { serwer, id } = zServerem({
      nad: { metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '212.90' }, sklep: 'pro',
    });
    const r = await post(serwer, `/zamowienia/${id}/nadaj`, {
      ...PACZKA, kurier: 'inpost_paczkomat', kwota_pobrania: '212.90',
    });
    expect(r.statusCode).toBe(302);
    expect(db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id).kurier).toBe('dpd');
  });

  // Zamówienie sklepowe nie dostaje wpisu o wskazaniu — nie było żadnego odstępstwa.
  it('zamówienie ze sklepu NIE dostaje wpisu „nadanie.kurier”', async () => {
    const { serwer, id } = zServerem({ nad: { metoda_wysylki: 'dpd' }, sklep: 'pro' });
    await post(serwer, `/zamowienia/${id}/nadaj`, { ...PACZKA, kurier: 'dpd' });
    expect(db.prepare("SELECT COUNT(*) c FROM log WHERE akcja = 'nadanie.kurier'").get().c).toBe(0);
  });
});

describe('POST /nadaj — wybór formatu etykiety WzA', () => {
  const wza = () => ({
    bezSledzenia: true,
    pobierzMetodeDostawy: async () => ONE_COURIER,
    nadaj: vi.fn(async ({ drukowac }) => ({
      shipmentId: 'ship-wza-1', numerListu: 'AD0FORMAT', wTrakcieTworzenia: false,
      etykietaPdf: drukowac ? null : Buffer.from('%PDF-1.4 test'),
      etykietaZpl: drukowac ? Buffer.from('^XA^FO10,10^FDTEST^FS^XZ') : null,
      surowa: '{"labelFormat":"ZPL"}',
    })),
  });

  it('„Nadaj i drukuj” przekazuje zamiar ZPL, zapisuje plik i dodaje jedno zadanie Zebry', async () => {
    const kurier = wza();
    const { serwer, id } = zServerem({ wza: kurier });
    const r = await post(serwer, `/zamowienia/${id}/nadaj`, { ...PACZKA, zatwierdzenie: 'nadaj_i_drukuj' });
    expect(r.statusCode).toBe(302);
    expect(kurier.nadaj.mock.calls[0][0].drukowac).toBe(true);
    const przesylka = db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id);
    expect(przesylka.etykieta_zpl_sciezka).toMatch(/\.zpl$/);
    expect(przesylka.etykieta_sciezka).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku WHERE przesylka_id = ?').get(przesylka.id).c).toBe(1);
    const karta = await get(serwer, `/zamowienia/${id}`);
    expect(karta.body).toContain(`/przesylki/${przesylka.id}/drukuj`);
    expect(karta.body).not.toContain(`/przesylki/${przesylka.id}/etykieta`);
  });

  it('„Nadaj przesyłkę” przekazuje PDF bez kolejki i bez fałszywego błędu braku ZPL', async () => {
    const kurier = wza();
    const { serwer, id } = zServerem({ wza: kurier });
    const r = await post(serwer, `/zamowienia/${id}/nadaj`, { ...PACZKA, zatwierdzenie: 'nadaj' });
    expect(r.statusCode).toBe(302);
    expect(kurier.nadaj.mock.calls[0][0].drukowac).toBe(false);
    const przesylka = db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id);
    expect(przesylka.etykieta_sciezka).toMatch(/\.pdf$/);
    expect(przesylka.etykieta_zpl_sciezka).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku WHERE przesylka_id = ?').get(przesylka.id).c).toBe(0);
    const log = db.prepare('SELECT wynik FROM log WHERE zamowienie_id = ?').all(id).map((x) => x.wynik).join(' ');
    expect(log).not.toContain('BRAK ZPL');
    const karta = await get(serwer, `/zamowienia/${id}`);
    expect(karta.body).toContain(`/przesylki/${przesylka.id}/etykieta`);
  });

  it('opóźniony PDF z „Sprawdź ponownie” nie trafia do kolejki ani do logu brakującego ZPL', async () => {
    const kurier = {
      bezSledzenia: true,
      pobierzMetodeDostawy: async () => ONE_COURIER,
      nadaj: vi.fn(async () => ({ shipmentId: 'cmd-pdf', numerListu: null, wTrakcieTworzenia: true })),
      sprawdzPrzesylke: vi.fn(async () => ({
        shipmentId: 'ship-pdf', numerListu: 'AD0LATEPDF', wTrakcieTworzenia: false,
        etykietaPdf: Buffer.from('%PDF-1.4 test'), etykietaZpl: null, surowa: '{"labelFormat":"PDF"}',
      })),
    };
    const { serwer, id } = zServerem({ wza: kurier });
    expect((await post(serwer, `/zamowienia/${id}/nadaj`, { ...PACZKA, zatwierdzenie: 'nadaj' })).statusCode).toBe(302);
    const p = db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id);
    expect((await post(serwer, `/zamowienia/${id}/przesylki/${p.id}/sprawdz`, {})).statusCode).toBe(302);
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku WHERE przesylka_id = ?').get(p.id).c).toBe(0);
    const log = db.prepare('SELECT wynik FROM log WHERE zamowienie_id = ?').all(id).map((x) => x.wynik).join(' ');
    expect(log).not.toContain('BRAK ZPL');
    expect((await post(serwer, `/zamowienia/${id}/przesylki/${p.id}/sprawdz`, {})).statusCode).toBe(400);
    expect(kurier.sprawdzPrzesylke).toHaveBeenCalledTimes(1);
  });

  it('opóźniony ZPL po „Sprawdź ponownie” trafia do kolejki dokładnie raz', async () => {
    const kurier = {
      bezSledzenia: true,
      pobierzMetodeDostawy: async () => ONE_COURIER,
      nadaj: vi.fn(async () => ({ shipmentId: 'cmd-zpl', numerListu: null, wTrakcieTworzenia: true })),
      sprawdzPrzesylke: vi.fn(async () => ({
        shipmentId: 'ship-zpl', numerListu: 'AD0LATEZPL', wTrakcieTworzenia: false,
        etykietaPdf: null, etykietaZpl: Buffer.from('^XA^FO10,10^FDTEST^FS^XZ'),
        surowa: '{"labelFormat":"ZPL"}',
      })),
    };
    const { serwer, id } = zServerem({ wza: kurier });
    expect((await post(serwer, `/zamowienia/${id}/nadaj`, { ...PACZKA, zatwierdzenie: 'nadaj_i_drukuj' })).statusCode).toBe(302);
    const p = db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id);
    expect((await post(serwer, `/zamowienia/${id}/przesylki/${p.id}/sprawdz`, {})).statusCode).toBe(302);
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku WHERE przesylka_id = ?').get(p.id).c).toBe(1);
    expect((await post(serwer, `/zamowienia/${id}/przesylki/${p.id}/sprawdz`, {})).statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku WHERE przesylka_id = ?').get(p.id).c).toBe(1);
    expect(kurier.sprawdzPrzesylke).toHaveBeenCalledTimes(1);
  });
});

// ——— PACZKOMAT Z ALLEGRO, CAŁA DROGA DO KURIERA ————————————————————————————————————
//
// ⚠️ TEN BLOK ISTNIEJE PRZEZ MUTACJĘ, KTÓRA PRZEŻYŁA. Rozgałęzienie parsera paczki w trasie
// POST (`parsujPaczkeInpost` vs `parsujPaczke`) nie było niczym trzymane od strony kanału
// Allegro: podmiana `metodaUzyta` na `z.metoda_wysylki` przechodziła cały pakiet, a znaczyła
// paczkę wysłaną do InPostu z WYMIARAMI 110×75×1 cm zamiast gabarytu — czyli przesyłkę,
// która nie mieści się w ŻADNEJ skrytce automatu (zmierzone 01.08.2026: gabaryt A to
// 38×64×8 cm). Kosztem byłaby prawdziwa, opłacona przesyłka nie do doręczenia.
const NUMER_INPOST = '520000123456789012345678';
const wynikInpost = () => ({
  shipmentId: 9993331,
  numerListu: NUMER_INPOST,
  wTrakcieTworzenia: false,
  etykietaPdf: Buffer.from('%PDF-1.4\n'),
  etykietaZpl: Buffer.from('^XA^FS^XZ'),
  zplBladOpis: null,
  surowa: '{"id":9993331}',
});

describe('POST /nadaj — paczkomat z Allegro dociera do kuriera poprawnie', () => {
  const zPaczkomatem = () => {
    const inpost = { nadaj: vi.fn().mockResolvedValue(wynikInpost()) };
    const { serwer, id } = zServerem({
      nad: {
        metoda_wysylki: 'allegro_paczkomat',
        punkt_odbioru: 'MALK01APP', punkt_odbioru_opis: 'Przy sklepie spożywczym',
      },
      inpost,
    });
    return { serwer, id, inpost };
  };

  // ⚠️ SEDNO: do InPostu ma pojechać `{ waga, gabaryt }`, a NIE wymiary.
  it('do kuriera jedzie GABARYT, nie wymiary paczki', async () => {
    const { serwer, id, inpost } = zPaczkomatem();
    const r = await post(serwer, `/zamowienia/${id}/nadaj`, {
      ...ADRES, kolejnosc: '1', kurier: 'inpost_paczkomat', waga: '1.2', gabaryt: 'A',
    });
    expect(r.statusCode).toBe(302);
    const paczka = inpost.nadaj.mock.calls[0][0].paczka;
    expect(paczka).toEqual({ waga: 1.2, gabaryt: 'A' });
    expect(paczka.dlugosc).toBeUndefined();
  });

  it('kod automatu z formularza jedzie do InPostu', async () => {
    const { serwer, id, inpost } = zPaczkomatem();
    await post(serwer, `/zamowienia/${id}/nadaj`, {
      ...ADRES, kolejnosc: '1', kurier: 'inpost_paczkomat', waga: '1.2', gabaryt: 'A',
      punkt_odbioru: 'malk01app',
    });
    expect(inpost.nadaj.mock.calls[0][0].punktOdbioru).toBe('MALK01APP');
  });

  it('przesyłka zapisuje się z kurierem inpost, a nie dpd', async () => {
    const { serwer, id } = zPaczkomatem();
    await post(serwer, `/zamowienia/${id}/nadaj`, {
      ...ADRES, kolejnosc: '1', kurier: 'inpost_paczkomat', waga: '1.2', gabaryt: 'A',
    });
    expect(db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id).kurier).toBe('inpost');
  });

  // Zły gabaryt to odmowa, nie ciche podstawienie A — kurier rozlicza po skrytce.
  it('brak gabarytu → odmowa, panel niczego nie nadaje', async () => {
    const { serwer, id, inpost } = zPaczkomatem();
    const r = await post(serwer, `/zamowienia/${id}/nadaj`, {
      ...ADRES, kolejnosc: '1', kurier: 'inpost_paczkomat', waga: '1.2',
    });
    expect(r.statusCode).toBe(400);
    expect(inpost.nadaj).not.toHaveBeenCalled();
  });
});

// ⚠️ KOLEJNOŚĆ ODMÓW. Trasa ma powiedzieć o BRAKU WSKAZANIA KURIERA, zanim zacznie
// wybrzydzać na wagę — inaczej operator poprawia wagę, wysyła ponownie i dopiero wtedy
// dowiaduje się, że i tak nie tędy droga. Bez tego testu mutacja kasująca sprawdzenie
// wskazania w trasie przechodziła cały pakiet (usługa i tak odmawia, ale JUŻ PO parserach).
describe('POST /nadaj — o braku kuriera panel mówi PIERWSZY', () => {
  // ⚠️ 11.08.2026: dla `allegro_dpd` brak wskazania NIE JEST już odmową, więc kolejność
  // „najpierw kurier, potem waga" nie ma tam czego porównywać.
  //
  // ⚠️⚠️ 18.09.2026: to samo stało się z `allegro_punkt`, `allegro_kurier` i `allegro_inne` —
  // wszystkie trzy dostały drogę domyślną („Wysyłam z Allegro") razem z ośmioma usługami
  // w `METODY_WZA`. Reguła kolejności odmów NIE ZNIKŁA, tylko przeniosła się na jedyny
  // przypadek, w którym dziś obowiązuje: metodę allegrową, której słownik jeszcze nie zna.
  // To przypadek realny, nie teoretyczny — Allegro dokłada metody bez pytania nas o zdanie
  // (`METODY_ALLEGRO` w domain/allegro-dostawa.js mówi o tym wprost).
  it('zamówienie z Allegro bez drogi domyślnej: komunikat o kurierze, nie o wadze', async () => {
    const { serwer, id } = zServerem({ nad: { metoda_wysylki: 'allegro_metoda_z_przyszlosci' } });
    const r = await post(serwer, `/zamowienia/${id}/nadaj`, { ...PACZKA, waga: 'osiem kilo' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/wskaż kuriera/i);
    expect(r.body).not.toMatch(/wag[ęi]/i);
  });
});
