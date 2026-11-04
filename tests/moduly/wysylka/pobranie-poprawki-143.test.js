// PRZ-143.05 (plan PRZ-137, Etap 3, E3-D4 i E3-D5): ekran nadania i bariera przy przedpłacie
// bez kwoty pobrania; pasek-blokada przedpłaty tylko na paczce nr 1. Dane zmyślone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, zapiszNadpisanieWysylki } from '../../../src/oms/db/zamowienia.js';
import { dodajWplateReczna } from '../../../src/oms/db/platnosci.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { createDpdClient } from '../../../src/oms/kurierzy/dpd.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const naglowki = { authorization: 'Basic ' + Buffer.from('operator:atrapa').toString('base64'), origin: 'http://localhost' };
const ADRES = { nazwa: 'Ala Przykładowa', ulica: 'Przykładowa 12', kod: '00-001', miasto: 'Warszawa', kraj: 'PL', phone: '+48500100200', email: 'ala@example.test' };
const NADAWCA = { ...ADRES, nazwa: 'Pracownia Półcień' };
const FORMULARZ_DPD = { ...ADRES, waga: '1', dlugosc: '30', szerokosc: '20', wysokosc: '10', kolejnosc: '1' };

let db, serwer, katalog;
beforeEach(() => { db = openOmsDb(':memory:'); });
afterEach(async () => {
  if (serwer) await serwer.close();
  serwer = undefined;
  db.close();
  if (katalog) rmSync(katalog, { recursive: true, force: true });
  katalog = undefined;
});

function atrapaDpd() {
  return vi.fn()
    .mockResolvedValueOnce(odp(200, fixture('v10-ok.xml')))
    .mockResolvedValueOnce(odp(200, fixture('v4-ok.xml')))
    .mockResolvedValueOnce(odp(200, fixture('v4-ok-zpl.xml')));
}

// kanał 'polcien' = sklep WooCommerce „Pracowni Półcień".
function przygotuj({ kwotaPobrania, kwotaBrutto = '212.90', wplata = null }) {
  const fetchDpd = atrapaDpd();
  const dpd = createDpdClient({ url: 'https://dpd.example.test/api', login: '99999999', haslo: 'x', fid: '100143', nadawca: NADAWCA, fetchImpl: fetchDpd });
  katalog = mkdtempSync(join(tmpdir(), 'pobranie-poprawki-143-'));
  const nadanie = createNadanie({ db, kurierzy: { dpd }, katalogEtykiet: katalog });
  const config = { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [{ klucz: 'polcien', typ: 'woo', prefiks: 'PC', etykieta: 'Pracownia Półcień', raport: 'PC' }],
    kanaly: { polcien: {} }, sklepy: {} };
  serwer = buildOmsServer({ db, config, nadanie, poller: { stan: () => ({}) } });
  const id = zapiszZamowienie(db, 'polcien', {
    zrodlo_id: 'pc-143', numer: 'PC-143', klient: { email: ADRES.email, phone: ADRES.phone },
    dostawa: { first_name: 'Ala', last_name: 'Przykładowa', address_1: ADRES.ulica, postcode: ADRES.kod, city: ADRES.miasto, country: 'PL' },
    metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: kwotaPobrania, kwota_brutto: kwotaBrutto, chce_fakture: 0, nip: null,
    punkt_odbioru: null, status_woo: 'processing', oplacone_at: null, anulowane: 0,
    pozycje: [], utworzone_at: '2026-11-04T12:00:00',
  }, {});
  if (wplata) dodajWplateReczna(db, id, { kwota: wplata, data: '2026-11-04', metoda: 'Przelew' });
  const post = (payload) => serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowki, payload });
  const get = () => serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowki });
  const przesylki = () => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').all(id);
  // Żywa paczka nr 1 (nadana, z numerem listu) — następny ekran nadania to dosyłka nr 2.
  const nadanaPaczka1 = () => {
    const p = rozpocznijPrzesylke(db, id, 'dpd', 1);
    zakonczPrzesylke(db, p.id, { numerListu: 'PC143N1', etykietaSciezka: join(katalog, 'e.pdf'), surowa: '<x/>' });
  };
  return { id, post, get, fetchDpd, przesylki, nadanie, nadanaPaczka1 };
}

const pasekBlokadyWplat = /<p class="pasek-blokada">\s*Zamówienie ma wpłaty/;

describe('PRZ-144.01 — bariera niedopłaty bezpośrednio w usłudze', () => {
  it.each(['0', 0, '-5', 'abc'])('odmawia kwoty na paczce %s przed zapisem i kurierem', async (kwotaPobrania) => {
    const t = przygotuj({ kwotaPobrania: null, wplata: '50.00' });
    await expect(t.nadanie.nadaj(t.id, undefined, { kwotaPobrania })).rejects.toMatchObject({
      dlaOperatora: true,
      message: 'Zamówienie ma wpłaty 50.00 zł — pobierz najwyżej 162.90 zł albo wyłącz pobranie. Panel niczego nie nadał.',
    });
    expect(t.przesylki()).toHaveLength(0);
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });

  // PRZ-145.01 (E5-D4): dawniej „wysyła zaakceptowane 100.00” — to była dziura (e): kwota poniżej
  // niedopłaty jechała bez pytania. Teraz bez potwierdzenia z ekranu jest odmowa.
  it('100.00 poniżej niedopłaty 162.90 bez potwierdzenia → odmowa, zero przesyłek', async () => {
    const t = przygotuj({ kwotaPobrania: null, wplata: '50.00' });
    await expect(t.nadanie.nadaj(t.id, undefined, { kwotaPobrania: '100.00' })).rejects.toMatchObject({
      dlaOperatora: true,
      message: 'Kwota pobrania 100.00 zł różni się od niedopłaty 162.90 zł (kwota zamówienia 212.90 zł minus wpłaty 50.00 zł) — pobierz 162.90 zł albo potwierdź inną kwotę na ekranie nadania. Panel niczego nie nadał.',
    });
    expect(t.przesylki()).toHaveLength(0);
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });

  it.each(['0', 0, '-5'])('zachowuje nadanie bez cod przy limicie 0 i kwocie %s', async (kwotaPobrania) => {
    const t = przygotuj({ kwotaPobrania: null, wplata: '212.90' });
    await t.nadanie.nadaj(t.id, undefined, { kwotaPobrania });
    expect(t.przesylki()).toHaveLength(1);
    expect(t.fetchDpd.mock.calls[0][1].body).not.toContain('<cod>');
  });

  it('przy limicie 0 nieczytelna kwota na paczce zostaje dawnym wyjątkiem', async () => {
    const t = przygotuj({ kwotaPobrania: null, wplata: '212.90' });
    await expect(t.nadanie.nadaj(t.id, undefined, { kwotaPobrania: 'abc' })).rejects.toThrow(/abc/);
    expect(t.przesylki()).toHaveLength(0);
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });

  it.each(['0', '0.00', '-5'])('odmawia, gdy kwota pobrania %s stoi na zamówieniu, a wpłata nie pokrywa kwoty', async (k) => {
    const t = przygotuj({ kwotaPobrania: k, wplata: '50.00' });
    // PRZ-145.01: niedopłata liczona z kwoty zamówienia, więc tekst to zwykłe „pobierz najwyżej N”.
    await expect(t.nadanie.nadaj(t.id)).rejects.toMatchObject({ dlaOperatora: true, message: 'Zamówienie ma wpłaty 50.00 zł — pobierz najwyżej 162.90 zł albo wyłącz pobranie. Panel niczego nie nadał.' });
    expect(t.przesylki()).toHaveLength(0);
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });

  it('kwota pobrania 0 na zamówieniu opłaconym w całości — nadanie bez cod jak dotąd', async () => {
    const t = przygotuj({ kwotaPobrania: '0', wplata: '212.90' });
    await t.nadanie.nadaj(t.id);
    expect(t.przesylki()).toHaveLength(1);
    expect(t.fetchDpd.mock.calls[0][1].body).not.toContain('<cod>');
  });
});

describe('PRZ-143.05 — przedpłata przy braku kwoty pobrania (E3-D4)', () => {
  // PRZ-145.02 (E5, właściciel 04.11 „e”): pole podpowiada niedopłatę, pasek ją wylicza.
  it('(1) GET: K = null, wpłata 100.00, kwota zamówienia 212.90 → 200, pole z niedopłatą 112.90, pasek niedopłaty', async () => {
    const t = przygotuj({ kwotaPobrania: null, wplata: '100.00' });
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/name="kwota_pobrania" value="112.90"/);
    expect(r.body).toContain('Zamówienie ma wpłaty 100.00 zł — niedopłata 112.90 zł (kwota zamówienia 212.90 zł minus wpłaty). Pobierz 112.90 zł.');
    expect(r.body).not.toContain('Faktury nie da się');
  });
  it('(2a) POST 112.90 przy K = null → koperta DPD z <cod> 112.90', async () => {
    const t = przygotuj({ kwotaPobrania: null, wplata: '100.00' });
    const r = await t.post({ ...FORMULARZ_DPD, kwota_pobrania: '112.90' });
    expect(r.statusCode).toBe(302);
    expect(t.fetchDpd.mock.calls[0][1].body).toContain('<cod><amount>112.90</amount><currency>PLN</currency></cod>');
  });
  it('spoza HTTP „162,90” przy wpłacie 50 → do DPD idzie znormalizowane <cod> 162.90', async () => {
    const t = przygotuj({ kwotaPobrania: null, wplata: '50.00' });
    await t.nadanie.nadaj(t.id, undefined, { kwotaPobrania: '162,90' });
    expect(t.fetchDpd.mock.calls[0][1].body).toContain('<cod><amount>162.90</amount><currency>PLN</currency></cod>');
  });
  it('(2b) POST 150.00 przy K = null → odmowa „pobierz najwyżej 112.90", zero przesyłek, bez kuriera', async () => {
    const t = przygotuj({ kwotaPobrania: null, wplata: '100.00' });
    const r = await t.post({ ...FORMULARZ_DPD, kwota_pobrania: '150.00' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Zamówienie ma wpłaty 100.00 zł — pobierz najwyżej 112.90 zł albo wyłącz pobranie. Panel niczego nie nadał.');
    expect(r.body).not.toContain('Faktury nie da się');
    expect(t.fetchDpd).not.toHaveBeenCalled();
    expect(t.przesylki()).toHaveLength(0);
  });
  it('(2b) POST 112.91 — grosz ponad limit — też odmowa', async () => {
    const t = przygotuj({ kwotaPobrania: null, wplata: '100.00' });
    const r = await t.post({ ...FORMULARZ_DPD, kwota_pobrania: '112.91' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('pobierz najwyżej 112.90 zł');
    expect(t.przesylki()).toHaveLength(0);
  });
  it('(2c) brak kwoty pobrania i kwoty zamówienia → odmowa, zero przesyłek; GET bez „najwyżej"', async () => {
    const t = przygotuj({ kwotaPobrania: null, kwotaBrutto: '', wplata: '100.00' });
    const g = await t.get();
    expect(g.statusCode).toBe(200);
    expect(g.body).toContain('Brak kwoty pobrania na zamówieniu. Zamówienie ma wpłaty 100.00 zł — wpisz kwotę do zainkasowania.');
    expect(g.body).not.toContain('najwyżej');
    const r = await t.post({ ...FORMULARZ_DPD, kwota_pobrania: '50.00' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Brak kwoty pobrania i kwoty zamówienia — uzupełnij kwotę pobrania na karcie zamówienia. Panel niczego nie nadał.');
    expect(r.body).not.toContain('Faktury nie da się');
    expect(t.fetchDpd).not.toHaveBeenCalled();
    expect(t.przesylki()).toHaveLength(0);
  });
  it('(2d) wywołanie usługi spoza HTTP bez kwoty na paczce przy K = null → odmowa operatora, nie wyjątek o fakturze', async () => {
    const t = przygotuj({ kwotaPobrania: null, wplata: '100.00' });
    const blad = await t.nadanie.nadaj(t.id, undefined, {}).catch((e) => e);
    expect(blad).toBeInstanceOf(Error);
    expect(blad.message).toContain('Panel niczego nie nadał.');
    expect(blad.message).toContain('najwyżej 112.90 zł');
    expect(blad.message).not.toContain('Faktury nie da się');
    expect(t.fetchDpd).not.toHaveBeenCalled();
    expect(t.przesylki()).toHaveLength(0);
  });
});

describe('PRZ-143.05 — pasek przedpłaty tylko na paczce nr 1 (E3-D5)', () => {
  // PRZ-145.02 (E5): przy niedopłacie > 0 pasek-blokada ustępuje paskowi niedopłaty
  // z różnicą do potwierdzenia na ekranie (właściciel 04.11 „e”).
  it('(3) GET paczki nr 1 z wpłatą → pasek niedopłaty z różnicą, bez paska-blokady', async () => {
    const t = przygotuj({ kwotaPobrania: '212.90', wplata: '100.00' });
    const r = await t.get();
    expect(r.body).not.toMatch(pasekBlokadyWplat);
    expect(r.body).toContain('niedopłata 112.90 zł (kwota zamówienia 212.90 zł minus wpłaty). Pobierz 112.90 zł. Kwota pobrania na zamówieniu (212.90 zł) różni się od niedopłaty.');
    expect(r.body).toContain('name="potwierdz_niedoplate" value="112.90"');
    expect(r.body).not.toContain('Jeśli zaznaczysz pobranie na tej paczce: zamówienie ma wpłaty');
  });
  it('(3) GET dosyłki (żywa paczka nr 1) z wpłatą → bez paska-blokady, z podpowiedzią przy polu', async () => {
    const t = przygotuj({ kwotaPobrania: '212.90', wplata: '100.00' });
    t.nadanaPaczka1();
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="pobranie_na_tej_paczce"');
    expect(r.body).not.toMatch(pasekBlokadyWplat);
    expect(r.body).toContain('Jeśli zaznaczysz pobranie na tej paczce: zamówienie ma wpłaty 100.00 zł — niedopłata 112.90 zł (kwota zamówienia 212.90 zł minus wpłaty). Pobierz 112.90 zł.');
  });
  it('(3) GET dosyłki bez wpłat → ani paska, ani podpowiedzi o wpłatach', async () => {
    const t = przygotuj({ kwotaPobrania: '212.90' });
    t.nadanaPaczka1();
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('ma wpłaty');
  });
  it('(4) dosyłka po ręcznej korekcie kwoty na karcie → pasek-uwaga pokazuje kwotę efektywną', async () => {
    const t = przygotuj({ kwotaPobrania: '212.90' });
    zapiszNadpisanieWysylki(db, t.id, { metoda: 'dpd', pobranie: 1, kwota_pobrania: '150.00' });
    t.nadanaPaczka1();
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/Kwota 150\.00 zł należy\s+do zamówienia/);
    expect(r.body).not.toContain('Kwota 212.90 zł należy');
  });
});

// PRZ-145.01 (plan PRZ-137, Etap 5, E5-D3 i E5-D4): usługa spoza ekranu (bez HTTP).
const logPobrania = (id) => db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'nadanie.pobranie'").all(id).map((w) => w.wynik);

describe('PRZ-145.01 (3) (a) bez wpłat — kwota pobrania na zamówieniu przechodzi ten sam odczyt', () => {
  it.each(['0', '0.00', 0, null])('K %j na zamówieniu → odmowa „Brak kwoty pobrania”, zero przesyłek i kuriera', async (k) => {
    const t = przygotuj({ kwotaPobrania: k });
    await expect(t.nadanie.nadaj(t.id)).rejects.toMatchObject({
      dlaOperatora: true,
      message: 'Brak kwoty pobrania (0.00 zł) — zamówienie jest za pobraniem, a kurier niczego by nie zainkasował. Uzupełnij kwotę pobrania na karcie zamówienia albo wyłącz pobranie. Panel niczego nie nadał.',
    });
    expect(t.przesylki()).toHaveLength(0);
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });

  it.each(['1e2', '0.005'])('K %s na zamówieniu → odmowa przed kurierem', async (k) => {
    const t = przygotuj({ kwotaPobrania: k });
    await expect(t.nadanie.nadaj(t.id)).rejects.toMatchObject({ dlaOperatora: true, message: expect.stringContaining('Panel niczego nie nadał.') });
    expect(t.przesylki()).toHaveLength(0);
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });

  it.each([['212.90', '212.90'], ['212.900', '212.900'], ['212,90', '212.90']])('K %s → <cod> %s jak dotąd', async (k, wDpd) => {
    const t = przygotuj({ kwotaPobrania: k });
    await t.nadanie.nadaj(t.id);
    expect(t.przesylki()).toHaveLength(1);
    expect(t.fetchDpd.mock.calls[0][1].body).toContain(`<cod><amount>${wDpd}</amount><currency>PLN</currency></cod>`);
  });

  it('jawne „0.005” spoza HTTP → odmowa tekstem parsera', async () => {
    const t = przygotuj({ kwotaPobrania: '212.90' });
    await expect(t.nadanie.nadaj(t.id, undefined, { kwotaPobrania: '0.005' })).rejects.toMatchObject({
      dlaOperatora: true, message: expect.stringMatching(/^Nie umiem odczytać kwoty pobrania: „0\.005".*Panel niczego nie nadał\.$/),
    });
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });
});

describe('PRZ-145.01 (4) (b) i (5) (d) — nieczytelne kwoty dają zdanie, nie wyjątek grosze()', () => {
  it.each([[null, '212.90'], ['50.00', '']])('wpłata %s, brutto %j, K „abc” → tekst (b)', async (wplata, kwotaBrutto) => {
    const t = przygotuj({ kwotaPobrania: 'abc', kwotaBrutto, wplata });
    const blad = await t.nadanie.nadaj(t.id).catch((e) => e);
    expect(blad.dlaOperatora).toBe(true);
    expect(blad.message).toBe('Kwota pobrania na zamówieniu jest nieczytelna („abc”) — popraw ją w „Szczegółach zamówienia” na karcie. Panel niczego nie nadał.');
    expect(t.fetchDpd).not.toHaveBeenCalled();
    expect(t.przesylki()).toHaveLength(0);
  });

  it('wpłata 50.00, brutto „abc”, K 150.00 → „Kwota zamówienia jest nieczytelna”', async () => {
    const t = przygotuj({ kwotaPobrania: '150.00', kwotaBrutto: 'abc', wplata: '50.00' });
    const blad = await t.nadanie.nadaj(t.id).catch((e) => e);
    expect(blad.dlaOperatora).toBe(true);
    expect(blad.message).toBe('Kwota zamówienia jest nieczytelna („abc”) — panel nie policzy niedopłaty. Sprawdź zamówienie w sklepie albo popraw je na karcie. Panel niczego nie nadał.');
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });
});

describe('PRZ-145.01 (6) (e) niedopłata = kwota zamówienia 212.90 minus wpłata 50.00', () => {
  const rozni = 'Kwota pobrania 50.00 zł różni się od niedopłaty 162.90 zł (kwota zamówienia 212.90 zł minus wpłaty 50.00 zł) — pobierz 162.90 zł albo potwierdź inną kwotę na ekranie nadania. Panel niczego nie nadał.';

  it('K 50.00 na zamówieniu, bez kwoty na paczce → odmowa „różni się od niedopłaty 162.90 zł”', async () => {
    const t = przygotuj({ kwotaPobrania: '50.00', wplata: '50.00' });
    await expect(t.nadanie.nadaj(t.id)).rejects.toMatchObject({ dlaOperatora: true, message: rozni });
    expect(t.przesylki()).toHaveLength(0);
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });

  it('kwota na paczce 162.90 = niedopłata → <cod> 162.90 bez pytania', async () => {
    const t = przygotuj({ kwotaPobrania: '50.00', wplata: '50.00' });
    await t.nadanie.nadaj(t.id, undefined, { kwotaPobrania: '162.90' });
    expect(t.fetchDpd.mock.calls[0][1].body).toContain('<cod><amount>162.90</amount><currency>PLN</currency></cod>');
  });

  it('100.00 z potwierdzoną niedopłatą 162.90 → <cod> 100.00, potwierdzenie w logu', async () => {
    const t = przygotuj({ kwotaPobrania: '50.00', wplata: '50.00' });
    await t.nadanie.nadaj(t.id, undefined, { kwotaPobrania: '100.00', potwierdzonaNiedoplata: '162.90' });
    expect(t.przesylki()).toHaveLength(1);
    expect(t.fetchDpd.mock.calls[0][1].body).toContain('<cod><amount>100.00</amount><currency>PLN</currency></cod>');
    expect(logPobrania(t.id)).toEqual(['kwota do zainkasowania przez kuriera: 100.00 zł; potwierdzona niedopłata: 162.90 zł']);
  });

  it.each(['112.90', 'tak', ''])('potwierdzenie %j (nie bieżąca niedopłata) → odmowa', async (potwierdzonaNiedoplata) => {
    const t = przygotuj({ kwotaPobrania: '50.00', wplata: '50.00' });
    await expect(t.nadanie.nadaj(t.id, undefined, { kwotaPobrania: '100.00', potwierdzonaNiedoplata }))
      .rejects.toMatchObject({ dlaOperatora: true, message: expect.stringContaining('różni się od niedopłaty 162.90 zł') });
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });

  it.each(['0', '170.00'])('„%s” z potwierdzeniem → odmowa „pobierz najwyżej 162.90 zł”', async (kwotaPobrania) => {
    const t = przygotuj({ kwotaPobrania: '50.00', wplata: '50.00' });
    await expect(t.nadanie.nadaj(t.id, undefined, { kwotaPobrania, potwierdzonaNiedoplata: '162.90' })).rejects.toMatchObject({
      dlaOperatora: true, message: 'Zamówienie ma wpłaty 50.00 zł — pobierz najwyżej 162.90 zł albo wyłącz pobranie. Panel niczego nie nadał.',
    });
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });
});

describe('PRZ-145.01 (7) N = 0 (wpłata 212.90) — jak dotąd', () => {
  it('K „0” na zamówieniu, bez kwoty na paczce → nadanie bez <cod>', async () => {
    const t = przygotuj({ kwotaPobrania: '0', wplata: '212.90' });
    await t.nadanie.nadaj(t.id, undefined, { kwotaPobrania: '0' });
    expect(t.fetchDpd.mock.calls[0][1].body).not.toContain('<cod>');
  });

  it('„10.00” na paczce → odmowa „pobierz najwyżej 0.00 zł”', async () => {
    const t = przygotuj({ kwotaPobrania: '0', wplata: '212.90' });
    await expect(t.nadanie.nadaj(t.id, undefined, { kwotaPobrania: '10.00' })).rejects.toMatchObject({
      dlaOperatora: true, message: 'Zamówienie ma wpłaty 212.90 zł — pobierz najwyżej 0.00 zł albo wyłącz pobranie. Panel niczego nie nadał.',
    });
    expect(t.fetchDpd).not.toHaveBeenCalled();
  });
});
