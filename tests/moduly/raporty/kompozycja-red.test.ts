import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { ustawGranice, zapiszHistorie } from '../../../src/oms/db/historia-sprzedazy.js';
import { KANALY, envRaportowHistorycznyFixture } from '../../pomoc/raporty-historyczne-fixture.js';

// PRZ-027 RED: OBECNA produkcyjna kompozycja (domyślna lista modułów bootstrapu), prawdziwa
// baza z migracji i jawnie fikcyjne dane. Bez helperów parytetu i bez nieistniejącego manifestu:
// po GREEN te same asercje muszą przejść, bo koordynator dopisze modulRaporty do bootstrapu.
const env = { ...envRaportowHistorycznyFixture, OMS_USER: 'operator027', OMS_PASS: 'fixture-027',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const headers = { authorization: `Basic ${Buffer.from('operator027:fixture-027').toString('base64')}` };
const BOM = String.fromCharCode(65279);
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

// Kanał RECZNE w obu epokach: konto 21 w historii i sklep 'reczne' w OMS. Neutralne dane,
// bez nazw sklepów i bez filtrów firmy, więc brak konfiguracji WDT/testowych niczego nie wyklucza.
function zasiej(db: any) {
  for (const k of KANALY) ustawGranice(db, k, '2026-07-02', 'fixture-027', null);
  const historia = (apiloId: string, numer: string, dzien: string, brutto: string) => zapiszHistorie(db, {
    apiloId, platformAccountId: 21, numer, dzien, utworzoneAt: `${dzien}T10:00:00.000Z`, brutto,
    tagi: [], status: 15, paymentStatus: 2, klientEmail: 'k@klient.example', klientNazwa: 'Klient Fikcyjny',
    faktura: 0, pozycje: [{ nazwa: 'Produkt fikcyjny', ilosc: 1, bruttoLinii: brutto, typ: 1 }],
  });
  historia('FX-H1', 'R-1001', '2026-06-10', '246.00');
  historia('FX-H2', 'R-1002', '2026-06-12', '54.00');
  // Zamówienie OMS po granicy: kwota ręcznego zamówienia jest kwotą oczekiwaną.
  db.prepare('INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, klient_json, utworzone_at, indywidualne)'
    + " VALUES ('reczne', 27001, 'R-2001', '123.00', ?, '2026-07-10T10:00:00Z', 0)")
    .run(JSON.stringify({ email: 'oms@klient.example' }));
  // Statystyki sierpnia: dwie paczki DPD (jedna w dniu wpłaty, jedna po 5 dniach) i jeden paczkomat.
  const wysylka = (zrodloId: number, metoda: string, wyslane: string) => {
    db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, metoda_wysylki, pobranie, b2b, indywidualne,
      metoda_platnosci, kwota_brutto, klient_json, oplacone_at, wyslane_at, anulowane, utworzone_at)
      VALUES ('reczne', ?, ?, ?, 0, 0, 0, 'BLIK', '100.00', ?, '2026-08-13T06:00:00Z', ?, 0, '2026-08-13T06:00:00Z')`)
      .run(zrodloId, `S-${zrodloId}`, metoda, JSON.stringify({ email: 'stat@klient.example' }), wyslane);
    const { id } = db.prepare("SELECT id FROM zamowienia WHERE sklep = 'reczne' AND zrodlo_id = ?").get(zrodloId);
    db.prepare("INSERT INTO platnosci (zamowienie_id, kwota, data, metoda, uwaga, zrodlo, utworzona_at) VALUES (?,?,?,?,NULL,'sklep',?)")
      .run(id, '100.00', '2026-08-13T06:00:00Z', 'BLIK', '2026-08-13T06:00:00Z');
  };
  wysylka(27101, 'dpd', '2026-08-13T14:00:00Z');
  wysylka(27102, 'dpd', '2026-08-18T07:00:00Z');
  wysylka(27103, 'inpost_paczkomat', '2026-08-13T15:00:00Z');
}

async function zAplikacja(test: (z: Awaited<ReturnType<typeof zbudujOms>>) => Promise<void>) {
  const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
  const db = openOmsDb();
  let z: Awaited<ReturnType<typeof zbudujOms>> | undefined;
  try {
    zasiej(db);
    z = await zbudujOms({ env, db });
    await test(z);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    try { if (z) await z.app.close(); } finally { db.close(); transport.mockRestore(); }
  }
}

describe('PRZ-027 kompozycja — kontrola bramki (zielona przed i po implementacji)', () => {
  it('BasicAuth odrzuca brak poświadczeń i przepuszcza operatora do routera', async () => {
    await zAplikacja(async (z) => {
      expect((await z.app.inject({ method: 'GET', url: '/raporty' })).statusCode).toBe(401);
      expect((await z.app.inject({ method: 'GET', url: '/prz027-nie-ma-takiej-trasy', headers })).statusCode).toBe(404);
      // PRZ-027F: jawny powrót UI Finansów decyzją właściciela 07.10.2026.
      for (const url of ['/finanse', '/finanse/dane', '/raporty/zarzadczy', '/raporty/dane', '/raporty/dane/:miesiac'])
        expect(z.app.hasRoute({ method: 'GET', url })).toBe(true);
    });
  });
});

describe('PRZ-027 kompozycja — RED brakujących tras raportów i statystyk', () => {
  it('GET /raporty renderuje sprzedaż obu epok z policzonymi kwotami kanału', async () => {
    await zAplikacja(async (z) => {
      const odp = await z.app.inject({ method: 'GET', url: '/raporty?od=2026-06-01&do=2026-07-31', headers });
      expect(odp.statusCode).toBe(200);
      expect(z.app.hasRoute({ method: 'GET', url: '/raporty' })).toBe(true);
      expect(odp.headers['content-type']).toContain('text/html');
      const s = odp.body.slice(odp.body.indexOf('Skąd przyszła sprzedaż'));
      const karta = s.slice(s.indexOf('class="kanal-okienko"'), s.indexOf('class="kanal-nazwa"'));
      // 246,00 + 54,00 z historii i 123,00 z OMS = 423,00 zł / 3 zamówienia / średnio 141,00 zł.
      expect(karta).toContain('423,00 zł');
      expect(karta).toContain('3 zamówienia');
      expect(karta).toContain('średnie zamówienie 141,00 zł');
      expect(odp.body).toContain('/raporty/eksport.csv?od=2026-06-01&do=2026-07-31');
    });
  });

  it('GET /raporty/eksport.csv oddaje te same wiersze co do grosza, z BOM i bez e-maili domyślnie', async () => {
    await zAplikacja(async (z) => {
      const odp = await z.app.inject({ method: 'GET', url: '/raporty/eksport.csv?od=2026-06-01&do=2026-07-31', headers });
      expect(odp.statusCode).toBe(200);
      expect(z.app.hasRoute({ method: 'GET', url: '/raporty/eksport.csv' })).toBe(true);
      expect(odp.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(odp.headers['content-disposition']).toBe('attachment; filename="sprzedaz-2026-06-01_2026-07-31.csv"');
      expect(odp.body).toBe(BOM + [
        'Dzień;Kanał;Numer;Źródło;Brutto;Netto;Faktura;Opłacone',
        '2026-06-10;RECZNE;R-1001;Apilo;246,00;200,00;nie;tak',
        '2026-06-12;RECZNE;R-1002;Apilo;54,00;43,90;nie;tak',
        '2026-07-10;RECZNE;R-2001;OMS;123,00;100,00;nie;nie',
      ].join(CRLF));
      const zKlientem = await z.app.inject({ method: 'GET', url: '/raporty/eksport.csv?od=2026-06-01&do=2026-07-31&klient=1', headers });
      expect(zKlientem.statusCode).toBe(200);
      expect(zKlientem.body.split(CRLF)[3]).toBe('2026-07-10;RECZNE;R-2001;OMS;123,00;100,00;nie;nie;oms@klient.example');
    });
  });

  it('GET /statystyki liczy przewoźników, terminowość i płatności z efektywnych wpłat', async () => {
    await zAplikacja(async (z) => {
      const odp = await z.app.inject({ method: 'GET', url: '/statystyki?od=2026-08-01&do=2026-08-31', headers });
      expect(odp.statusCode).toBe(200);
      expect(z.app.hasRoute({ method: 'GET', url: '/statystyki' })).toBe(true);
      expect(odp.body).toMatch(/<td>Kurier DPD<\/td>\s*<td[^>]*>2<\/td>/);
      expect(odp.body).toMatch(/<td>InPost Paczkomat<\/td>\s*<td[^>]*>1<\/td>/);
      expect(odp.body).toMatch(/<td>BLIK<\/td>\s*<td[^>]*>3<\/td>/);
      // 2 z 3 paczek wyszły w dniu wpłaty, trzecia po pięciu dniach.
      expect(odp.body).toContain('66,7%');
    });
  });
});
