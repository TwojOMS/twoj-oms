// PRZ-117 — notatka z numerem listu, która nie doszła do sklepu (zamówienie 1491, 26.10.2026: „Sklep nieosiągalny:
// szkicownia.pl: błąd sieci”). Do tej poprawki ślad wisiał na karcie bez wyjścia poza „załatw ręcznie” — 1419 i 1437
// wisiały 13 dni. Teraz: jedna szybka powtórka przy samym nadaniu, przycisk „Spróbuj ponownie” i zegar przez 48 h.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import {
  ponowNotatkeNadania, ponowZalegleNotatki, OKNO_PONAWIANIA_NOTATKI_H,
} from '../../../src/moduly/wysylka/services/notatka-nadania.js';

const NUMER = '1000000000001U';
const zmapowane = () => ({
  zrodlo_id: 1301, numer: '1301', klient: { email: 'j@k.pl', phone: '+48500600700' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  status_woo: 'processing', oplacone_at: '2026-07-29T13:00:00', anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52', pozycje: [],
});
const sieci = () => new Error('Sklep nieosiągalny: sklep.invalid: błąd sieci');
const logi = (db) => db.prepare("SELECT wynik FROM log WHERE akcja = 'sync-woo' ORDER BY id").all().map((w) => w.wynik);

async function nadana({ dodajNotatke }) {
  const db = openOmsDb(':memory:');
  const dpd = { nadaj: vi.fn().mockResolvedValue({ numerListu: NUMER, etykietaPdf: Buffer.from('%PDF-x'), surowa: '<xml/>' }) };
  const woo = { dodajNotatke, ustawStatus: vi.fn() };
  const czekaj = vi.fn().mockResolvedValue(undefined);
  const nadanie = createNadanie({
    db, kurierzy: { dpd }, klienci: { pro: woo }, katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-')), czekaj,
  });
  const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
  await nadanie.nadaj(id);
  const p = pobierzZamowienie(db, id).przesylki[0];
  return { db, woo, nadanie, czekaj, id, p };
}

describe('PRZ-117: notatka z numerem listu przy nadaniu', () => {
  it('błąd sieci przy nadaniu: jedna powtórka po chwili, i gdy przejdzie — śladu nie ma', async () => {
    const dodajNotatke = vi.fn().mockRejectedValueOnce(sieci()).mockResolvedValueOnce({});
    const { db, czekaj, p } = await nadana({ dodajNotatke });
    expect(dodajNotatke).toHaveBeenCalledTimes(2);
    expect(czekaj).toHaveBeenCalledTimes(1);
    expect(p.sync_woo_blad).toBeNull();
    expect(logi(db)).toEqual(['OK']);
  });

  it('odmowa sklepu (nie sieć) nie jest powtarzana od razu — ślad zostaje', async () => {
    const dodajNotatke = vi.fn().mockRejectedValue(new Error('Sklep odpowiedział 400: zły numer'));
    const { czekaj, p } = await nadana({ dodajNotatke });
    expect(dodajNotatke).toHaveBeenCalledTimes(1);
    expect(czekaj).not.toHaveBeenCalled();
    expect(p.sync_woo_blad).toBe('notatka: Sklep odpowiedział 400: zły numer');
  });

  it('„Spróbuj ponownie”: wysyła tę samą notatkę i zdejmuje ślad', async () => {
    const dodajNotatke = vi.fn().mockRejectedValueOnce(sieci()).mockRejectedValueOnce(sieci()).mockResolvedValue({});
    const { db, woo, nadanie, id, p } = await nadana({ dodajNotatke });
    expect(p.sync_woo_blad).toMatch(/^notatka: Sklep nieosiągalny/);
    expect(await nadanie.ponowNotatke(p.id)).toEqual({ ok: true });
    expect(woo.dodajNotatke).toHaveBeenLastCalledWith(1301, `Nadano DPD, list przewozowy ${NUMER}`);
    expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toBeNull();
    expect(logi(db).at(-1)).toBe('OK (ponowienie)');
  });

  it('nieudane ponowienie odświeża ślad i nie rzuca', async () => {
    const dodajNotatke = vi.fn().mockRejectedValue(sieci());
    const { db, nadanie, id, p } = await nadana({ dodajNotatke });
    expect(await nadanie.ponowNotatke(p.id)).toEqual({ blad: expect.stringContaining('błąd sieci') });
    expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toMatch(/^notatka: /);
    expect(logi(db).at(-1)).toMatch(/^BŁĄD: notatka \(ponowienie\)/);
  });

  it('przesyłka bez nieudanej notatki → odmowa dla operatora, bez wywołania sklepu', async () => {
    const dodajNotatke = vi.fn().mockResolvedValue({});
    const { nadanie, p } = await nadana({ dodajNotatke });
    await expect(nadanie.ponowNotatke(p.id)).rejects.toThrow(/nie ma nieudanej notatki/);
    expect(dodajNotatke).toHaveBeenCalledTimes(1);
  });
});

describe('PRZ-117: InPost 404 tuż po nadaniu to brak zdarzeń, nie błąd (zamówienie 1493)', () => {
  const NR = '520000123456789012345678'; // zmyślony, w formacie ShipX
  async function paczkaInpost(godzinPoNadaniu) {
    const { createInpostClient } = await import('../../../src/oms/kurierzy/inpost.js');
    const { rozpocznijPrzesylke, zakonczPrzesylke, pobierzPrzesylke } = await import('../../../src/moduly/wysylka/db/przesylki.js');
    const { odswiezStatusKuriera } = await import('../../../src/moduly/wysylka/services/status-kuriera.js');
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'pro', { ...zmapowane(), metoda_wysylki: 'inpost_paczkomat' }, {});
    const start = rozpocznijPrzesylke(db, id, 'inpost');
    zakonczPrzesylke(db, start.id, { numerListu: NR, etykietaSciezka: '/tmp/e.pdf', surowa: '{}' });
    const p = pobierzPrzesylke(db, start.id);
    // Odpowiedź ShipX z produkcji 26.10.2026 (kształt odpowiedzi z paczki 1493, sekunda po nadaniu; numer zmyślony).
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 404, ok: false,
      text: async () => JSON.stringify({ status: 404, error: 'resource_not_found',
        message: `Tracking information about ${NR} shipment has not been found.` }),
    });
    const inpost = createInpostClient({ url: 'https://shipx.test/v1', token: 't', organizacja: 1, nadawca: { nazwa: 'Pracownia', ulica: 'Polna 1', kod: '00-001', miasto: 'Gdzieś', kraj: 'PL' }, fetchImpl });
    const terazMs = Date.parse(p.utworzona_at) + godzinPoNadaniu * 3600e3;
    const w = await odswiezStatusKuriera(db, { inpost }, { id, sklep: 'pro' }, p, { terazMs });
    return { w, p: pobierzPrzesylke(db, p.id) };
  }

  it('sekundę po nadaniu: bez błędu na karcie, próba zapisana (dławik działa)', async () => {
    const { w, p } = await paczkaInpost(0);
    expect(w).toEqual({ ok: true });
    expect(p.status_kuriera_blad).toBeNull();
    expect(p.status_kuriera_pobrany_at).toBeTruthy();
  });

  it('po dobie ten sam 404 znów jest błędem (zły numer nie może udawać pustej historii)', async () => {
    const { w, p } = await paczkaInpost(25);
    expect(w.blad).toMatch(/nie udało się sprawdzić statusu/);
    expect(p.status_kuriera_blad).toMatch(/nie udało się sprawdzić statusu/);
  });
});

describe('PRZ-117: przycisk „Spróbuj ponownie” na karcie', () => {
  const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };

  it('karta pokazuje przycisk przy nieudanej notatce, POST wysyła ją i zdejmuje ślad', async () => {
    const { buildOmsServer } = await import('../../pomoc/serwer-parytetu.ts');
    const dodajNotatke = vi.fn().mockRejectedValueOnce(sieci()).mockRejectedValueOnce(sieci()).mockResolvedValue({});
    const { db, nadanie, id, p } = await nadana({ dodajNotatke });
    const serwer = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' } }, poller: { stan: () => ({}) }, nadanie });
    await serwer.ready();
    const karta = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(karta.body).toContain(`/zamowienia/${id}/przesylki/${p.id}/notatka`);
    expect(karta.body).toContain('Spróbuj ponownie');
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${p.id}/notatka`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toBeNull();
    const poNaprawie = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(poNaprawie.body).not.toContain(`/przesylki/${p.id}/notatka`);
    await serwer.close();
  });
});

describe('PRZ-117: zegar ponawia zaległe notatki tylko w oknie', () => {
  it(`ponawia przesyłki młodsze niż ${OKNO_PONAWIANIA_NOTATKI_H} h, starsze zostawia człowiekowi`, async () => {
    const dodajNotatke = vi.fn().mockRejectedValueOnce(sieci()).mockRejectedValueOnce(sieci()).mockResolvedValue({});
    const { db, woo, id, p } = await nadana({ dodajNotatke });
    const teraz = new Date(Date.parse(p.utworzona_at) + 3600e3);
    expect(await ponowZalegleNotatki({ db, klienci: { pro: woo }, teraz })).toEqual({ kandydatow: 1, wyslane: 1, bledy: 0 });
    expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toBeNull();

    db.prepare("UPDATE przesylki SET sync_woo_blad = 'notatka: stara' WHERE id = ?").run(p.id);
    const poOknie = new Date(Date.parse(p.utworzona_at) + (OKNO_PONAWIANIA_NOTATKI_H + 1) * 3600e3);
    const wywolan = woo.dodajNotatke.mock.calls.length;
    expect(await ponowZalegleNotatki({ db, klienci: { pro: woo }, teraz: poOknie })).toEqual({ kandydatow: 0, wyslane: 0, bledy: 0 });
    expect(woo.dodajNotatke.mock.calls.length).toBe(wywolan);
  });

  it('zegar przesyłek woła ponawianie w swoim przebiegu', async () => {
    const { createCzuwaczPrzesylek } = await import('../../../src/moduly/wysylka/services/czuwacz-przesylek.js');
    const dodajNotatke = vi.fn().mockRejectedValueOnce(sieci()).mockRejectedValueOnce(sieci()).mockResolvedValue({});
    const { db, woo, id, p } = await nadana({ dodajNotatke });
    const teraz = () => new Date(Date.parse(p.utworzona_at) + 3600e3);
    const czuwacz = createCzuwaczPrzesylek({ db, kurierzy: {}, klienci: { pro: woo }, teraz });
    expect((await czuwacz.przebieg()).notatki).toEqual({ kandydatow: 1, wyslane: 1, bledy: 0 });
    expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toBeNull();
  });

  it('błąd innego rodzaju niż notatka nie jest ponawiany', async () => {
    const dodajNotatke = vi.fn().mockResolvedValue({});
    const { db, woo, p } = await nadana({ dodajNotatke });
    db.prepare("UPDATE przesylki SET sync_woo_blad = 'status: coś' WHERE id = ?").run(p.id);
    const teraz = new Date(Date.parse(p.utworzona_at) + 3600e3);
    expect(await ponowZalegleNotatki({ db, klienci: { pro: woo }, teraz })).toEqual({ kandydatow: 0, wyslane: 0, bledy: 0 });
  });
});
