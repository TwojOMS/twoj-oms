// PRZ-108.09 (zmiana C2 planu automatyzacji): chwila odbioru paczki przez kuriera. `odswiezStatusKuriera` (czuwacz co
// godzinę i karta) przy PIERWSZYM dowodzie z białej listy (domena/dowod-odbioru.js) zapisuje `przesylki.odebrana_at`
// (nasz zegar, ISO z `Z`) i `odebrana_dowod`; później już ich nie rusza. Kolumny dokłada migracja automatyzacje/0003; na
// bazie bez modułu automatyzacji (sam rdzeń) zapis cicho się nie odbywa, a odświeżenie statusu działa jak dotąd.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { kolejnoscBudowy } from '../../../src/core/sprawdz-moduly.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zarejestrujPrzesylkeReczna, rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { odswiezStatusKuriera } from '../../../src/moduly/wysylka/services/status-kuriera.js';

const MIN = 60_000;
let db;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse('2026-10-21T12:00:00.000Z')); db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) }); });
afterEach(() => { vi.useRealTimers(); db.close(); });

const zamowienie = () => zapiszZamowienie(db, 'sklep', {
  zrodlo_id: 1, numer: '1', klient: { email: 'k@example.invalid' }, dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 0, nip: null, kwota_brutto: '50.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-20T10:00:00Z', pozycje: [],
});
const wiersz = (id) => db.prepare('SELECT * FROM przesylki WHERE id = ?').get(id);

describe('migracja automatyzacje/0003', () => {
  it('przesylki ma odebrana_at i odebrana_dowod (NULL dla istniejących) oraz indeks po odebrana_at', () => {
    const kolumny = db.prepare('PRAGMA table_info(przesylki)').all().map((k) => k.name);
    expect(kolumny).toEqual(expect.arrayContaining(['odebrana_at', 'odebrana_dowod', 'odebrana_kurier_at'])); // 0004: recenzja 09
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'przesylki_odebrana_at'").get()).toBeTruthy();
    expect(db.prepare("SELECT nazwa FROM migracje WHERE modul = 'automatyzacje' AND numer = 3").get()?.nazwa).toMatch(/odb/u);
  });
});

describe('zapis chwili odbioru przy odświeżeniu statusu', () => {
  it('zarejestrowana → nic; „odebrana przez Kuriera” → chwila zapisu i dowód; doręczenie później nie przesuwa chwili', async () => {
    const id = zamowienie();
    const p = zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000000000001U' });
    let odpowiedz = { opis: 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana', at: '2026-10-21T14:00:00.000' };
    const kurierzy = { dpd: { statusPrzesylki: async () => odpowiedz } };
    const odswiez = async () => { vi.setSystemTime(Date.now() + 61 * MIN); return odswiezStatusKuriera(db, kurierzy, pobierzZamowienie(db, id), wiersz(p.id)); };

    await odswiez();
    expect(wiersz(p.id)).toMatchObject({ odebrana_at: null, odebrana_dowod: null });

    odpowiedz = { opis: 'Przesyłka odebrana przez Kuriera', at: '2026-10-21T15:10:00.000' };
    await odswiez();
    const chwila = new Date().toISOString();
    expect(wiersz(p.id)).toMatchObject({ odebrana_at: chwila, odebrana_dowod: 'dpd:ODEBRANA_PRZEZ_KURIERA' });

    odpowiedz = { opis: 'Przesyłka doręczona', at: '2026-10-22T09:00:00.000' };
    await odswiez();
    expect(wiersz(p.id)).toMatchObject({ odebrana_at: chwila, odebrana_dowod: 'dpd:ODEBRANA_PRZEZ_KURIERA', status_kuriera: 'Przesyłka doręczona' });
  });

  it('DPD: odbiór widoczny tylko w historii (najnowsze zdarzenie spoza listy) → zapis z dowodem z historii', async () => {
    const id = zamowienie();
    const p = zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000000000002U' });
    const historia = [
      { opis: 'Przesyłka odebrana przez Kuriera', at: '2026-10-21T13:10:00.000' },
      { opis: 'Wydanie przesyłki do doręczenia', at: '2026-10-22T07:00:00.000' },
    ];
    const kurierzy = { dpd: { statusPrzesylki: async () => ({ ...historia[1], historia }) } };
    await odswiezStatusKuriera(db, kurierzy, pobierzZamowienie(db, id), wiersz(p.id));
    expect(wiersz(p.id).odebrana_dowod).toBe('historia:ODEBRANA_PRZEZ_KURIERA');
  });

  it('błąd kuriera albo brak zdarzeń → brak chwili odbioru', async () => {
    const id = zamowienie();
    const p = zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000000000003U' });
    await odswiezStatusKuriera(db, { dpd: { statusPrzesylki: async () => null } }, pobierzZamowienie(db, id), wiersz(p.id));
    vi.setSystemTime(Date.now() + 61 * MIN);
    await odswiezStatusKuriera(db, { dpd: { statusPrzesylki: async () => { throw Object.assign(new Error('DPD nieosiągalne'), { dlaOperatora: true }); } } },
      pobierzZamowienie(db, id), wiersz(p.id));
    expect(wiersz(p.id).odebrana_at).toBeNull();
  });

  it('Wysyłam z Allegro: dowód przejęcia (przejeta_at) zapisuje też chwilę odbioru w tym samym odświeżeniu', async () => {
    const id = zamowienie();
    const p = rozpocznijPrzesylke(db, id, 'allegro_wza');
    zakonczPrzesylke(db, p.id, { numerListu: 'WZA-1', etykietaSciezka: '/tmp/e.pdf',
      surowa: JSON.stringify({ carrierTrackingData: { carrierId: 'DPD', carrierWaybill: '0000000000004U' } }) });
    const historia = [{ opis: 'Przyjęcie przesyłki w oddziale DPD', at: '2026-10-21T13:00:00.000' }];
    const kurierzy = { dpd: { statusPrzesylki: async () => ({ ...historia[0], historia }) } };
    await odswiezStatusKuriera(db, kurierzy, pobierzZamowienie(db, id), wiersz(p.id));
    const w = wiersz(p.id);
    expect(w.przejeta_at).not.toBeNull();
    expect(w).toMatchObject({ odebrana_at: new Date().toISOString(), odebrana_dowod: 'przejecie' });
  });

  it('baza samym rdzeniem (bez kolumn odbioru): status zapisany jak dotąd, odświeżenie nie rzuca', async () => {
    const rdzen = openOmsDb(':memory:');
    try {
      const id = zapiszZamowienie(rdzen, 'sklep', { zrodlo_id: 2, numer: '2', klient: {}, dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
        chce_fakture: 0, nip: null, kwota_brutto: '1.00', status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-20', pozycje: [] });
      const p = zarejestrujPrzesylkeReczna(rdzen, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '0000000000005U' });
      const wynik = await odswiezStatusKuriera(rdzen, { dpd: { statusPrzesylki: async () => ({ opis: 'Przesyłka odebrana przez Kuriera', at: '2026-10-21T13:00:00.000' }) } },
        pobierzZamowienie(rdzen, id), rdzen.prepare('SELECT * FROM przesylki WHERE id = ?').get(p.id));
      expect(wynik).toEqual({ ok: true });
      expect(rdzen.prepare('SELECT status_kuriera FROM przesylki WHERE id = ?').get(p.id).status_kuriera).toBe('Przesyłka odebrana przez Kuriera');
    } finally { rdzen.close(); }
  });
});
