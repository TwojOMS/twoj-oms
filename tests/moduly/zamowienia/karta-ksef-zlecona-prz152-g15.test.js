// PRZ-152.G15 — po zleceniu wysyłki do KSeF: bez przycisku i bez długiego komunikatu (właściciel 05.11.2026: „usunąć komunikat.”).
//
// ⚠️ Blokada duplikatu po stronie serwera ZOSTAJE (`coWolnoWyslac`, `powodJuzZlecona`). Znika tylko droga, którą człowiek
// trafiał na długie zdanie: przycisk „Wyślij do KSeF” po zleceniu, akapit pod tabelą dokumentów i ekran podglądu.
// Drugie zgłoszenie mimo to (stara karta, zaznaczenie na liście) wraca 303 z paskiem uwagi i krótkim zdaniem.
// Prawdziwe `createFakturyWidok` i `createWysylkaKsef` na fałszywym inFakcie liczącym wysyłki. ⛔ Żadnej sieci.
import { describe, it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { zajmijWysylkeKsef } from '../../../src/moduly/faktury/db/wysylki-ksef.js';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const NIP = '1234563218';
const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}`, origin: 'http://localhost' };
// Chwila zlecenia w BIEŻĄCYM roku (inny rok dokłada rok do daty — to sprawdza test domeny). Listopad = CET, 07:22Z → 08:22.
const ROK = new Date().getFullYear();
const ZLECONO = `${ROK}-11-05T07:22:00.000Z`;
const PLAKIETKA = 'Zlecono do KSeF 5.11 08:22';
const ODMOWA = 'Ten dokument już wysłano do KSeF 5.11 08:22 — sprawdź go w inFakcie.';
const DLUGI = 'Panel już zlecił';

const dok = (uuid, nadpisz = {}) => ({
  uuid, number: `${uuid}/10/2026`, rodzaj: 'vat', invoice_date: '2026-10-20', sale_date: '2026-10-20', ksef_number: null,
  client_company_name: 'Pracownia Przykładowa', client_tax_code: NIP, gross_price: 12300, left_to_pay: 0, ...nadpisz,
});

// Fałszywy inFakt: listy filtrowane po polu daty, wysyłka tylko liczy wywołania.
function falszywyInfakt(dokumenty) {
  const wyslane = [];
  const zakres = (rodzaj) => async ({ od, do: koniec, pole = 'invoice_date' }) => dokumenty
    .filter((d) => d.rodzaj === rodzaj && String(d[pole]) >= od && String(d[pole]) <= koniec).map((d) => ({ ...d }));
  return {
    wyslane,
    listaFaktur: zakres('vat'),
    listaKorekt: zakres('korekta'),
    wyslijDokumentDoKsef: async (uuid) => { wyslane.push(uuid); return { invoice_task_reference_number: `ref-${uuid}` }; },
  };
}

function zamowienieZFaktura(db, { uuid = 'u1', ksefNumer = null } = {}) {
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: `w-${uuid}`, numer: `Z-${uuid}`, klient: { first_name: 'Jan', last_name: 'Przykładowy', company: 'Pracownia Przykładowa' },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: NIP, kwota_brutto: '123.00',
    koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0, pozycje: [],
    utworzone_at: '2026-10-20T09:00:00',
  }, {});
  const f = rozpocznijFakture(db, id);
  zakonczFakture(db, f.id, { uuid, numer: `${uuid}/10/2026`, ksefStatus: null });
  db.prepare('UPDATE faktury SET utworzona_at = ?, ksef_numer = ? WHERE id = ?').run('2026-10-20T10:00:00.000Z', ksefNumer, f.id);
  return id;
}

const apki = [];
afterEach(async () => { for (const a of apki.splice(0)) await a.close(); });

function panel(dokumenty = [dok('u1')]) {
  const db = openOmsDb(':memory:');
  const infakt = falszywyInfakt(dokumenty);
  const fakturyWidok = createFakturyWidok({ db, infakt });
  const wysylkaKsef = createWysylkaKsef({ db, infakt, fakturyWidok, log: () => {} });
  const app = buildOmsServer({ db, config: { auth: { user: 't', pass: 'h' } }, fakturyWidok, wysylkaKsef });
  apki.push(app);
  return { db, app, infakt };
}

const get = (app, url) => app.inject({ method: 'GET', url, headers: AUTH });
const post = (app, url, payload) => app.inject({ method: 'POST', url, headers: AUTH, payload });
const LISTA = '/faktury?miesiac=2026-10&pole=invoice_date';
const PRZYCISK = /<form[^>]*action="\/faktury\/ksef\/podglad"[\s\S]*?Wyślij do KSeF<\/button>\s*<\/form>/;
// Wiersz listy FAKTURY z danym dokumentem (po odnośniku PDF).
const wiersz = (html, uuid) => [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => m[0]).find((t) => t.includes(`/faktury/${uuid}/pdf`));
// Pasek uwagi z tekstem odmowy (klasa jak inne paski uwagi na karcie i liście).
const pasekOdmowy = (html) => html.match(/<p class="pasek-uwaga"[^>]*id="ksef-odmowa"[^>]*>([\s\S]*?)<\/p>/)?.[1]?.trim();

describe('PRZ-152.G15 po zleceniu wysyłki — karta i lista', () => {
  it('karta: bez „Wyślij do KSeF” (tabela i menu „⋯”), plakietka „Zlecono do KSeF D.M GG:MM”, bez długiego zdania', async () => {
    const { db, app } = panel();
    const id = zamowienieZFaktura(db);
    zajmijWysylkeKsef(db, 'u1', { numer: 'u1/10/2026', kiedy: ZLECONO });
    const r = await get(app, `/zamowienia/${id}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(PRZYCISK);
    expect(r.body).not.toContain('Wyślij do KSeF');
    expect(r.body).toContain(PLAKIETKA);
    expect(r.body).not.toContain(DLUGI);
    expect(r.body).not.toContain('zlecona z panelu — czeka na numer KSeF');
  });

  it('lista: wiersz z plakietką „Zlecono do KSeF D.M GG:MM”, bez przycisku wysyłki w wierszu i bez długiego zdania', async () => {
    const { db, app } = panel([dok('u1'), dok('u2')]);
    zajmijWysylkeKsef(db, 'u1', { numer: 'u1/10/2026', kiedy: ZLECONO });
    const r = await get(app, LISTA);
    expect(r.statusCode).toBe(200);
    const w = wiersz(r.body, 'u1');
    expect(w).toContain(PLAKIETKA);
    expect(w).not.toContain('Wyślij do KSeF');
    expect(wiersz(r.body, 'u2')).not.toContain('Zlecono do KSeF');
    expect(r.body).not.toContain(DLUGI);
  });

  // PRZ-152.G15 (kierownik 05.11): plakietka znak w znak także NA EKRANIE — klasa `waga` ma
  // text-transform: uppercase (layout), więc daje „ZLECONO DO KSEF”. Karta i lista mają klasę
  // plakietki stanu z tabeli FAKTURY (`znacznik znacznik--cichy`), bez wersalików.
  it('plakietka „Zlecono do KSeF” w klasie `znacznik znacznik--cichy` (bez `waga` z wersalikami) — karta i lista', async () => {
    const klasaPlakietki = (html) => html.match(/<span class="([^"]*)"[^>]*>\s*Zlecono do KSeF 5\.11 08:22\s*<\/span>/)?.[1];
    const { db, app } = panel([dok('u1')]);
    const id = zamowienieZFaktura(db);
    zajmijWysylkeKsef(db, 'u1', { numer: 'u1/10/2026', kiedy: ZLECONO });
    const k = await get(app, `/zamowienia/${id}`);
    const l = await get(app, LISTA);
    for (const html of [k.body, wiersz(l.body, 'u1')]) {
      const klasa = klasaPlakietki(html);
      expect(klasa?.split(/\s+/)).toEqual(['znacznik', 'znacznik--cichy']);
      expect(klasa).not.toMatch(/\bwaga\b/);
    }
  });

  it('po numerze KSeF: plakietki jak dziś (karta: numer, lista: „KSeF”), bez „Zlecono”', async () => {
    const numer = '1234563218-20261020-ABCDEF-01';
    const { db, app } = panel([dok('u1', { ksef_number: numer })]);
    const id = zamowienieZFaktura(db, { ksefNumer: numer });
    zajmijWysylkeKsef(db, 'u1', { numer: 'u1/10/2026', kiedy: ZLECONO });
    const k = await get(app, `/zamowienia/${id}`);
    expect(k.body).toContain(numer);
    expect(k.body).not.toMatch(PRZYCISK);
    expect(k.body).not.toContain('Zlecono do KSeF');
    const l = await get(app, LISTA);
    expect(wiersz(l.body, 'u1')).toContain('<span class="znacznik znacznik--ok">KSeF</span>');
    expect(wiersz(l.body, 'u1')).not.toContain('Zlecono do KSeF');
  });

  it('dokument bez zlecenia: przycisk na karcie jak dziś, na liście „brak”', async () => {
    const { db, app } = panel();
    const id = zamowienieZFaktura(db);
    const k = await get(app, `/zamowienia/${id}`);
    expect(k.body).toMatch(PRZYCISK);
    expect(k.body).not.toContain('Zlecono do KSeF');
    expect(pasekOdmowy(k.body)).toBeUndefined();
    const l = await get(app, LISTA);
    expect(wiersz(l.body, 'u1')).toContain('<span class="znacznik znacznik--cichy">brak</span>');
    expect(wiersz(l.body, 'u1')).not.toContain('Zlecono do KSeF');
  });
});

describe('PRZ-152.G15 drugie zgłoszenie — 303 z paskiem, bez wywołania klienta', () => {
  it('z karty (podgląd i zatwierdzenie): 303 na kartę, pasek znak w znak, 0 wysyłek', async () => {
    const { db, app, infakt } = panel();
    const id = zamowienieZFaktura(db);
    zajmijWysylkeKsef(db, 'u1', { numer: 'u1/10/2026', kiedy: ZLECONO });
    const payload = { uuid: 'u1', miesiac: '2026-10', pole: 'invoice_date', powrot: `/zamowienia/${id}` };
    for (const [url, dodatek] of [['/faktury/ksef/podglad', {}], ['/faktury/ksef/wyslij', { potwierdzam: 'wyslij' }]]) {
      const r = await post(app, url, { ...payload, ...dodatek });
      expect(r.statusCode, url).toBe(303);
      expect(r.headers.location, url).toBe(`/zamowienia/${id}?juz_w_ksef=u1#faktura`);
      expect(r.body).not.toContain(DLUGI);
    }
    expect(infakt.wyslane).toEqual([]);
    const k = await get(app, `/zamowienia/${id}?juz_w_ksef=u1`);
    expect(k.statusCode).toBe(200);
    expect(pasekOdmowy(k.body)).toBe(ODMOWA);
    expect(k.body).not.toContain(DLUGI);
  });

  it('z listy: 303 na tę samą listę, pasek znak w znak, 0 wysyłek', async () => {
    const { db, app, infakt } = panel();
    zajmijWysylkeKsef(db, 'u1', { numer: 'u1/10/2026', kiedy: ZLECONO });
    const payload = { uuid: 'u1', miesiac: '2026-10', pole: 'invoice_date' };
    for (const [url, dodatek] of [['/faktury/ksef/podglad', {}], ['/faktury/ksef/wyslij', { potwierdzam: 'wyslij' }]]) {
      const r = await post(app, url, { ...payload, ...dodatek });
      expect(r.statusCode, url).toBe(303);
      expect(r.headers.location, url).toBe(`${LISTA}&juz_w_ksef=u1`);
    }
    expect(infakt.wyslane).toEqual([]);
    const l = await get(app, `${LISTA}&juz_w_ksef=u1`);
    expect(l.statusCode).toBe(200);
    expect(pasekOdmowy(l.body)).toBe(ODMOWA);
    expect(l.body).not.toContain(DLUGI);
  });

  it('pełna droga: pierwsza wysyłka idzie, druga z tej samej (starej) karty nie woła klienta', async () => {
    const { db, app, infakt } = panel();
    const id = zamowienieZFaktura(db);
    const payload = { uuid: 'u1', miesiac: '2026-10', pole: 'invoice_date', powrot: `/zamowienia/${id}`, potwierdzam: 'wyslij' };
    const pierwsza = await post(app, '/faktury/ksef/wyslij', payload);
    expect(pierwsza.statusCode).toBe(200);
    expect(infakt.wyslane).toEqual(['u1']);
    const druga = await post(app, '/faktury/ksef/wyslij', payload);
    expect(druga.statusCode).toBe(303);
    expect(infakt.wyslane).toEqual(['u1']);
    const k = await get(app, `/zamowienia/${id}?juz_w_ksef=u1`);
    expect(pasekOdmowy(k.body)).toMatch(/^Ten dokument już wysłano do KSeF \d{1,2}\.\d{1,2} \d\d:\d\d — sprawdź go w inFakcie\.$/);
    expect(k.body).toMatch(/Zlecono do KSeF \d{1,2}\.\d{1,2} \d\d:\d\d/);
  });

  it('zaznaczenie z innym dokumentem: podgląd zostaje, przy zleconym krótkie zdanie zamiast długiego', async () => {
    const { db, app, infakt } = panel([dok('u1'), dok('u2')]);
    zajmijWysylkeKsef(db, 'u1', { numer: 'u1/10/2026', kiedy: ZLECONO });
    const r = await post(app, '/faktury/ksef/podglad', { uuid: ['u1', 'u2'], miesiac: '2026-10', pole: 'invoice_date' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('u2/10/2026');
    expect(r.body).toContain(ODMOWA);
    expect(r.body).not.toContain(DLUGI);
    expect(infakt.wyslane).toEqual([]);
  });

  it('obcy uuid w adresie karty: bez paska (pasek tylko przy dokumencie, który ma zlecenie)', async () => {
    const { db, app } = panel();
    const id = zamowienieZFaktura(db);
    const k = await get(app, `/zamowienia/${id}?juz_w_ksef=nie-ma-takiego`);
    expect(k.statusCode).toBe(200);
    expect(pasekOdmowy(k.body)).toBeUndefined();
  });
});
