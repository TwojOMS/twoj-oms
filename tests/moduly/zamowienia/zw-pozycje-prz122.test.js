// PRZ-122.B07c — stawka „zw” w zamówieniach: flaga z programu fakturowego (`opis.wbudowany === true`, czyli
// TwojeFaktury) dochodzi do karty zamówienia, „Dodaj pozycję”, edycji zbiorczej, „Nowego zamówienia”, rabatu,
// opłaty i proformy. Bez flagi (inFakt, program „test”, brak programu) — „zw” odrzucone, wyniki jak dotąd.
// Trasy przez `app.inject` (prawdziwy skład modułów), program to atrapa kontraktu; sieć niepotrzebna.
// Dane zmyślone („Pracownia Półcień”, „Lampa stołowa Kałamarz”).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie, dodajPozycjeReczna } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszStawkeDomyslna } from '../../../src/moduly/faktury/db/stawka-vat.js';
import { createProforma } from '../../../src/moduly/faktury/services/proforma.js';
import { proformyZamowienia } from '../../../src/moduly/faktury/db/proformy.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';
import { NAZWA_OBSLUGI } from '../../../src/domena/oplata-obslugi.js';
import { programTestowy } from '../../pomoc/program-testowy.js';
import { dopiszKlientaZbiorczego } from '../faktury/_klient-zbiorczy-pomocniki.js';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';

// Produkt w lustrze magazynu (cennik „pro” z cenników testowych serwera) — zmyślony.
const PRODUKT = Object.freeze({
  kanal: 'pro', produkt_id: '7001', wariant_id: '', nazwa: 'Klosz lniany Półcień', sku_sklepu: 'KL-LN-01', cena_gr: 7490,
  rozmiar_tekst: '', kategorie: [], zdjecia: [], adres: 'https://polcien.invalid/klosz', odczytane_at: '2026-10-27T08:00:00',
});

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-10-27T12:00:00', ostatni_blad: null }) };
const ZEGAR = () => new Date('2026-10-27T10:00:00.000Z');

/** TwojeFaktury w kontrakcie: program testowy z `opis.wbudowany` — jedyna różnica, którą widzi panel. */
function programWbudowany() {
  const p = programTestowy({ id: 'twojefaktury' });
  return { ...p, opis: Object.freeze({ ...p.opis, wbudowany: true }) };
}
// Surowy klient inFaktu (bez `opis`) — tak usługę `infakt` widzi moduł zamówień przy inFakcie z pliku.
const SUROWY_INFAKT = Object.freeze({ baseUrl: 'https://infakt.invalid/api/v3' });
const BEZ_FLAGI = [
  ['brak programu', () => undefined],
  ['inFakt (surowy klient)', () => SUROWY_INFAKT],
  ['program „test”', () => programTestowy({ id: 'test' })],
];

const zamowienie = (nad = {}) => ({
  zrodlo_id: 2201, numer: '2201', klient: { first_name: 'Ewa', last_name: 'Półcień', email: 'ewa@polcien.invalid' },
  dostawa: { city: 'Warszawa' }, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '212.90', koszt_dostawy_brutto: '89.90', koszt_dostawy_netto: '73.09', status_woo: 'processing',
  oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-27T09:00:00',
  pozycje: [{
    zrodlo_id: 4321, nazwa: 'Lampa stołowa Kałamarz', sku: 'LMP-KAL-01', ilosc: 2, cena_brutto: '61.50',
    cena_netto: '50.00', brutto_linii: '123.00', netto_linii: '100.00', vat: null,
  }],
  ...nad,
});

let db; let app; let katalog;
async function panel(program) {
  db = openOmsDb(':memory:');
  katalog = mkdtempSync(join(tmpdir(), 'prz122-b07c-'));
  const proforma = createProforma({ db, teraz: ZEGAR, config: {
    nadawca: { nazwa: 'Pracownia Półcień', ulica: 'Lampowa 7', kod: '00-950', miasto: 'Warszawa', kraj: 'PL', phone: '' },
    proforma: { nip: '1234563218', rachunek: '34109010140000000000000000', bank: 'Bank Przykładowy', katalog },
  } });
  app = buildOmsServer({ db, config, poller, proforma, ...(program === undefined ? {} : { infakt: program }) });
  await app.ready();
}
afterEach(async () => { await app?.close(); rmSync(katalog, { recursive: true, force: true }); app = null; });

const karta = async (id, query = '') => (await app.inject({ method: 'GET', url: `/zamowienia/${id}${query}`, headers: naglowek })).body;
// Formularz „Dodaj pozycję” jest w trybie edycji pozycji (`?edytuj=pozycje`).
const kartaEdycji = (id) => karta(id, '?edytuj=pozycje');
const ekranNowego = async () => (await app.inject({ method: 'GET', url: '/zamowienia/nowe', headers: naglowek })).body;
const wyslij = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });
const sekcjaPozycji = (html) => html.slice(html.indexOf('id="pozycje"'), html.indexOf('id="przesylka"'));
const formularzDodaj = (html) => /<form method="post" action="\/zamowienia\/\d+\/pozycje\/zapisz" class="formularz-pozycji"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';
const reczne = (id) => db.prepare("SELECT nazwa, vat, cena_brutto, brutto_linii FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'reczna' ORDER BY id").all(id);
const kolumnaVat = (html) => [...sekcjaPozycji(html).matchAll(/<td class="liczba kol-vat">([^<]*)<\/td>/gu)].map((m) => m[1].trim());
const NOWE = { w_nazwa: 'Ewa Półcień', dostawa: 'dpd', platnosc: 'przelew', koszt_dostawy_brutto: '19,00',
  poz_nazwa: 'Kurs lutowania', poz_ilosc: '1', poz_sku: '', poz_cena_brutto: '' };

describe('PRZ-122.B07c TwojeFaktury (flaga `zw`) — karta zamówienia', () => {
  beforeEach(async () => { await panel(programWbudowany()); });

  it('„Dodaj pozycję” ze stawką „zw”: zapis „zw”, brutto = netto; karta pokazuje „zw” i VAT 0 tej linii', async () => {
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    const r = await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Kurs lutowania', ilosc: '1', cena_netto: '57', vat: 'zw' });
    expect(r.statusCode, r.body).toBe(302);
    expect(reczne(id)).toEqual([{ nazwa: 'Kurs lutowania', vat: 'zw', cena_brutto: '57.00', brutto_linii: '57.00' }]);
    const html = await karta(id);
    expect(kolumnaVat(html)).toEqual(['23%', 'zw', '23%', '']);
    // 123,00 i 89,90 po 23% → 173,09 netto i 39,81 VAT; „zw” dokłada 57,00 do netto i brutto, 0 do VAT.
    const s = sekcjaPozycji(html);
    expect(s).toMatch(/<span data-pv-netto>230\.09<\/span> zł/u);
    expect(s).toMatch(/<span data-pv-vat>39\.81<\/span> zł/u);
    expect(s).toMatch(/<span data-pv-brutto>269\.90<\/span> zł/u);
    expect(html).not.toContain('zw%');
  });

  it('lista stawek „Dodaj pozycję” ma „zw” z etykietą bez „%”', async () => {
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    const f = formularzDodaj(await kartaEdycji(id));
    expect(f).toMatch(/<option value="23" selected>23%<\/option>/u);
    expect(f).toMatch(/<option value="zw">zw<\/option>/u);
  });

  it('edycja zbiorcza: pozycja ręczna 8% → „zw” zapisuje się; lista edycji ma „zw” bez „%”', async () => {
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Album', ilosc: '1', cena_brutto: '10.80', vat: '8' });
    const klucz = pobierzZamowienie(db, id).pozycje.find((p) => p.reczna).klucz;
    const edycja = await kartaEdycji(id);
    expect(edycja).toMatch(/<select name="vat" aria-label="Stawka VAT">[\s\S]*?<option value="zw">zw<\/option>/u);
    const r = await wyslij(`/zamowienia/${id}/pozycje/zapisz`, {
      klucz: ['s4321', klucz], nazwa: ['Lampa stołowa Kałamarz', 'Album'], ilosc: ['2', '1'],
      cena_brutto: ['61.50', '10.80'], vat: ['', 'zw'],
    });
    expect(r.statusCode, r.body).toBeLessThan(400);
    expect(reczne(id)).toEqual([{ nazwa: 'Album', vat: 'zw', cena_brutto: '10.80', brutto_linii: '10.80' }]);
  });

  it('firma zwolniona (domyślna „zw”): formularz z „zw” zaznaczoną, pozycja bez pola stawki dostaje „zw”', async () => {
    zapiszStawkeDomyslna(db, 'zw', { zw: true });
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    const edycja = await kartaEdycji(id);
    expect(edycja).toMatch(/class="formularz-pozycji" data-vat="zw"/u);
    expect(formularzDodaj(edycja)).toMatch(/<option value="zw" selected>zw<\/option>/u);
    expect(edycja).not.toContain('zw%');
    const html = await karta(id);
    // Pozycja i dostawa ze sklepu też „zw” — netto = brutto, VAT 0.
    expect(kolumnaVat(html)).toEqual(['zw', 'zw', '']);
    expect(sekcjaPozycji(html)).toMatch(/<span data-pv-vat>0\.00<\/span> zł/u);
    expect(html).not.toContain('zw%');
    const r = await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Kurs lutowania', ilosc: '2', cena_netto: '40' });
    expect(r.statusCode, r.body).toBe(302);
    expect(reczne(id)).toEqual([{ nazwa: 'Kurs lutowania', vat: 'zw', cena_brutto: '40.00', brutto_linii: '80.00' }]);
  });

  it('zmiana rabatu przelicza pozycję z magazynu ze stawką „zw” (zapis stawki „zw” z flagą)', async () => {
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    dodajPozycjeReczna(db, id, { nazwa: 'Klosz lniany', sku: 'KL-1', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00',
      cena_katalogowa: '100.00', vat: 'zw' }, { zw: true });
    const r = await wyslij(`/zamowienia/${id}/ustalenia`, { rabat_procent: '10' });
    expect(r.statusCode, r.body).toBe(302);
    expect(reczne(id)).toEqual([{ nazwa: 'Klosz lniany', vat: 'zw', cena_brutto: '90.00', brutto_linii: '90.00' }]);
  });

  // Recenzja B07c (pkt 4): pozycja z magazynu dostaje domyślną „zw” — netto = brutto na karcie.
  it('firma zwolniona: „Dodaj z magazynu” na karcie zapisuje pozycję z domyślną „zw”', async () => {
    zapiszStawkeDomyslna(db, 'zw', { zw: true });
    zapiszProduktSklepowy(db, PRODUKT);
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    const r = await wyslij(`/zamowienia/${id}/pozycje/z-magazynu`, { kanal: 'pro', produkt_id: '7001', wariant_id: '', ilosc: '1' });
    expect(r.statusCode, r.body).toBe(302);
    expect(reczne(id)).toEqual([{ nazwa: 'Klosz lniany Półcień', vat: 'zw', cena_brutto: '74.90', brutto_linii: '74.90' }]);
  });

  it('proforma z pozycją „zw”: w PDF „zw” bez „%”, VAT tej linii 0', async () => {
    const id = zapiszZamowienie(db, 'pro', zamowienie({ nip: '1234500011', kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
      koszt_dostawy_netto: '0.00' }), {});
    await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Kurs lutowania', ilosc: '1', cena_brutto: '57', vat: 'zw' });
    const r = await wyslij(`/zamowienia/${id}/proforma`, {});
    expect(r.statusCode, r.body).toBe(302);
    const [p] = proformyZamowienia(db, id);
    expect(p.kwota_brutto).toBe('180.00');
    const tekst = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', p.plik_sciezka, '-'], { encoding: 'utf8' });
    expect(tekst).toMatch(/\bzw\b/u);
    expect(tekst).not.toContain('zw%');
    expect(tekst).toContain('23%');
  });
});

describe('PRZ-122.B07c TwojeFaktury (flaga `zw`) — nowe zamówienie', () => {
  beforeEach(async () => { await panel(programWbudowany()); });

  it('lista stawek ma „zw” bez „%”; wiersz „zw” zapisuje się i liczy netto = brutto', async () => {
    const t = await ekranNowego();
    expect(t).toMatch(/<select name="poz_vat" aria-label="Stawka VAT">[\s\S]*?<option value="zw">zw<\/option>/u);
    expect(t).not.toContain('zw%');
    const r = await wyslij('/zamowienia/nowe', { ...NOWE, poz_cena_netto: '57', poz_vat: 'zw' });
    expect(r.statusCode, r.body).toBe(302);
    expect(reczne(1)).toEqual([{ nazwa: 'Kurs lutowania', vat: 'zw', cena_brutto: '57.00', brutto_linii: '57.00' }]);
  });

  it('firma zwolniona: domyślna „zw” zaznaczona, dostawa „zw” (nie „zw%”), wiersz bez stawki → „zw”', async () => {
    zapiszStawkeDomyslna(db, 'zw', { zw: true });
    const t = await ekranNowego();
    expect(t).toMatch(/<form method="post" action="\/zamowienia\/nowe" data-vat="zw"/u);
    expect(t).toMatch(/<option value="zw" selected>zw<\/option>/u);
    expect(t).toMatch(/data-dostawa-stawka>zw<\/td>/u);
    expect(t).not.toContain('zw%');
    const r = await wyslij('/zamowienia/nowe', { ...NOWE, poz_cena_netto: '40' });
    expect(r.statusCode, r.body).toBe(302);
    expect(reczne(1)).toEqual([{ nazwa: 'Kurs lutowania', vat: 'zw', cena_brutto: '40.00', brutto_linii: '40.00' }]);
  });

  // Recenzja B07c (pkt 4): wiersz wstawiony z magazynu dostaje domyślną „zw” i netto = brutto.
  it('firma zwolniona: „Dodaj z magazynu” wstawia wiersz ze stawką „zw” i netto = brutto', async () => {
    zapiszStawkeDomyslna(db, 'zw', { zw: true });
    zapiszProduktSklepowy(db, PRODUKT);
    const r = await wyslij('/zamowienia/nowe/magazyn/dodaj', {
      magazyn: 'klosz', cennik: 'pro', wybrany: '0', mag_kanal: 'pro', mag_produkt_id: '7001', mag_wariant_id: '', mag_ilosc: '1',
    });
    expect(r.statusCode, r.body).toBe(200);
    const wiersz = /value="Klosz lniany Półcień[\s\S]*?<\/tr>/u.exec(r.body)?.[0] ?? '';
    expect(wiersz).toMatch(/name="poz_cena_netto" value="74\.90"/u);
    expect(wiersz).toMatch(/<option value="zw" selected>zw<\/option>/u);
  });
});

describe.each(BEZ_FLAGI)('PRZ-122.B07c bez flagi `zw` (%s) — jak przed zmianą', (_nazwa, program) => {
  beforeEach(async () => { await panel(program()); });

  it('„Dodaj pozycję” ze stawką „zw” → 400, nic nie zapisane; lista bez „zw”', async () => {
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    const r = await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Kurs lutowania', ilosc: '1', cena_netto: '57', vat: 'zw' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Nieznana stawka VAT „zw” — wybierz 23, 8, 5, 0%.');
    expect(reczne(id)).toEqual([]);
    expect(await kartaEdycji(id)).not.toMatch(/value="zw"/u);
    expect(kolumnaVat(await karta(id))).toEqual(['23%', '23%', '']);
  });

  it('zapisana domyślna „zw” (np. po zmianie programu) czyta się jako 23 — karta, formularz i nowa pozycja', async () => {
    zapiszStawkeDomyslna(db, 'zw', { zw: true });
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    const html = await kartaEdycji(id);
    expect(html).toMatch(/class="formularz-pozycji" data-vat="23"/u);
    expect(formularzDodaj(html)).toMatch(/<option value="23" selected>23%<\/option>/u);
    expect(html).not.toMatch(/value="zw"/u);
    await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Kurs lutowania', ilosc: '1', cena_netto: '100' });
    expect(reczne(id)).toEqual([{ nazwa: 'Kurs lutowania', vat: '23', cena_brutto: '123.00', brutto_linii: '123.00' }]);
  });

  // Recenzja B07c (pkt 2): pozycja „zw” zostawiona przez TwojeFaktury, potem zmiana programu. Zapis zbiorczy
  // odmawia 400 PRZED bazą — żaden wiersz nie zapisany (wcześniej: 500 po zapisie pierwszych wierszy).
  it('zapis zbiorczy z zapisaną „zw” (po zmianie programu) → 400, nic nie zapisane, wpis w logu', async () => {
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    dodajPozycjeReczna(db, id, { nazwa: 'Album', ilosc: 1, cena_brutto: '10.80', brutto_linii: '10.80', vat: '8' });
    dodajPozycjeReczna(db, id, { nazwa: 'Kurs lutowania', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: 'zw' }, { zw: true });
    const przed = reczne(id);
    const klucze = pobierzZamowienie(db, id).pozycje.filter((p) => p.reczna).map((p) => p.klucz);
    const r = await wyslij(`/zamowienia/${id}/pozycje/zapisz`, {
      klucz: ['s4321', ...klucze], nazwa: ['Lampa stołowa Kałamarz', 'Album', 'Kurs lutowania'], ilosc: ['2', '2', '1'],
      cena_brutto: ['61.50', '10.80', '100.00'], vat: ['', '', ''],
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.body).toContain('„zw”');
    expect(reczne(id)).toEqual(przed);
    const wpis = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'pozycje.zapisz'").all(id);
    expect(wpis.map((w) => w.wynik).join('\n')).toMatch(/^BŁĄD: .*„zw”/u);
  });

  it('nowe zamówienie: wiersz „zw” → 400, zamówienie nie powstaje; lista bez „zw”', async () => {
    expect(await ekranNowego()).not.toMatch(/value="zw"/u);
    const r = await wyslij('/zamowienia/nowe', { ...NOWE, poz_cena_netto: '57', poz_vat: 'zw' });
    expect(r.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM zamowienia').get().n).toBe(0);
  });
});

describe('PRZ-122.B07c zalozZamowienieReczne — opłata i pozycje z flagą `zw`', () => {
  const dane = {
    klient: { first_name: 'Ewa', last_name: 'Półcień', email: 'ewa@polcien.invalid' }, dostawa: { first_name: 'Ewa' },
    nip: '1234500011', etykietaKlienta: true, chce_fakture: 0, metoda_wysylki: 'dpd', pobranie: 0,
    metoda_platnosci: 'Przelew', koszt_dostawy_brutto: '0.00',
    pozycje: [{ nazwa: 'Kurs lutowania', sku: null, ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: 'zw' }],
  };
  beforeEach(() => { db = openOmsDb(':memory:'); dopiszKlientaZbiorczego(db); zapiszStawkeDomyslna(db, 'zw', { zw: true }); });
  afterEach(() => { db.close(); });

  it('z flagą: pozycja „zw” zapisana, opłata za obsługę dostaje domyślną „zw”', () => {
    const { id } = zalozZamowienieReczne({ db, dane, znacznik: '2026-10-27T09:00:00.000Z', zw: true });
    expect(reczne(id).map((p) => [p.nazwa, p.vat])).toEqual([['Kurs lutowania', 'zw'], [NAZWA_OBSLUGI, 'zw']]);
  });

  it('bez flagi: opłata dostaje 23 (zapisana „zw” czytana jak dotąd), pozycja „zw” odrzucona', () => {
    const { id } = zalozZamowienieReczne({ db, dane: { ...dane, pozycje: [{ ...dane.pozycje[0], vat: '8' }] },
      znacznik: '2026-10-27T09:00:00.000Z' });
    expect(reczne(id).map((p) => [p.nazwa, p.vat])).toEqual([['Kurs lutowania', '8'], [NAZWA_OBSLUGI, '23']]);
    expect(() => zalozZamowienieReczne({ db, dane, znacznik: '2026-10-27T09:00:00.000Z' })).toThrow(/Nieznana stawka VAT „zw”/u);
  });
});
