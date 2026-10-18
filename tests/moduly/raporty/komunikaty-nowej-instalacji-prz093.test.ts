import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszHistorie } from '../../../src/oms/db/historia-sprzedazy.js';
import { rachunekOkresu } from '../../../src/domena/rachunek-zarzadczy.js';
import { pierwszyDzienZamowien } from '../../../src/domena/statystyki-okresu.js';

// PRZ-093.07: firma, która właśnie zainstalowała OMS, na STATYSTYKACH, FINANSACH i RAPORTACH
// dostawała komunikat bez wskazówki, co zrobić. Komunikat jest kontraktem: musi nazwać zmienną
// albo polecenie, format i plik, w którym się to wpisuje. Dane poniżej są fikcyjne.
const env = { OMS_USER: 'operator093', OMS_PASS: 'fixture-093',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const headers = { authorization: `Basic ${Buffer.from('operator093:fixture-093').toString('base64')}` };

let transport: MockInstance<typeof fetch>;
beforeEach(() => { transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona')); });
afterEach(() => { expect(transport).not.toHaveBeenCalled(); transport.mockRestore(); });

let kolejny = 0;
function wstawZamowienie(db: any, utworzoneAt: string) {
  kolejny += 1;
  db.prepare(`INSERT INTO zamowienia
    (sklep, zrodlo_id, numer, metoda_wysylki, pobranie, b2b, indywidualne, metoda_platnosci,
     kwota_brutto, klient_json, anulowane, utworzone_at)
    VALUES ('lampy', ?, ?, 'dpd', 0, 0, 0, 'BLIK', '100.00', ?, 0, ?)`)
    .run(kolejny, `L${kolejny}`, JSON.stringify({ email: 'kupiec@example.test' }), utworzoneAt);
}

async function statystyki(srodowisko: Record<string, string>, url: string, przygotuj: (db: any) => void = () => {}) {
  const db = openOmsDb();
  przygotuj(db);
  const z = await zbudujOms({ env: srodowisko, db });
  try {
    const odp = await z.app.inject({ method: 'GET', url, headers });
    expect(odp.statusCode).toBe(200);
    const pasek = odp.body.match(/<div class="pasek-uwaga pasek-uwaga--epoka">([\s\S]*?)<\/div>/)?.[1] ?? null;
    return pasek === null ? null : pasek.replace(/\s+/g, ' ').trim();
  } finally { await z.app.close(); db.close(); }
}

describe('PRZ-093.07 STATYSTYKI — początek danych', () => {
  it('pusta baza bez OMS_STATYSTYKI_PIERWSZY_DZIEN: pasek mówi, co wpisać, w jakim formacie i gdzie', async () => {
    const pasek = await statystyki(env, '/statystyki?od=2031-07-01&do=2031-07-31');
    expect(pasek).not.toBeNull();
    expect(pasek).toContain('nie ma jeszcze żadnego zamówienia');
    expect(pasek).toContain('OMS_STATYSTYKI_PIERWSZY_DZIEN=RRRR-MM-DD');
    expect(pasek).toContain('oms.env');
    expect(pasek).toContain('uruchom OMS ponownie');
  });

  it('bez env, z zamówieniami: zakres od dnia pierwszego zamówienia nie ma paska wcale', async () => {
    const pasek = await statystyki(env, '/statystyki?od=2031-07-10&do=2031-07-31', (db) => {
      wstawZamowienie(db, '2031-07-12T08:00:00Z');
      wstawZamowienie(db, '2031-07-10T08:00:00Z');
    });
    expect(pasek).toBeNull();
  });

  it('bez env, z zamówieniami: zakres sprzed pierwszego zamówienia mówi, od kiedy są dane i skąd ta data', async () => {
    const pasek = await statystyki(env, '/statystyki?od=2031-07-01&do=2031-07-31', (db) => {
      wstawZamowienie(db, '2031-07-12T08:00:00Z');
      wstawZamowienie(db, '2031-07-10T08:00:00Z');
    });
    expect(pasek).toContain('od 10.07.2031');
    expect(pasek).toContain('pierwszego zamówienia zapisanego w OMS-ie');
    expect(pasek).not.toContain('Nie ustalono');
  });

  it('env ustawiony wygrywa nad dniem pierwszego zamówienia (produkcja właściciela bez zmian)', async () => {
    const pasek = await statystyki({ ...env, OMS_STATYSTYKI_PIERWSZY_DZIEN: '2031-07-03' },
      '/statystyki?od=2031-07-01&do=2031-07-31', (db) => wstawZamowienie(db, '2031-07-10T08:00:00Z'));
    expect(pasek).toContain('od 3.07.2031');
    expect(pasek).not.toContain('10.07.2031');
    expect(pasek).toContain('zaimportowana historia');
    // Zakres od dnia z env — paska nie ma, mimo że pierwsze zamówienie jest później.
    const bez = await statystyki({ ...env, OMS_STATYSTYKI_PIERWSZY_DZIEN: '2031-07-03' },
      '/statystyki?od=2031-07-03&do=2031-07-31', (db) => wstawZamowienie(db, '2031-07-10T08:00:00Z'));
    expect(bez).toBeNull();
  });

  it('dzień pierwszego zamówienia liczony w czasie warszawskim, jak kotwica statystyk', () => {
    const db = openOmsDb();
    try {
      expect(pierwszyDzienZamowien(db)).toBeNull();
      wstawZamowienie(db, '2031-07-12T08:00:00Z');
      wstawZamowienie(db, '2031-07-09T22:30:00Z'); // w Warszawie już 10.07, 00:30
      expect(pierwszyDzienZamowien(db)).toBe('2031-07-10');
    } finally { db.close(); }
  });
});

describe('PRZ-093.07 FINANSE — brak podłogi kosztów', () => {
  it('komunikat nazywa OMS_RAPORTY_PODLOGA_KOSZTOW, format RRRR-MM, plik i znaczenie', async () => {
    const db = openOmsDb();
    try {
      let blad: any;
      try { rachunekOkresu(db, { od: '2031-06-01', do: '2031-06-30' }); } catch (e) { blad = e; }
      expect(blad?.dlaOperatora).toBe(true);
      expect(blad.message).toContain('OMS_RAPORTY_PODLOGA_KOSZTOW=RRRR-MM');
      expect(blad.message).toContain('oms.env');
      expect(blad.message).toMatch(/od którego koszty .* są kompletne/);
    } finally { db.close(); }
    const z = await zbudujOms({ env });
    try {
      const odp = await z.app.inject({ method: 'GET', url: '/finanse?od=2031-06-01&do=2031-06-30', headers });
      expect(odp.statusCode).toBe(400);
      expect(odp.body).toContain('OMS_RAPORTY_PODLOGA_KOSZTOW=RRRR-MM');
    } finally { await z.app.close(); z.db.close(); }
  });
});

describe('PRZ-093.07 RAPORTY — brak granicy historii kanału', () => {
  it('komunikat podaje polecenie, które zakłada granicę (instrukcja, sekcja 9)', async () => {
    const db = openOmsDb();
    zapiszHistorie(db, { apiloId: 'h1', platformAccountId: 21, dzien: '2031-06-10', utworzoneAt: '2031-06-10T10:00:00Z',
      brutto: '246.00', tagi: [], status: 15, paymentStatus: 2, klientEmail: 'kupiec@example.test', pozycje: [] });
    const z = await zbudujOms({ db, env: { ...env, OMS_HISTORIA_KLASYFIKACJA: '{"konta":[{"konto":21,"raport":"RECZNE"}]}' } });
    try {
      const odp = await z.app.inject({ method: 'GET', url: '/raporty?od=2031-06-01&do=2031-06-30', headers });
      expect(odp.statusCode).toBe(400);
      expect(odp.body).toContain('granica historii dla kanału RECZNE');
      expect(odp.body).toContain(
        'sudo sh /opt/oms/aktualizuj.sh compose exec -T oms node scripts/produkcja-pierwszy-start.mjs --granice');
      expect(odp.body).toContain('sekcja 9');
    } finally { await z.app.close(); db.close(); }
  });
});
