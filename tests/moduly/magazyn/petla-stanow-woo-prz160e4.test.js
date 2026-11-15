// PRZ-160 E4.09 — pętla stanów Woo (D24, D53, D54, D61, D64). Sklep tylko przez atrapę `fetchImpl`
// podaną prawdziwemu klientowi Woo — żadnego żądania do prawdziwego sklepu.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { przelaczStany, przelacznikStanow, zapiszOtwarcie, dodajRuch } from '../../../src/oms/db/stany-magazynowe.js';
import { wstawOferte, zmienOferte, ofertaPoId, zapiszUstawieniaOfertKonta, zapiszZatwierdzenieStanow } from '../../../src/oms/db/oferty-kanalow.ts';
import { createWooClient } from '../../../src/oms/woo/client.js';
import { createPetlaStanowWoo, ODCZYT_WOO_CO_MS } from '../../../src/moduly/magazyn/services/petla-stanow-woo.js';
import { PROBLEMY_ILOSCI } from '../../../src/domena/ilosc-kanalu.js';

const T0 = '2026-11-14T08:00:00.000Z';
const T1 = '2026-11-14T09:00:00.000Z';
const KLUCZ = 'woo_polcien';
const ALLEGRO = 'allegro_polcien';
let db, czas, sklep, zadania, przyGet, przyPost, bladPost, logi, czekaj, kolejneId, numer;
const iso = () => new Date(czas).toISOString();

function odpowiedz(status, cialo) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => cialo };
}
async function fetchImpl(url, opcje = {}) {
  const u = new URL(url);
  const sciezka = u.pathname.replace('/wp-json/wc/v3', '');
  const metoda = (opcje.method ?? 'GET').toUpperCase();
  if (metoda === 'GET') {
    const include = u.searchParams.get('include');
    zadania.push({ metoda, sciezka, include });
    przyGet();
    return odpowiedz(200, include.split(',').filter(id => sklep.has(id)).map(id => ({ ...sklep.get(id) })));
  }
  const cialo = JSON.parse(opcje.body);
  zadania.push({ metoda, sciezka, cialo });
  przyPost(cialo);
  if (bladPost) return odpowiedz(500, { message: bladPost });
  for (const p of cialo.update) sklep.set(String(p.id), { ...sklep.get(String(p.id)), stock_quantity: p.stock_quantity });
  return odpowiedz(200, { update: cialo.update.map(p => ({ id: p.id, stock_quantity: p.stock_quantity })) });
}
const klient = (baseUrl = 'https://sklep.polcien.invalid', uprawnienia = 'zapis') =>
  createWooClient({ baseUrl, ck: 'ck_test', cs: 'cs_test', fetchImpl, uprawnienia });
let kontaLista;
const nowaPetla = () => createPetlaStanowWoo({ db, konta: () => kontaLista, teraz: () => new Date(czas),
  log: t => logi.push(t), pollerMs: 120000, czekaj });

beforeEach(() => {
  db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  czas = Date.parse('2026-11-14T12:00:00Z');
  sklep = new Map(); zadania = []; logi = []; przyGet = () => {}; przyPost = () => {}; bladPost = null;
  kolejneId = 101; numer = 0;
  czekaj = vi.fn(async () => {});
  zapiszUstawieniaOfertKonta(db, KLUCZ, { czynne: true });
  kontaLista = [{ klucz: KLUCZ, klient: klient() }];
});
afterEach(() => db.close());

function wlacz(zatwierdz = true) {
  przelaczStany(db, { wlacz: true, at: T0 });
  if (zatwierdz) zapiszZatwierdzenieStanow(db, { przelaczenieId: 1, zatwierdzil: 'operator', ofert: 1, skrot: 'test' }, { teraz: T1 });
}
/** Oferta Woo objęta ilością z OMS: karta ze stanem `stan`, sklep z `woo`, ostatni zapis W = `woo` w T1. */
function oferta({ stan = 10, woo = 10, manage = true, klucz = KLUCZ, rodzic = null, stanOferty = 'aktywna', poprzednia = {} } = {}) {
  const id = String(kolejneId++);
  const kartaId = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: `LMP-${id}`, cena_gr: 10000, stawka_vat: '23' });
  if (stan !== null) zapiszOtwarcie(db, { kartaId, ilosc: stan, zrodlo: 'reczne', at: T1 });
  const o = wstawOferte(db, { kartaId, kanal: klucz, idZewnetrzne: rodzic ? `${rodzic}/${id}` : id, stan: stanOferty, tryb: 'obserwowana' });
  sklep.set(id, { id: Number(id), manage_stock: manage, stock_quantity: woo });
  zmienOferte(db, o.id, { iloscZOms: true, wyslanaIlosc: woo, iloscWyslanaAt: T1, stanKartyWyslany: stan,
    odczytIloscKanalu: woo, odczytIlosc: woo, odczytanoAt: '2026-11-14T11:55:00.000Z', ...poprzednia }, { teraz: T1 });
  return { ...o, wooId: id };
}
const wiersz = o => ofertaPoId(db, o.id);
const posty = () => zadania.filter(z => z.metoda === 'POST');
function puls(at, klucz = KLUCZ) {
  db.prepare('INSERT OR REPLACE INTO stan_pollera (sklep, ostatni_przebieg_at) VALUES (?, ?)').run(klucz, at);
}
function zamowienieWoo({ produkt, ilosc = 1, status = 'processing', anulowane = 0, zmienione = iso(), utworzone = T1, klucz = KLUCZ }) {
  const id = zapiszZamowienie(db, klucz, { zrodlo_id: `z${++numer}`, numer: `W-${numer}`, klient: {}, dostawa: {},
    utworzone_at: utworzone, kwota_brutto: '20.00', metoda_wysylki: 'odbior', chce_fakture: 0, kwota_pobrania: null,
    nip: null, oplacone_at: null, status_woo: status, anulowane, pozycje: [{ zrodlo_id: 'p1', produkt_id: produkt,
      wariant_id: null, oferta_id: null, sku: null, zdjecie_url: null, nazwa: 'Lampa Półcień', ilosc, cena_brutto: '10.00', vat: '23' }] }, {});
  db.prepare('UPDATE zamowienia SET zmienione_at = ? WHERE id = ?').run(zmienione, id);
  return id;
}
function zmienZamowienie(id, { status, anulowane = 0, zmienione = iso() }) {
  db.prepare('UPDATE zamowienia SET status_woo = ?, anulowane = ?, zmienione_at = ? WHERE id = ?').run(status, anulowane, zmienione, id);
}
/** Sprzedaż w Allegro: oferta Allegro tej samej karty i zamówienie z jej `oferta_id`. */
function sprzedazAllegro(o, ilosc = 1, at = '2026-11-14T11:00:00.000Z') {
  const idAllegro = `77${o.wooId}`;
  if (!db.prepare('SELECT 1 FROM oferty_kanalow WHERE kanal = ? AND id_zewnetrzne = ?').get(ALLEGRO, idAllegro)) {
    wstawOferte(db, { kartaId: o.kartaId, kanal: ALLEGRO, idZewnetrzne: idAllegro, stan: 'aktywna', tryb: 'obserwowana' });
  }
  const id = zapiszZamowienie(db, ALLEGRO, { zrodlo_id: `a${++numer}`, numer: `A-${numer}`, klient: {}, dostawa: {},
    utworzone_at: at, kwota_brutto: '20.00', metoda_wysylki: 'dpd', chce_fakture: 0, kwota_pobrania: null, nip: null,
    oplacone_at: null, status_woo: null, anulowane: 0, pozycje: [{ zrodlo_id: 'p1', produkt_id: null, wariant_id: null,
      oferta_id: idAllegro, sku: null, zdjecie_url: null, nazwa: 'Lampa Półcień', ilosc, cena_brutto: '10.00', vat: '23' }] }, {});
  db.prepare('UPDATE zamowienia SET zmienione_at = ? WHERE id = ?').run(at, id);
}

it('sprzedaż w Allegro 1 szt. → świeży odczyt i stock_quantity −1 w jednym batchu', async () => {
  wlacz(); const o = oferta();
  sprzedazAllegro(o);
  await nowaPetla().przebieg();
  expect(zadania).toEqual([
    { metoda: 'GET', sciezka: '/products', include: o.wooId },
    { metoda: 'POST', sciezka: '/products/batch', cialo: { update: [{ id: Number(o.wooId), stock_quantity: 9 }] } },
  ]);
  const w = wiersz(o);
  expect(w).toMatchObject({ wyslanaIlosc: 9, stanKartyWyslany: 9, iloscWToku: null, iloscProblem: null,
    iloscWyslanaAt: '2026-11-14T12:00:00.000Z', liczbaProb: 0, odczytIloscKanalu: 10 });
  expect(logi.at(-1)).toMatch(/stany-woo: konto woo_polcien: odczyt 1, zapis 1/);
});

it('ilość w toku jest zapisana przed wywołaniem sklepu', async () => {
  wlacz(); const o = oferta(); sprzedazAllegro(o);
  let wTrakcie;
  przyPost = () => { wTrakcie = wiersz(o); };
  await nowaPetla().przebieg();
  expect(wTrakcie.iloscWToku).toMatchObject({ cel: 9 });
  expect(wTrakcie.liczbaProb).toBe(1);
});

it('zakup w Woo między odczytem okresowym a zapisem → decyzja ze świeżego odczytu, sklep nie dostaje sztuk z powrotem', async () => {
  wlacz(); const o = oferta();
  sprzedazAllegro(o);
  sklep.get(o.wooId).stock_quantity = 8; // dwie sztuki kupione w Woo po odczycie okresowym (zapamiętane 10)
  const petla = nowaPetla();
  await petla.przebieg();
  expect(posty()).toEqual([]);
  expect(wiersz(o).odczytIloscKanalu).toBe(8);
  expect(wiersz(o).iloscProblem?.kod).toBe('karencja');
  zamowienieWoo({ produkt: o.wooId, ilosc: 2, zmienione: '2026-11-14T12:01:00.000Z' });
  czas += 120000;
  await petla.przebieg();
  expect(posty().map(p => p.cialo)).toEqual([{ update: [{ id: Number(o.wooId), stock_quantity: 7 }] }]);
});

it('sprzedaż w Woo → świeży odczyt równy celowi → 0 zapisów i W przesunięte', async () => {
  wlacz(); const o = oferta();
  zamowienieWoo({ produkt: o.wooId, zmienione: '2026-11-14T11:50:00.000Z' });
  sklep.get(o.wooId).stock_quantity = 9;
  await nowaPetla().przebieg();
  expect(zadania.map(z => z.metoda)).toEqual(['GET']);
  expect(wiersz(o)).toMatchObject({ wyslanaIlosc: 9, stanKartyWyslany: 9, iloscProblem: null });
});

it('anulowanie w Woo → 0 zapisów', async () => {
  wlacz(); const o = oferta();
  const z = zamowienieWoo({ produkt: o.wooId, zmienione: '2026-11-14T11:50:00.000Z' });
  sklep.get(o.wooId).stock_quantity = 9;
  const petla = nowaPetla();
  await petla.przebieg();
  czas += 300000;
  zmienZamowienie(z, { status: 'cancelled', anulowane: 1, zmienione: '2026-11-14T12:02:00.000Z' });
  sklep.get(o.wooId).stock_quantity = 10; // Woo oddaje sztukę przy anulowaniu
  await petla.przebieg();
  expect(posty()).toEqual([]);
  expect(zadania.filter(z => z.metoda === 'GET')).toHaveLength(2);
  expect(wiersz(o)).toMatchObject({ wyslanaIlosc: 10, iloscProblem: null });
});

it('pending → processing → zgodny (bez rozjazdu), podwyżka po pulsie pollera', async () => {
  wlacz(); const o = oferta();
  const z = zamowienieWoo({ produkt: o.wooId, status: 'pending', zmienione: '2026-11-14T11:50:00.000Z' });
  const petla = nowaPetla();
  await petla.przebieg(); // OMS zdejmuje przy pending, sklep nie (W3) → obniżka do 9
  expect(posty().map(p => p.cialo.update[0].stock_quantity)).toEqual([9]);
  czas += 300000;
  zmienZamowienie(z, { status: 'processing', zmienione: '2026-11-14T12:03:00.000Z' });
  sklep.get(o.wooId).stock_quantity = 8; // sklep zdejmuje po opłacie
  await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod ?? null).not.toMatch(/^rozjazd/);
  expect(posty()).toHaveLength(1);
  czas += 300000; puls('2026-11-14T12:08:00.000Z');
  await petla.przebieg();
  expect(wiersz(o).iloscProblem).toBeNull();
  expect(posty().map(p => p.cialo.update[0].stock_quantity)).toEqual([9, 9]);
});

it('D61: manage_stock parent i false → problem, bez zapisu', async () => {
  wlacz();
  const rodzica = oferta({ stan: 4, manage: 'parent', rodzic: '90' });
  const bez = oferta({ stan: 4, manage: false });
  await nowaPetla().przebieg();
  expect(posty()).toEqual([]);
  expect(zadania).toContainEqual({ metoda: 'GET', sciezka: '/products/90/variations', include: rodzica.wooId });
  expect(wiersz(rodzica).iloscProblem?.kod).toBe('stan-rodzica');
  expect(wiersz(bez).iloscProblem?.kod).toBe('bez-stanu-w-sklepie');
});

it('wariant z własnym stanem zapisuje się batchem wariantów rodzica', async () => {
  wlacz(); const o = oferta({ stan: 6, rodzic: '90' });
  await nowaPetla().przebieg();
  expect(posty()).toEqual([{ metoda: 'POST', sciezka: '/products/90/variations/batch',
    cialo: { update: [{ id: Number(o.wooId), stock_quantity: 6 }] } }]);
});

it('obniżki przed podwyżkami, przerwa między paczkami', async () => {
  wlacz();
  const gora = oferta();
  dodajRuch(db, { kartaId: gora.kartaId, rodzaj: 'przyjecie', ilosc: 2, klucz: 'r-gora', at: '2026-11-14T10:00:00.000Z' });
  const dol = oferta({ stan: 5, woo: 10, poprzednia: { stanKartyWyslany: 5 } });
  puls('2026-11-14T11:59:00.000Z');
  await nowaPetla().przebieg();
  expect(posty().map(p => p.cialo.update)).toEqual([[{ id: Number(dol.wooId), stock_quantity: 5 }], [{ id: Number(gora.wooId), stock_quantity: 12 }]]);
  expect(czekaj).toHaveBeenCalledWith(1000);
});

it('konto wstrzymane → 0 żądań', async () => {
  wlacz(); const o = oferta(); sprzedazAllegro(o);
  zapiszUstawieniaOfertKonta(db, KLUCZ, { czynne: false });
  await nowaPetla().przebieg();
  expect(zadania).toEqual([]);
  expect(logi.join('\n')).toMatch(/wstrzymane/);
});

it('klucz tylko do odczytu → odczyt bez zapisu', async () => {
  wlacz(); const o = oferta(); sprzedazAllegro(o);
  kontaLista = [{ klucz: KLUCZ, klient: klient(undefined, 'odczyt') }];
  await nowaPetla().przebieg();
  expect(posty()).toEqual([]);
  expect(wiersz(o).iloscWToku).toBeNull();
});

it('N5: klient z tylkoOdczyt = true → pętla nie woła zapiszStanyHurtem (bramka pętli, nie tylko klient)', async () => {
  wlacz(); const o = oferta(); sprzedazAllegro(o);
  const k = klient(undefined, 'odczyt');
  expect(k.tylkoOdczyt).toBe(true);
  const zapis = vi.spyOn(k, 'zapiszStanyHurtem');
  kontaLista = [{ klucz: KLUCZ, klient: k }];
  await nowaPetla().przebieg();
  expect(zadania.map(z => z.metoda)).toEqual(['GET']);
  expect(zapis).not.toHaveBeenCalled();
  expect(wiersz(o).iloscWToku).toBeNull();
});

it('15 min bez odczytu → jeden odczyt okresowy', async () => {
  wlacz(); oferta();
  const petla = nowaPetla();
  await petla.przebieg();
  expect(zadania).toEqual([]); // ostatni odczyt 5 min temu, stan zgodny
  czas = Date.parse('2026-11-14T11:55:00Z') + ODCZYT_WOO_CO_MS;
  await petla.przebieg();
  expect(zadania.map(z => z.metoda)).toEqual(['GET']);
  czas += 60000;
  await petla.przebieg();
  expect(zadania).toHaveLength(1);
});

it('restart po zapisie wiersza (sklep przyjął, odpowiedź zginęła) → 0 podwójnych zapisów', async () => {
  wlacz(); const o = oferta(); sprzedazAllegro(o);
  przyPost = cialo => {
    for (const p of cialo.update) sklep.get(String(p.id)).stock_quantity = p.stock_quantity;
    throw new Error('połączenie zerwane');
  };
  await nowaPetla().przebieg();
  expect(posty()).toHaveLength(1);
  expect(wiersz(o).iloscWToku).toMatchObject({ cel: 9 });
  przyPost = () => {};
  czas += 120000;
  await nowaPetla().przebieg(); // nowa instancja = restart procesu
  expect(posty()).toHaveLength(1);
  expect(wiersz(o)).toMatchObject({ wyslanaIlosc: 9, iloscWToku: null, iloscProblem: null });
});

it('stany wyłączone (D14) → 0 żądań, także po wyłączeniu z ilością w toku', async () => {
  const o0 = oferta({ stan: null, poprzednia: { iloscWToku: { cel: 3, at: T1 }, odczytanoAt: null } });
  await nowaPetla().przebieg();
  expect(zadania).toEqual([]);
  wlacz(); expect(o0.id).toBeGreaterThan(0); const o = oferta(); sprzedazAllegro(o);
  przelaczStany(db, { wlacz: false, at: '2026-11-14T11:58:00.000Z' });
  czas += ODCZYT_WOO_CO_MS;
  await nowaPetla().przebieg();
  expect(zadania).toEqual([]);
});

it('stany wyłączone (D14, N1) → przebieg nie pisze nic do logu (instalacja bez etapu 4 bez nowej linii co 5 min)', async () => {
  oferta({ stan: null });
  await nowaPetla().przebieg();
  kontaLista = [];
  await nowaPetla().przebieg();
  expect(logi).toEqual([]);
  expect(zadania).toEqual([]);
});

it('decyzja 1: T = chwila migawki — ruch +20 w trakcie odczytu nie daje fałszywego skoku', async () => {
  wlacz(); const o = oferta(); sprzedazAllegro(o);
  let raz = true;
  przyGet = () => {
    if (!raz) return; raz = false;
    czas += 1000;
    dodajRuch(db, { kartaId: o.kartaId, rodzaj: 'przyjecie', ilosc: 20, klucz: 'r-20', at: iso() });
    czas += 1000;
  };
  const petla = nowaPetla();
  await petla.przebieg();
  expect(wiersz(o)).toMatchObject({ wyslanaIlosc: 9, iloscWyslanaAt: '2026-11-14T12:00:00.000Z', stanKartyWyslany: 9 });
  czas += 300000; puls(new Date(czas - 60000).toISOString());
  await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod ?? null).not.toBe('skok');
  // D64: pierwszy odczyt po zapisie (9) różni się od poprzedniego (10) — podwyżka dopiero po stabilnym odczycie i pulsie.
  czas += 300000; puls(new Date(czas - 60000).toISOString());
  await petla.przebieg();
  expect(posty().at(-1).cialo.update[0].stock_quantity).toBe(29);
});

it('decyzja 2: stare T poza horyzontem → wyjaśnienia zerowe, skok zostaje skokiem', async () => {
  wlacz();
  const dawno = '2026-11-04T12:00:00.000Z';
  const o = oferta({ stan: 4, woo: 4, poprzednia: { wyslanaIlosc: 10, stanKartyWyslany: 10, iloscWyslanaAt: dawno, odczytIloscKanalu: 10 } });
  zamowienieWoo({ produkt: o.wooId, ilosc: 6, utworzone: '2026-11-05T12:00:00.000Z', zmienione: '2026-11-05T12:00:00.000Z' });
  await nowaPetla().przebieg();
  expect(wiersz(o).iloscProblem?.kod).toBe('skok');
  expect(posty()).toEqual([]);
});

it('decyzja 3: oferty w stanie szkic i blad poza pętlą', async () => {
  wlacz();
  const a = oferta({ stanOferty: 'szkic' }); const b = oferta({ stanOferty: 'blad' });
  sprzedazAllegro(a); sprzedazAllegro(b);
  czas += ODCZYT_WOO_CO_MS;
  await nowaPetla().przebieg();
  expect(zadania).toEqual([]);
});

it('decyzja 4: objęcie w trakcie przebiegu zeruje stan karty wysłany (bez fałszywego skoku)', async () => {
  wlacz();
  zapiszUstawieniaOfertKonta(db, 'woo_z', { czynne: true });
  kontaLista = [{ klucz: 'woo_z', klient: klient('https://z.polcien.invalid') }, { klucz: KLUCZ, klient: klient() }];
  const a = oferta(); sprzedazAllegro(a);
  const b = oferta({ klucz: 'woo_z', stan: 2, woo: 2, poprzednia: { stanKartyWyslany: 10, odczytIloscKanalu: 10, wyslanaIlosc: 10 } });
  db.prepare('UPDATE oferty_kanalow SET ilosc_z_oms = 0 WHERE id = ?').run(b.id);
  przyGet = () => { db.prepare('UPDATE oferty_kanalow SET ilosc_z_oms = 1 WHERE id = ?').run(b.id); };
  await nowaPetla().przebieg();
  expect(wiersz(b).iloscProblem?.kod ?? null).not.toBe('skok');
  expect(wiersz(b).stanKartyWyslany).toBeNull();
});

it('decyzja 5: termin ponowienia jednej oferty nie wstrzymuje innych; problem treści nie blokuje ilości', async () => {
  wlacz();
  const czeka = oferta({ poprzednia: { liczbaProb: 2, nastepnaProbaAt: '2026-11-14T12:30:00.000Z' } });
  const druga = oferta();
  const zProblemem = oferta({ stanOferty: 'problem' });
  for (const o of [czeka, druga, zProblemem]) sprzedazAllegro(o);
  await nowaPetla().przebieg();
  expect(posty().flatMap(p => p.cialo.update.map(u => String(u.id)))).toEqual([druga.wooId, zProblemem.wooId]);
});

it('błąd zapisu sklepu → błąd i termin ponowienia, bez zmiany W', async () => {
  wlacz(); const o = oferta(); sprzedazAllegro(o);
  bladPost = 'awaria';
  await nowaPetla().przebieg();
  const w = wiersz(o);
  expect(w.blad).toMatch(/awaria/);
  expect(w.liczbaProb).toBe(1);
  expect(w.nastepnaProbaAt).toBe('2026-11-14T12:00:30.000Z');
  expect(w.wyslanaIlosc).toBe(10);
});

// E4.09p — poprawki po recenzji.
it('B1: ujemny stan w sklepie (backorders) → problem ujemny-stan, odczyt_ilosc bez zmiany, 0 zapisów', async () => {
  wlacz(); const o = oferta({ stan: 0, woo: 0 });
  sklep.get(o.wooId).stock_quantity = -2;
  czas += ODCZYT_WOO_CO_MS; // odczyt okresowy
  const petla = nowaPetla();
  await petla.przebieg();
  expect(wiersz(o)).toMatchObject({ odczytIlosc: 0, odczytIloscKanalu: -2, iloscProblem: { kod: 'ujemny-stan', wstrzymuje: true } });
  // Stabilny odczyt −2 i puls pollera po nim — dalej bez wysyłki na podstawie ujemnego stanu.
  czas += 180000; puls(new Date(czas - 30000).toISOString());
  await petla.przebieg();
  expect(posty()).toEqual([]);
  expect(wiersz(o)).toMatchObject({ odczytIlosc: 0, iloscProblem: { kod: 'ujemny-stan' } });
  // Sklep wraca do stanu ≥ 0 → problem znika sam, odczyt zapisany.
  sklep.get(o.wooId).stock_quantity = 0;
  czas += 180000;
  await petla.przebieg();
  expect(wiersz(o)).toMatchObject({ odczytIlosc: 0, odczytIloscKanalu: 0, iloscProblem: null });
});

it('B2 (D61): świeży odczyt przed każdą paczką — zakup w Woo w trakcie pierwszej paczki nie jest nadpisany', async () => {
  wlacz();
  const a = oferta({ rodzic: '90' }); const b = oferta({ rodzic: '91' });
  sprzedazAllegro(a); sprzedazAllegro(b);
  przyPost = () => { if (posty().length === 1) sklep.get(b.wooId).stock_quantity = 9; }; // klient Woo kupuje 1 szt. b
  await nowaPetla().przebieg();
  expect(posty().map(p => p.sciezka)).toEqual(['/products/90/variations/batch']);
  expect(zadania.filter(z => z.metoda === 'GET').map(z => z.sciezka)).toEqual(
    ['/products/90/variations', '/products/91/variations', '/products/91/variations']);
  expect(wiersz(b)).toMatchObject({ odczytIloscKanalu: 9, wyslanaIlosc: 9, iloscWToku: null, liczbaProb: 0 });
});

it('N1a: alarm wstrzymujący trzyma zapis, choć warunek zniknął', async () => {
  wlacz();
  const o = oferta({ poprzednia: { iloscProblem: { ...PROBLEMY_ILOSCI['rozjazd-dol'], od: '2026-11-14T11:00:00.000Z', cel: 10, odczyt: 7 } } });
  sprzedazAllegro(o);
  await nowaPetla().przebieg();
  expect(posty()).toEqual([]);
  expect(wiersz(o).iloscProblem?.kod).toBe('rozjazd-dol');
});

it('N1b: zero masowe (D52) → bez zapisu, problem zero-masowe', async () => {
  wlacz();
  const lista = [oferta({ stan: 0, woo: 5 }), oferta({ stan: 0, woo: 5 }), oferta({ stan: 0, woo: 5 })];
  await nowaPetla().przebieg();
  expect(posty()).toEqual([]);
  for (const o of lista) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
});

// E4.30: „Wyślij zera” jest jednorazowe na ofertę — tak samo jak trasa ekranu (problemy-ofert.js).
// E4.30p: potwierdzenie niesie `przelaczenieId` bieżącego przełączenia stanów (jak trasa).
const potwierdzZera = lista => { for (const o of lista) zmienOferte(db, o.id, { iloscProblem: null,
  wyslanePola: { ...wiersz(o).wyslanePola, zeraPotwierdzone: { login: 'operator', at: '2026-11-14T12:00:30.000Z',
    przelaczenieId: przelacznikStanow(db).przelaczenieId } } }); };
const zapisaneZera = () => posty().flatMap(z => z.cialo.update).filter(p => p.stock_quantity === 0).map(p => String(p.id)).sort();
it('E4.30: „Wyślij zera” — następny przebieg zapisuje 3 zera, potem flaga znika i nowe masowe zero znów staje', async () => {
  wlacz();
  const zera = [1, 2, 3].map(() => oferta({ stan: 0, woo: 5 }));
  const inne = [1, 2, 3].map(() => oferta({ stan: 5, woo: 5 }));
  await nowaPetla().przebieg();
  expect(posty()).toEqual([]);
  for (const o of zera) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
  potwierdzZera(zera);
  await nowaPetla().przebieg();
  expect(zapisaneZera()).toEqual(zera.map(o => o.wooId).sort());
  for (const o of zera) { expect(wiersz(o).iloscProblem).toBeNull(); expect(wiersz(o).wyslanePola?.zeraPotwierdzone).toBeUndefined(); }
  zadania = [];
  await nowaPetla().przebieg();
  expect(posty()).toEqual([]);
  for (const o of zera) expect(wiersz(o).wyslanePola?.zeraPotwierdzone).toBeUndefined();
  for (const [i, o] of inne.entries()) dodajRuch(db, { kartaId: o.kartaId, rodzaj: 'korekta', ilosc: -5, klucz: `e430-woo-${i}`, at: iso() });
  await nowaPetla().przebieg();
  expect(posty()).toEqual([]);
  for (const o of inne) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
});

it('E4.30: potwierdzenie zer znika bez zapisu, gdy sklep ma już 0 albo cel wzrósł', async () => {
  wlacz();
  const juzZero = oferta({ stan: 0, woo: 0 }); const wzrosl = oferta({ stan: 5, woo: 5 });
  potwierdzZera([juzZero, wzrosl]);
  await nowaPetla().przebieg();
  expect(posty()).toEqual([]);
  for (const o of [juzZero, wzrosl]) expect(wiersz(o).wyslanePola?.zeraPotwierdzone).toBeUndefined();
});

// E4.30p (B1 recenzji): potwierdzenie sprzed wyłączenia stanów nie omija zera masowego po ponownym włączeniu.
it('E4.30p: „Wyślij zera”, wyłączenie stanów przed wysyłką, ponowne włączenie → 6/6 zero-masowe, 0 zapisów 0', async () => {
  wlacz();
  const zera = [1, 2, 3].map(() => oferta({ stan: 0, woo: 5 }));
  const inne = [1, 2, 3].map(() => oferta({ stan: 5, woo: 5 }));
  await nowaPetla().przebieg();
  for (const o of zera) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
  potwierdzZera(zera);
  przelaczStany(db, { wlacz: false, at: iso() });
  zadania = [];
  await nowaPetla().przebieg();
  expect(zadania).toEqual([]);
  czas += 7 * 24 * 3600_000;
  przelaczStany(db, { wlacz: true, at: iso() });
  const { przelaczenieId } = przelacznikStanow(db);
  expect(przelaczenieId).not.toBe(1);
  zapiszZatwierdzenieStanow(db, { przelaczenieId, zatwierdzil: 'operator', ofert: 6, skrot: 'test' }, { teraz: iso() });
  // Nowe przełączenie = nowe otwarcie stanów; wszystkie 6 kart otwarte na 0.
  for (const o of [...zera, ...inne]) zapiszOtwarcie(db, { kartaId: o.kartaId, ilosc: 0, zrodlo: 'reczne', at: iso() });
  await nowaPetla().przebieg();
  expect(zapisaneZera()).toEqual([]);
  for (const o of [...zera, ...inne]) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
  // Nieważna flaga zdjęta przy zapisie oferty.
  for (const o of zera) expect(wiersz(o).wyslanePola?.zeraPotwierdzone).toBeUndefined();
});

// E4.31 (N1 recenzji E4.30p): zero masowe zależy od ofert z nieważną flagą — bez nich 2 zera z 4 nie przekraczają progu.
it('E4.31: 6 ofert, 2 z nieważną flagą i 2 inne do zera → zero masowe, 0 zapisów 0', async () => {
  wlacz();
  const niewazne = [1, 2].map(() => oferta({ stan: 0, woo: 5 }));
  const zera = [1, 2].map(() => oferta({ stan: 0, woo: 5 }));
  const inne = [1, 2].map(() => oferta({ stan: 5, woo: 5 }));
  for (const o of niewazne) zmienOferte(db, o.id, { wyslanePola: { ...wiersz(o).wyslanePola,
    zeraPotwierdzone: { login: 'operator', at: T1, przelaczenieId: 999 } } });
  await nowaPetla().przebieg();
  expect(zapisaneZera()).toEqual([]);
  for (const o of [...niewazne, ...zera]) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
  for (const o of inne) expect(wiersz(o).iloscProblem?.kod).not.toBe('zero-masowe');
});

// E4.32a (uwaga 1 recenzji odbiorczej): mianownik zera masowego tylko z ofert prowadzących stan (manage_stock, odczyt ≥ 0).
it('E4.32a: 4 oferty do zera + 5 bez manage_stock / z ujemnym stanem → zero-masowe na czterech, 0 zapisów 0', async () => {
  wlacz();
  const zera = [1, 2, 3, 4].map(() => oferta({ stan: 0, woo: 5 }));
  const reszta = [oferta({ stan: 5, woo: 10, manage: false }), oferta({ stan: 5, woo: 10, manage: 'parent' }),
    oferta({ stan: 5, woo: 10, manage: false }), oferta({ stan: 5, woo: 10 }), oferta({ stan: 5, woo: 10 })];
  for (const [i, o] of reszta.slice(3).entries()) sklep.set(o.wooId, { ...sklep.get(o.wooId), stock_quantity: -1 - i });
  await nowaPetla().przebieg();
  expect(zapisaneZera()).toEqual([]);
  for (const o of zera) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
  for (const o of reszta) expect(wiersz(o).iloscProblem?.kod).not.toBe('zero-masowe');
});

it('E4.30p: nieważna flaga (inne przełączenie) przy celu null nie wymusza odczytu ze sklepu', async () => {
  wlacz();
  const o = oferta({ stan: 0, woo: 5 });
  zmienOferte(db, o.id, { wyslanePola: { zeraPotwierdzone: { login: 'operator', at: iso(), przelaczenieId: 1 } } });
  przelaczStany(db, { wlacz: false, at: iso() });
  przelaczStany(db, { wlacz: true, at: iso() });
  zmienOferte(db, o.id, { odczytanoAt: iso() });
  zadania = [];
  await nowaPetla().przebieg();
  expect(zadania).toEqual([]);
  expect(wiersz(o).wyslanePola?.zeraPotwierdzone?.przelaczenieId).toBe(1);
});

it('E4.30: brak-stanu zapisany jak w ERLI (bez zapisu do sklepu), po otwarciu stanu znika', async () => {
  wlacz();
  const o = oferta({ stan: null, woo: 10 });
  await nowaPetla().przebieg();
  expect(posty()).toEqual([]);
  expect(wiersz(o).iloscProblem).toMatchObject({ kod: 'brak-stanu', wstrzymuje: false });
  zapiszOtwarcie(db, { kartaId: o.kartaId, ilosc: 10, zrodlo: 'reczne', at: iso() });
  await nowaPetla().przebieg();
  expect(posty()).toEqual([]);
  expect(wiersz(o).iloscProblem).toBeNull();
});

it('N1c (D54): R = cel w toku jest zgodny, także gdy cel zmienił się po zerwanym zapisie', async () => {
  wlacz(); const o = oferta(); sprzedazAllegro(o);
  przyPost = cialo => {
    for (const p of cialo.update) sklep.get(String(p.id)).stock_quantity = p.stock_quantity;
    throw new Error('połączenie zerwane');
  };
  await nowaPetla().przebieg();
  przyPost = () => {};
  sprzedazAllegro(o, 1, '2026-11-14T12:01:00.000Z');
  czas += 120000;
  await nowaPetla().przebieg();
  expect(posty().map(p => p.cialo.update[0].stock_quantity)).toEqual([9, 8]);
  expect(wiersz(o)).toMatchObject({ wyslanaIlosc: 8, iloscWToku: null, iloscProblem: null });
});

it('N2: sprzedaż w Woo, R = cel, ruch +20 w trakcie odczytu → T przy bazie = chwila migawki, bez skoku', async () => {
  wlacz(); const o = oferta();
  zamowienieWoo({ produkt: o.wooId, zmienione: '2026-11-14T11:50:00.000Z' });
  sklep.get(o.wooId).stock_quantity = 9;
  let raz = true;
  przyGet = () => {
    if (!raz) return; raz = false;
    czas += 1000;
    dodajRuch(db, { kartaId: o.kartaId, rodzaj: 'przyjecie', ilosc: 20, klucz: 'r-20b', at: iso() });
    czas += 1000;
  };
  const petla = nowaPetla();
  await petla.przebieg();
  expect(wiersz(o)).toMatchObject({ wyslanaIlosc: 9, iloscWyslanaAt: '2026-11-14T12:00:00.000Z', stanKartyWyslany: 9 });
  czas += 300000; puls(new Date(czas - 60000).toISOString());
  await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod ?? null).not.toBe('skok');
});

it('N4: zgodny odczyt po nieznanym wyniku zeruje próby, termin i błąd — następna obniżka od razu', async () => {
  wlacz();
  const o = oferta({ poprzednia: { liczbaProb: 2, nastepnaProbaAt: '2026-11-14T12:30:00.000Z', blad: 'połączenie zerwane',
    iloscWToku: { cel: 9, at: '2026-11-14T11:58:00.000Z' } } });
  sprzedazAllegro(o); sprzedazAllegro(o, 1, '2026-11-14T11:59:00.000Z');
  sklep.get(o.wooId).stock_quantity = 9; // sklep przyjął poprzedni zapis 9, odpowiedź zginęła
  await nowaPetla().przebieg();
  expect(posty().map(p => p.cialo.update[0].stock_quantity)).toEqual([8]);
  expect(wiersz(o)).toMatchObject({ wyslanaIlosc: 8, liczbaProb: 0, nastepnaProbaAt: null, blad: null });
});
