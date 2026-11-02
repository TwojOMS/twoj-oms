// PRZ-122.B07f — firma zwolniona z VAT (TwojeFaktury + zapisane zwolnienie, art. 113) i nabywca z numerem VAT UE:
// to nie WDT (decyzja właściciela 27.10). Ceny zamówienia zostają brutto — bez ÷ 1,23 przy wstawianiu z magazynu, przy
// rabacie i w formularzu „Nowe zamówienie”; podsumowanie VAT bez „0% — WDT”; proforma z pozycjami „zw”.
// Kontrolnie: TwojeFaktury bez zwolnienia i inFakt z zapisanym zwolnieniem → ÷ 1,23 i „0% — WDT” jak dotąd.
// Trasy przez `app.inject` (prawdziwy skład modułów). Dane zmyślone („Pracownia Półcień”, DE123456789).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie, dodajPozycjeReczna } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszStawkeDomyslna } from '../../../src/moduly/faktury/db/stawka-vat.js';
import { zapiszZwolnienie, PODSTAWA_ART_113 } from '../../../src/moduly/faktury/db/zwolnienie-vat.js';
import { createProforma } from '../../../src/moduly/faktury/services/proforma.js';
import { proformyZamowienia } from '../../../src/moduly/faktury/db/proformy.js';
import { programTestowy } from '../../pomoc/program-testowy.js';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';

const UE = 'DE123456789';
// Produkt w lustrze magazynu (cennik „pro” z cenników testowych serwera): 123,00 zł brutto.
const PRODUKT = Object.freeze({
  kanal: 'pro', produkt_id: '7001', wariant_id: '', nazwa: 'Klosz lniany Półcień', sku_sklepu: 'KL-LN-01', cena_gr: 12300,
  rozmiar_tekst: '', kategorie: [], zdjecia: [], adres: 'https://polcien.invalid/klosz', odczytane_at: '2026-10-27T08:00:00',
});

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-10-27T12:00:00', ostatni_blad: null }) };
const ZEGAR = () => new Date('2026-10-27T10:00:00.000Z');

/** TwojeFaktury w kontrakcie: program testowy z `opis.wbudowany`. */
function programWbudowany() {
  const p = programTestowy({ id: 'twojefaktury' });
  return { ...p, opis: Object.freeze({ ...p.opis, wbudowany: true }) };
}
// Surowy klient inFaktu (bez `opis`) — tak usługę `infakt` widzi moduł zamówień przy inFakcie z pliku.
const SUROWY_INFAKT = Object.freeze({ baseUrl: 'https://infakt.invalid/api/v3' });

const zamowienie = (nad = {}) => ({
  zrodlo_id: 2301, numer: '2301', klient: { first_name: 'Hans', last_name: 'Testmann', email: 'hans@polcien.invalid' },
  dostawa: { city: 'Berlin' }, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: UE,
  kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00', status_woo: 'processing',
  oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-27T09:00:00',
  pozycje: [{
    zrodlo_id: 4401, nazwa: 'Lampa stołowa Kałamarz', sku: 'LMP-KAL-01', ilosc: 2, cena_brutto: '61.50',
    cena_netto: '50.00', brutto_linii: '123.00', netto_linii: '100.00', vat: null,
  }],
  ...nad,
});

let db; let app; let katalog;
async function panel(program, { zwolniona }) {
  db = openOmsDb(':memory:');
  if (zwolniona) zapiszZwolnienie(db, { zwolniona: true, podstawa: PODSTAWA_ART_113, rodzaj: 'ustawa' });
  zapiszStawkeDomyslna(db, '23', { zw: true });
  katalog = mkdtempSync(join(tmpdir(), 'prz122-b07f-'));
  const proforma = createProforma({ db, teraz: ZEGAR, config: {
    nadawca: { nazwa: 'Pracownia Półcień', ulica: 'Lampowa 7', kod: '00-950', miasto: 'Warszawa', kraj: 'PL', phone: '' },
    proforma: { nip: '1234563218', rachunek: '34109010140000000000000000', bank: 'Bank Przykładowy', katalog },
  } });
  // PRZ-122.B07g: atrapa nadania — ekran „Nadaj” odmawia 503 bez niej; nic nie nadaje.
  app = buildOmsServer({ db, config, poller, proforma, infakt: program, nadanie: {} });
  await app.ready();
}
afterEach(async () => { await app?.close(); rmSync(katalog, { recursive: true, force: true }); app = null; });

const karta = async (id) => (await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek })).body;
const wyslij = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });
const reczne = (id) => db.prepare("SELECT cena_brutto, brutto_linii FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'reczna' ORDER BY id").all(id);
const pasWdtWidoczny = (html) => {
  const m = /<span class="pv-wdt" data-pv-wdt( hidden)?>/u.exec(html);
  expect(m, 'podsumowanie VAT na stronie').not.toBeNull();
  return m[1] === undefined;
};

async function zMagazynuNaKarcie() {
  zapiszProduktSklepowy(db, PRODUKT);
  const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
  const r = await wyslij(`/zamowienia/${id}/pozycje/z-magazynu`, { kanal: 'pro', produkt_id: '7001', wariant_id: '', ilosc: '1' });
  expect(r.statusCode, r.body).toBe(302);
  return reczne(id)[0].cena_brutto;
}
async function zMagazynuDoFormularza() {
  zapiszProduktSklepowy(db, PRODUKT);
  const r = await wyslij('/zamowienia/nowe/magazyn/dodaj', {
    magazyn: 'klosz', cennik: 'pro', wybrany: '0', mag_kanal: 'pro', mag_produkt_id: '7001', mag_wariant_id: '', mag_ilosc: '1', f_nip: UE,
  });
  expect(r.statusCode, r.body).toBe(200);
  const wiersz = /value="Klosz lniany Półcień[\s\S]*?<\/tr>/u.exec(r.body)?.[0] ?? '';
  return { brutto: /name="poz_cena_brutto" value="([^"]*)"/u.exec(wiersz)?.[1], wdt: pasWdtWidoczny(r.body) };
}
async function rabatOdKatalogowej() {
  // Pozycja wchodzi tą samą drogą co w panelu (z magazynu), potem rabat 10% przelicza ją od ceny katalogowej.
  zapiszProduktSklepowy(db, PRODUKT);
  const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
  const z = await wyslij(`/zamowienia/${id}/pozycje/z-magazynu`, { kanal: 'pro', produkt_id: '7001', wariant_id: '', ilosc: '1' });
  expect(z.statusCode, z.body).toBe(302);
  const r = await wyslij(`/zamowienia/${id}/ustalenia`, { rabat_procent: '10' });
  expect(r.statusCode, r.body).toBe(302);
  return reczne(id)[0].cena_brutto;
}
async function noweZamowienieNetto() {
  const r = await wyslij('/zamowienia/nowe', {
    w_nazwa: 'Hans Testmann', dostawa: 'dpd', platnosc: 'przelew', koszt_dostawy_brutto: '0', f_chce_fakture: '1', f_nip: UE,
    f_nazwa: 'Testmann GmbH', poz_nazwa: 'Lampa stołowa Kałamarz', poz_ilosc: '1', poz_sku: '', poz_cena_brutto: '',
    poz_cena_netto: '100', poz_vat: '23',
  });
  expect(r.statusCode, r.body).toBe(302);
  return db.prepare('SELECT cena_brutto FROM pozycje ORDER BY id DESC LIMIT 1').get().cena_brutto;
}
async function tekstProformy() {
  // Firma zwolniona ma w Ustawieniach domyślną „zw” — pozycja sklepu bez stawki dostaje ją na proformie.
  zapiszStawkeDomyslna(db, 'zw', { zw: true });
  const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
  const r = await wyslij(`/zamowienia/${id}/proforma`, {});
  expect(r.statusCode, r.body).toBe(302);
  const [p] = proformyZamowienia(db, id);
  expect(p.kwota_brutto).toBe('123.00');
  return execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', p.plik_sciezka, '-'], { encoding: 'utf8' });
}

describe('PRZ-122.B07f firma zwolniona (TwojeFaktury + art. 113), nabywca z numerem UE — nie WDT', () => {
  beforeEach(async () => { await panel(programWbudowany(), { zwolniona: true }); });

  it('„Dodaj z magazynu” na karcie: 123,00 zł zostaje 123,00 (bez ÷ 1,23)', async () => {
    expect(await zMagazynuNaKarcie()).toBe('123.00');
  });

  it('„Dodaj z magazynu” w nowym zamówieniu: wiersz 123,00 brutto, podsumowanie bez „0% — WDT”', async () => {
    expect(await zMagazynuDoFormularza()).toEqual({ brutto: '123.00', wdt: false });
  });

  it('rabat 10% liczy od brutto katalogowego: 110,70 (nie 90,00)', async () => {
    expect(await rabatOdKatalogowej()).toBe('110.70');
  });

  it('nowe zamówienie: netto 100 przy 23% → brutto 123,00 (nie stawka 0)', async () => {
    expect(await noweZamowienieNetto()).toBe('123.00');
  });

  it('karta: podsumowanie VAT bez „0% — WDT”', async () => {
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    expect(pasWdtWidoczny(await karta(id))).toBe(false);
  });

  it('proforma: pozycje „zw”, wiersz „zw” w podsumowaniu, bez 0%', async () => {
    const tekst = await tekstProformy();
    expect(tekst).toMatch(/\bzw\b/u);
    expect(tekst).not.toMatch(/\b0\s?%/u);
  });
});

describe.each([
  ['TwojeFaktury bez zwolnienia', programWbudowany, false],
  ['inFakt z zapisanym zwolnieniem', () => SUROWY_INFAKT, true],
])('PRZ-122.B07f kontrolnie (%s), nabywca z numerem UE — WDT jak dotąd', (_nazwa, program, zwolniona) => {
  beforeEach(async () => { await panel(program(), { zwolniona }); });

  it('„Dodaj z magazynu” na karcie: 123,00 ÷ 1,23 = 100,00', async () => {
    expect(await zMagazynuNaKarcie()).toBe('100.00');
  });

  it('„Dodaj z magazynu” w nowym zamówieniu: 100,00 i „0% — WDT”', async () => {
    expect(await zMagazynuDoFormularza()).toEqual({ brutto: '100.00', wdt: true });
  });

  it('rabat 10%: 110,70 ÷ 1,23 = 90,00', async () => {
    expect(await rabatOdKatalogowej()).toBe('90.00');
  });

  it('nowe zamówienie: netto 100 → brutto 100,00 (stawka 0)', async () => {
    expect(await noweZamowienieNetto()).toBe('100.00');
  });

  it('karta: podsumowanie VAT z „0% — WDT”', async () => {
    const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
    expect(pasWdtWidoczny(await karta(id))).toBe(true);
  });

  it('proforma: stawka 0%, bez „zw”', async () => {
    const tekst = await tekstProformy();
    expect(tekst).toMatch(/\b0\s?%/u);
    expect(tekst).not.toMatch(/\bzw\b/u);
  });
});

// --- PRZ-122.B07g: trasy bez testu po B07f, ekran nadania, pas i atrybut `data-zwolniona` na karcie ---
const API = { ...naglowek, host: 'localhost' };
async function pozycjaRecznaZNetto() {
  const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
  const r = await wyslij(`/zamowienia/${id}/pozycje`, { nazwa: 'Klosz lniany', ilosc: '1', cena_netto: '100', cena_brutto: '', vat: '23' });
  expect(r.statusCode, r.body).toBe(302);
  return reczne(id)[0].cena_brutto;
}
async function zapiszPozycjeHurtem() {
  // Formularz „Edytuj pozycje” niesie tylko brutto (parsujHurtPozycji: klucz, nazwa, ilość, cena brutto, stawka).
  const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
  dodajPozycjeReczna(db, id, { nazwa: 'Klosz lniany', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', vat: '23' });
  const klucz = pobierzZamowienie(db, id).pozycje.find((p) => p.reczna).klucz;
  const r = await wyslij(`/zamowienia/${id}/pozycje/zapisz`, {
    klucz: ['s4401', klucz], nazwa: ['Lampa stołowa Kałamarz', 'Klosz lniany'], ilosc: ['2', '1'],
    cena_brutto: ['61.50', '123.00'], vat: ['', '23'],
  });
  expect(r.statusCode, r.body).toBeLessThan(400);
  return reczne(id)[0].cena_brutto;
}
async function zKartyPanelu() {
  const r = await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: API, payload: {
    kartaId: 'karta-b07g', klient: { first_name: 'Hans', last_name: 'Testmann', email: 'hans@polcien.invalid' },
    dostawa: { first_name: 'Hans', last_name: 'Testmann', address_1: 'Lampenweg 3', postcode: '10115', city: 'Berlin' },
    nip: UE, chceFakture: true, kosztDostawyBrutto: '0.00',
    pozycje: [{ nazwa: 'Klosz lniany', ilosc: 1, cena_netto: '100', vat: '23' }],
  } });
  expect(r.statusCode, r.body).toBe(201);
  return reczne(r.json().id)[0].cena_brutto;
}
async function nettoNaNadaniu() {
  const id = zapiszZamowienie(db, 'pro', zamowienie(), {});
  dodajPozycjeReczna(db, id, { nazwa: 'Album Półcień', ilosc: 1, cena_brutto: '108.00', brutto_linii: '108.00', vat: '8' });
  const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
  expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
  const wiersz = /Album Półcień[\s\S]*?<\/tr>/u.exec(r.body)?.[0] ?? '';
  return /<td class="liczba">([^<]*)<\/td>/u.exec(wiersz)?.[1]?.trim();
}
const atrybutZwolnionej = (html, klasa) => {
  const m = new RegExp(`<form[^>]*${klasa}[^>]*>`, 'u').exec(html);
  expect(m, `formularz ${klasa}`).not.toBeNull();
  return /data-zwolniona="1"/u.test(m[0]);
};
const kartaEdycji = async (id) => (await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=pozycje`, headers: naglowek })).body;
const ekranNowego = async () => (await app.inject({ method: 'GET', url: '/zamowienia/nowe', headers: naglowek })).body;

describe('PRZ-122.B07g firma zwolniona, nabywca z numerem UE — trasy, nadanie, karta', () => {
  beforeEach(async () => { await panel(programWbudowany(), { zwolniona: true }); });

  it('ręczna pozycja z netto 100 przy 23% → 123,00 (reczne.js, POST /pozycje)', async () => {
    expect(await pozycjaRecznaZNetto()).toBe('123.00');
  });
  it('„Zapisz pozycje” — brutto 123,00 zostaje 123,00', async () => {
    expect(await zapiszPozycjeHurtem()).toBe('123.00');
  });
  it('zamówienie z karty panelu (API): netto 100 przy 23% → 123,00', async () => {
    expect(await zKartyPanelu()).toBe('123.00');
  });
  it('ekran nadania: pozycja 8% za 108,00 ma netto 100,00 (nie 108,00 jak przy WDT)', async () => {
    expect(await nettoNaNadaniu()).toBe('100.00 zł');
  });
  it('karta: pas „to nie jest WDT”, bez „WDT ze stawką 0%”', async () => {
    const html = await karta(zapiszZamowienie(db, 'pro', zamowienie(), {}));
    expect(html).toContain('Sprzedawca zwolniony z VAT — to nie jest WDT');
    expect(html).toMatch(/art\. 28b/u);
    expect(html).not.toMatch(/WDT ze stawką 0%/u);
  });
  it('formularze „Dodaj pozycję” i „Nowe zamówienie” niosą data-zwolniona="1"', async () => {
    expect(atrybutZwolnionej(await kartaEdycji(zapiszZamowienie(db, 'pro', zamowienie(), {})), 'class="nowa-pozycja"')).toBe(true);
    expect(atrybutZwolnionej(await ekranNowego(), 'action="/zamowienia/nowe"')).toBe(true);
  });
});

describe.each([
  ['TwojeFaktury bez zwolnienia', programWbudowany, false],
  ['inFakt z zapisanym zwolnieniem', () => SUROWY_INFAKT, true],
])('PRZ-122.B07g kontrolnie (%s), nabywca z numerem UE — WDT jak dotąd', (_nazwa, program, zwolniona) => {
  beforeEach(async () => { await panel(program(), { zwolniona }); });

  it('ręczna pozycja z netto 100 → 100,00 (stawka 0)', async () => {
    expect(await pozycjaRecznaZNetto()).toBe('100.00');
  });
  it('„Zapisz pozycje” — brutto 123,00 zostaje 123,00', async () => {
    expect(await zapiszPozycjeHurtem()).toBe('123.00');
  });
  it('zamówienie z karty panelu (API): netto 100 → 100,00', async () => {
    expect(await zKartyPanelu()).toBe('100.00');
  });
  it('ekran nadania: pozycja za 108,00 ma netto 108,00 (0% — WDT)', async () => {
    expect(await nettoNaNadaniu()).toBe('108.00 zł');
  });
  it('karta: pas WDT ze stawką 0%, bez „to nie jest WDT”', async () => {
    const html = await karta(zapiszZamowienie(db, 'pro', zamowienie(), {}));
    expect(html).toMatch(/WDT ze stawką 0%/u);
    expect(html).not.toContain('to nie jest WDT');
  });
  it('formularze bez data-zwolniona', async () => {
    expect(atrybutZwolnionej(await kartaEdycji(zapiszZamowienie(db, 'pro', zamowienie(), {})), 'class="nowa-pozycja"')).toBe(false);
    expect(atrybutZwolnionej(await ekranNowego(), 'action="/zamowienia/nowe"')).toBe(false);
  });
});
