// PRZ-147.03 — przebieg zwrotu: po „Zarejestruj zwrot" i po „Wystaw korektę" panel prowadzi na ekran zwrotu
// (z zachowanym `powrot`), a karta zamówienia w sekcji „Faktura" ma przy zwrocie bez korekty ten sam przycisk
// (istniejąca trasa POST korekty) albo zdanie, dlaczego go nie ma. Reguły blokady — z domeny, jak na ekranie zwrotu.
//
// Pełna aplikacja (zbudujOms), atrapa `faktury.infakt` w nadpisaniach, zero sieci. Dane zmyślone.
import { describe, it, expect, vi } from 'vitest';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot, zarezerwujKorekte, zapiszKorekte, zapiszRecznyNumerKorekty } from '../../../src/oms/db/zwroty.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { odczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';

const env = { OMS_DB_PATH: ':memory:', OMS_SPRZEDAWCA_NIP: '1234563218',
  OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'test',
  OMS_PROFORMY_KATALOG: '.', OMS_ETYKIETY_KATALOG: '.' };
const headers = { authorization: 'Basic ' + Buffer.from('operator:test').toString('base64'),
  origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
const POWROT = '/?status=zwrot';
const POWROT_W_ADRESIE = 'powrot=%2F%3Fstatus%3Dzwrot';

const atrapaInfaktu = () => ({
  pobierzFakture: vi.fn().mockResolvedValue({ uuid: 'polcien-fv', number: 'FV 7/10/2026', invoice_date: '2026-10-01',
    services: [{ name: 'Lampa Półcień', quantity: 1, gross_price: 12900, tax_symbol: '23' }] }),
  wystawKorekte: vi.fn().mockResolvedValue({ referencja: 'REF-POLCIEN-1', uuid: null, numer: null }),
  listaKorekt: vi.fn().mockResolvedValue([]),
});

function zamowienie(db, { faktura = true, nr = 7001 } = {}) {
  const id = zapiszZamowienie(db, 'reczne', { zrodlo_id: nr, numer: String(nr), klient: null,
    dostawa: null, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: Number(faktura),
    nip: null, kwota_brutto: '258.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing',
    oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-01T12:00:00',
    pozycje: [{ zrodlo_id: 11, nazwa: 'Lampa Półcień', sku: 'LAMPA-P1', ilosc: 2,
      cena_brutto: '129.00', brutto_linii: '258.00', vat: null }] }, {});
  if (faktura) db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
    .run(id, 'polcien-fv', 'FV 7/10/2026', '2026-10-01T12:00:00Z');
  return id;
}
const zwrotNa = (db, id, data = '2026-10-14') => dodajZwrot(db, id, { data, kwota: '129.00',
  pozycje: [{ klucz_pozycji: 's11', nazwa: 'Lampa Półcień', ilosc: 1, kwota: '129.00' }] }).id;

async function zAplikacja(nadpisania, dzialanie) {
  const siec = vi.fn(() => { throw new Error('Sieć zabroniona w PRZ-147.03'); });
  vi.stubGlobal('fetch', siec);
  let a;
  try { a = await zbudujOms({ env, nadpisania }); await dzialanie(a); expect(siec).not.toHaveBeenCalled(); }
  finally { if (a) { await a.app.close(); a.db.close(); } vi.unstubAllGlobals(); }
}
const zInfaktem = (dzialanie) => zAplikacja({ 'faktury.infakt': atrapaInfaktu() }, dzialanie);
const karta = async (a, id, h = headers) => {
  const r = await a.app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: h });
  expect(r.statusCode).toBe(200);
  return r.body;
};
const formularzKorekty = (id, zwrotId) => `action="/zamowienia/${id}/zwroty/${zwrotId}/korekta"`;

describe('PRZ-147.03 przekierowania na ekran zwrotu', () => {
  it('rejestracja zwrotu prowadzi na ekran zwrotu z zachowanym powrotem; obcy adres powrotu odpada', async () => {
    await zAplikacja(undefined, async (a) => {
      // Każde wysłanie na osobne zamówienie — bariery zapisu zwrotu (kwota, ten sam zwrot) nie mają tu nic do rzeczy.
      const cialo = (powrot) => new URLSearchParams([
        ...(powrot ? [['powrot', powrot]] : []),
        ['data', '2026-10-14'], ['kwota', '129.00'], ['kwota_dostawy', ''],
        ['klucz', 's11'], ['ilosc', '1'], ['nazwa', 'Lampa Półcień'], ['pozycja_kwota', '129.00'],
      ]).toString();
      const wyslij = async (powrot, nr) => {
        const id = zamowienie(a.db, { faktura: false, nr });
        const r = await a.app.inject({ method: 'POST', url: `/zamowienia/${id}/zwrot`, headers, payload: cialo(powrot) });
        expect(r.statusCode, r.body).toBe(302);
        return { id, location: r.headers.location };
      };
      const z = await wyslij(POWROT, 7101);
      expect(z.location).toBe(`/zamowienia/${z.id}/zwrot?${POWROT_W_ADRESIE}`);
      const bez = await wyslij(null, 7102);
      expect(bez.location).toBe(`/zamowienia/${bez.id}/zwrot`);
      const obcy = await wyslij('https://obca.example.test/', 7103);
      expect(obcy.location).toBe(`/zamowienia/${obcy.id}/zwrot`);
    });
  });

  it('POST korekty prowadzi na ekran zwrotu, nie na kartę', async () => {
    await zInfaktem(async (a) => {
      const id = zamowienie(a.db);
      const zwrotId = zwrotNa(a.db, id);
      const r = await a.app.inject({ method: 'POST', url: `/zamowienia/${id}/zwroty/${zwrotId}/korekta`, headers,
        payload: new URLSearchParams({ powrot: POWROT }).toString() });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe(`/zamowienia/${id}/zwrot?${POWROT_W_ADRESIE}`);
    });
  });
});

describe('PRZ-147.03 karta zamówienia: „Wystaw korektę" w sekcji Faktura', () => {
  it('zwrot bez korekty przy fakturze — formularz na istniejącą trasę korekty, w sekcji Faktura', async () => {
    await zInfaktem(async (a) => {
      const id = zamowienie(a.db);
      const zwrotId = zwrotNa(a.db, id);
      const html = await karta(a, id);
      expect(html).toContain(formularzKorekty(id, zwrotId));
      const faktura = html.slice(html.indexOf('id="faktura"'));
      expect(faktura.indexOf(formularzKorekty(id, zwrotId))).toBeGreaterThan(0);
      expect(html).toMatch(new RegExp(`${formularzKorekty(id, zwrotId)}[^>]*>\\s*<input type="hidden" name="powrot" value="/">\\s*<button[^>]*>Wystaw korektę</button>`));
    });
  });

  it('zwrot ze zleceniem w toku — zdanie i odnośnik do ekranu zwrotu, bez formularza', async () => {
    await zInfaktem(async (a) => {
      const id = zamowienie(a.db);
      const zwrotId = zwrotNa(a.db, id);
      zarezerwujKorekte(a.db, id, zwrotId);
      zapiszKorekte(a.db, id, zwrotId, { referencja: 'REF-POLCIEN-2' });
      const html = await karta(a, id, headers);
      expect(html).not.toContain(formularzKorekty(id, zwrotId));
      expect(html).toContain('Korekta zlecona — stan na ekranie zwrotu');
      expect(html).toMatch(new RegExp(`href="/zamowienia/${id}/zwrot"[^>]*>[^<]*ekran zwrotu`, 'i'));
    });
  });

  it('zwrot z numerem korekty — bez formularza, wiersz korekty jak dziś', async () => {
    await zInfaktem(async (a) => {
      const id = zamowienie(a.db);
      const zwrotId = zwrotNa(a.db, id);
      zapiszRecznyNumerKorekty(a.db, id, zwrotId, 'KOR 3/10/2026');
      const html = await karta(a, id);
      expect(html).not.toContain(formularzKorekty(id, zwrotId));
      expect(html).toMatch(/<td>Korekta<\/td>\s*<td>KOR 3\/10\/2026<\/td>/);
      expect(html).not.toContain('Korekta zlecona — stan na ekranie zwrotu');
    });
  });

  it('zamówienie bez faktury — ani formularza, ani zdania', async () => {
    await zInfaktem(async (a) => {
      const id = zamowienie(a.db, { faktura: false });
      const zwrotId = zwrotNa(a.db, id);
      const html = await karta(a, id);
      expect(html).not.toContain(formularzKorekty(id, zwrotId));
      expect(html).not.toContain('Korekta zlecona — stan na ekranie zwrotu');
    });
  });

  it('faktura ma już korektę z innego zwrotu — zdanie blokady z domeny zamiast przycisku', async () => {
    await zInfaktem(async (a) => {
      const id = zamowienie(a.db);
      const pierwszy = zwrotNa(a.db, id, '2026-10-10');
      zapiszRecznyNumerKorekty(a.db, id, pierwszy, 'KOR 1/10/2026');
      const drugi = zwrotNa(a.db, id, '2026-10-12');
      const html = await karta(a, id);
      expect(html).not.toContain(formularzKorekty(id, drugi));
      expect(html).toContain('Faktura tego zamówienia ma już korektę KOR 1/10/2026 (zwrot z 2026-10-10)');
    });
  });

  it('konto bez prawa do adresu korekty — bez formularza', async () => {
    await zInfaktem(async (a) => {
      const id = zamowienie(a.db);
      const zwrotId = zwrotNa(a.db, id);
      zalozKonto(a.db, { login: 'magazyn', imie: 'Magazyn testowy', haslo: 'haslo-testowe', rola: 'produkcja', ekrany: ['zamowienia'] });
      const cookie = `${NAZWA_CIASTECZKA_OMS}=${podpisz('magazyn', odczytajSekret(a.db), Date.now(), 0)}`;
      const html = await karta(a, id, { authorization: '', cookie });
      expect(html).not.toContain(formularzKorekty(id, zwrotId));
      // Kontrola: operator z pełnym prawem ten formularz widzi — test nie przechodzi przez brak sekcji.
      expect(await karta(a, id)).toContain(formularzKorekty(id, zwrotId));
    });
  });
});

describe('PRZ-147.03 ekran zwrotu: „Odśwież stan" przy zleceniu w toku', () => {
  it('zlecona korekta bez numeru przed progiem — odnośnik na ten sam ekran z powrotem', async () => {
    await zInfaktem(async (a) => {
      const id = zamowienie(a.db);
      const zwrotId = zwrotNa(a.db, id);
      zarezerwujKorekte(a.db, id, zwrotId);
      zapiszKorekte(a.db, id, zwrotId, { referencja: 'REF-POLCIEN-3' });
      const r = await a.app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot?powrot=${encodeURIComponent(POWROT)}`, headers });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Korekta zlecona — numer pojawi się po przetworzeniu');
      expect(r.body).toContain(`href="/zamowienia/${id}/zwrot?${POWROT_W_ADRESIE}">Odśwież stan</a>`);
    });
  });

  it('bez zlecenia — odnośnika „Odśwież stan" nie ma', async () => {
    await zInfaktem(async (a) => {
      const id = zamowienie(a.db);
      zwrotNa(a.db, id);
      const r = await a.app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers });
      expect(r.body).not.toContain('Odśwież stan');
    });
  });
});
