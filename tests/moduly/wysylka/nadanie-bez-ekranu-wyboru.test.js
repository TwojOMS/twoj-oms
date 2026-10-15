import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { createDpdClient } from '../../../src/oms/kurierzy/dpd.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// EKRAN WYBORU KURIERA ZNIKA Z DROGI (decyzja właściciela 19.09.2026: „lepiej bez ekranu wyboru —
// niech idzie od razu odpowiednia opcja").
//
// Kontekst: do 18.09 każde zamówienie z Allegro trafiało najpierw na osobny ekran „Czym nadać
// paczkę?", bo panel nie znał kuriera. Odkąd osiem usług punktowych i kurierskich ma drogę
// domyślną przez „Wysyłam z Allegro" (niezmiennik 4.105), ten ekran pytał o coś, co jest już
// rozstrzygnięte — i przy okazji ODRADZAŁ właściwą drogę tekstem, który przestał być prawdziwy.
//
// ⚠️⚠️ FURTKA NA DOSYŁKĘ MUSI ZOSTAĆ. Ekran wyboru był JEDYNYM miejscem, z którego dawało się
// wskazać naszą umowę (dosyłka brakującego produktu, zamiennik za zgubioną paczkę). Usunięcie
// go z drogi bez zostawienia wejścia zabrałoby tę możliwość całkowicie — a to ta sama rodzina
// błędu, co „droga domyślna musi być na liście wyboru" z 11.08.2026.

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const NADAWCA = {
  nazwa: 'Lumina', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL',
};

const zmapowane = (nad = {}) => ({
  zrodlo_id: '91671e40-9025-11f1-9622-afa983ea653b',
  numer: '91671e40-9025-11f1-9622-afa983ea653b',
  klient: { email: 'a@allegromail.pl', phone: '+48500900009' },
  dostawa: {
    first_name: 'Julia', last_name: 'Lis', company: '', address_1: 'Radosna 7', postcode: '78-100', city: 'Niekanin', country: 'PL',
  },
  metoda_wysylki: 'allegro_punkt',
  kwota_pobrania: null,
  chce_fakture: 0,
  nip: null,
  kwota_brutto: '99.00',
  status_woo: 'processing',
  oplacone_at: '2026-08-04T18:58:24',
  anulowane: 0,
  utworzone_at: '2026-08-04T18:58:08',
  pozycje: [],
  ...nad,
});

function dpdKlient() {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(odp(200, fixture('v10-ok.xml')))
    .mockResolvedValueOnce(odp(200, fixture('v4-ok.xml')));
  return createDpdClient({
    url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216', nadawca: NADAWCA, fetchImpl,
  });
}

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

function zServerem({ nad = {}, sklep = 'allegro_szkicownia' } = {}) {
  const katalogEtykiet = mkdtempSync(join(tmpdir(), 'oms-bezwyboru-'));
  const nadanie = createNadanie({ db, kurierzy: { dpd: dpdKlient() }, katalogEtykiet });
  const kurierzy = { allegro_wza: { pobierzMetodeDostawy: async () => '0d83955a-4297-4169-adef-9790d53b11ff' } };
  const serwer = buildOmsServer({ db, config, poller, nadanie, kurierzy });
  const id = zapiszZamowienie(db, sklep, zmapowane(nad), {});
  return { serwer, id };
}

const get = async (serwer, url) => {
  await serwer.ready();
  return serwer.inject({ method: 'GET', url, headers: naglowek });
};

describe('metoda z drogą domyślną idzie prosto na formularz', () => {
  for (const metoda of ['allegro_dpd', 'allegro_punkt', 'allegro_kurier', 'allegro_inne']) {
    it(`${metoda}: żadnego ekranu „Czym nadać paczkę?"`, async () => {
      const { serwer, id } = zServerem({ nad: { metoda_wysylki: metoda } });
      const r = await get(serwer, `/zamowienia/${id}/nadaj`);
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain('Czym nadać paczkę');
    });

    it(`${metoda}: od razu formularz nadania`, async () => {
      const { serwer, id } = zServerem({ nad: { metoda_wysylki: metoda } });
      const r = await get(serwer, `/zamowienia/${id}/nadaj`);
      expect(r.body).toContain('name="waga"');
    });
  }
});

describe('furtka na dosyłkę naszą umową zostaje', () => {
  it('ekran nadania prowadzi do wyboru kuriera', async () => {
    const { serwer, id } = zServerem();
    const r = await get(serwer, `/zamowienia/${id}/nadaj`);
    expect(r.body).toContain(`/zamowienia/${id}/nadaj?wybor=1`);
  });

  it('jawna prośba o wybór pokazuje ekran z pełną listą', async () => {
    const { serwer, id } = zServerem();
    const r = await get(serwer, `/zamowienia/${id}/nadaj?wybor=1`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Czym nadać paczkę');
    expect(r.body).toContain(`/zamowienia/${id}/nadaj?kurier=dpd`);
    expect(r.body).toContain(`/zamowienia/${id}/nadaj?kurier=inpost_paczkomat`);
  });

  it('wskazanie naszej umowy dalej prowadzi na formularz w jej wariancie', async () => {
    const { serwer, id } = zServerem();
    const r = await get(serwer, `/zamowienia/${id}/nadaj?kurier=dpd`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="waga"');
    expect(r.body).toContain('name="kurier"');
  });
});

describe('ekran wyboru mówi prawdę o tym, czyją umową jedzie paczka', () => {
  // ⚠️ To jest PIERWOTNE zgłoszenie właściciela (19.09): przeczytał na tym ekranie, że panel
  // kupuje etykietę „tylko wtedy, gdy świadomie każesz mu użyć naszej umowy" — czyli tekst
  // ODRADZAŁ właściwą drogę, mimo że przycisk „Wysyłam z Allegro" stał tuż pod nim.
  // Żaden test nie pilnował treści tego akapitu, więc zdanie przeżyło zmianę z 18.09.
  it('przy usłudze kupowanej u Allegro nie odradza już właściwej drogi', async () => {
    const { serwer, id } = zServerem();
    const r = await get(serwer, `/zamowienia/${id}/nadaj?wybor=1`);
    expect(r.body).toMatch(/Przewóz kupujemy/i);
    expect(r.body).not.toMatch(/panel robi to tylko wtedy/i);
  });

  it('przy usłudze nieznanej mówi wprost, że panel nie umie jej kupić', async () => {
    const { serwer, id } = zServerem({ nad: { metoda_wysylki: 'allegro_metoda_z_przyszlosci' } });
    const r = await get(serwer, `/zamowienia/${id}/nadaj`);
    expect(r.body).toMatch(/nie umie kupić u Allegro/i);
  });

  it('nagłówek listy nie podpisuje WzA jako naszej umowy', async () => {
    const { serwer, id } = zServerem();
    const r = await get(serwer, `/zamowienia/${id}/nadaj?wybor=1`);
    expect(r.body).toContain('<h2>Czym nadać</h2>');
    expect(r.body).not.toContain('<h2>Nasza umowa</h2>');
  });
});

describe('metoda BEZ drogi domyślnej dalej pyta', () => {
  // ⚠️ Jedyny przypadek, w którym ekran wyboru nadal staje sam z siebie: usługa, której
  // słownik nie zna. Panel nie ma wtedy czego zaproponować i pytanie jest uczciwe.
  it('nieznana metoda allegrowa: ekran wyboru, bez formularza', async () => {
    const { serwer, id } = zServerem({ nad: { metoda_wysylki: 'allegro_metoda_z_przyszlosci' } });
    const r = await get(serwer, `/zamowienia/${id}/nadaj`);
    expect(r.body).toContain('Czym nadać paczkę');
    expect(r.body).not.toContain('name="waga"');
  });
});

describe('zamówienia spoza Allegro zachowują się dokładnie jak dotąd', () => {
  it('sklepowe DPD: formularz od razu, bez wyboru i bez furtki', async () => {
    const { serwer, id } = zServerem({ nad: { metoda_wysylki: 'dpd' }, sklep: 'pro' });
    const r = await get(serwer, `/zamowienia/${id}/nadaj`);
    expect(r.body).toContain('name="waga"');
    expect(r.body).not.toContain('Czym nadać paczkę');
    expect(r.body).not.toContain('nadaj?wybor=1');
  });

  it('sklepowe: parametr wybor=1 niczego nie otwiera', async () => {
    const { serwer, id } = zServerem({ nad: { metoda_wysylki: 'dpd' }, sklep: 'pro' });
    const r = await get(serwer, `/zamowienia/${id}/nadaj?wybor=1`);
    expect(r.body).not.toContain('Czym nadać paczkę');
    expect(r.body).toContain('name="waga"');
  });
});
