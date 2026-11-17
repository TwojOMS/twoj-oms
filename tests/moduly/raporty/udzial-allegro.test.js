import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { ustawGranice, zapiszHistorie } from '../../../src/oms/db/historia-sprzedazy.js';
import { rachunekOkresu, rachunekOkresuAsync } from '../../../src/domena/rachunek-zarzadczy.js';
import { wczytajRaporty } from '../../../src/moduly/raporty/konfiguracja.ts';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszKoszt } from '../../../src/oms/db/koszty.js';
import { tmpdir } from 'node:os';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });
afterEach(() => db.close());
const zakres = { od: '2026-06-01', do: '2026-06-30' };

async function policz(raport, typ, bezDefinicji = false) {
  const config = wczytajRaporty({
    OMS_KANALY: JSON.stringify([{ klucz: 'konto_lamp', typ, prefiks: 'LAMPY', raport }]),
    OMS_HISTORIA_KLASYFIKACJA: JSON.stringify({ konta: [{ konto: 7, raport }] }),
  });
  for (const kanal of config.regulySprzedazy.klasyfikacja.raporty) ustawGranice(db, kanal, '2026-06-30', 'test', null);
  // Historia Apilo nie ma pola sklep — rozstrzyga wyłącznie klucz raportowy.
  zapiszHistorie(db, {
    apiloId: 'L-1', platformAccountId: 7, dzien: '2026-06-10',
    utworzoneAt: '2026-06-10T10:00:00Z', brutto: '123.00', tagi: [],
    status: 15, paymentStatus: 2, klientEmail: 'klient@example.test', pozycje: [],
  });
  const opcje = { regulySprzedazy: config.regulySprzedazy, podlogaKosztow: '2026-01',
    ...(bezDefinicji ? {} : { definicje: config.definicje }) };
  const wynik = rachunekOkresu(db, zakres, opcje);
  expect(await rachunekOkresuAsync(db, zakres, opcje)).toEqual(wynik);
  return wynik;
}

describe('udział prowizji według typu kanału raportowego', () => {
  it('kompozycja przekazuje typ PLC_ALLEGRO do ekranu Finansów', async () => {
    const env = {
      OMS_USER: 'operator', OMS_PASS: 'fixture',
      OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
      OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
      OMS_RAPORTY_PODLOGA_KOSZTOW: '2026-01',
      OMS_KANALY: JSON.stringify([{ klucz: 'konto_lamp', typ: 'allegro', prefiks: 'LAMPY', raport: 'PLC_ALLEGRO' }]),
      OMS_HISTORIA_KLASYFIKACJA: JSON.stringify({ konta: [{ konto: 7, raport: 'PLC_ALLEGRO' }] }),
    };
    for (const kanal of ['PLC_ALLEGRO', 'DROPSHIPPING', 'B2B', 'RECZNE']) ustawGranice(db, kanal, '2026-06-30', 'test', null);
    zapiszHistorie(db, {
      apiloId: 'L-1', platformAccountId: 7, dzien: '2026-06-10',
      utworzoneAt: '2026-06-10T10:00:00Z', brutto: '123.00', tagi: [],
      status: 15, paymentStatus: 2, klientEmail: 'klient@example.test', pozycje: [],
    });
    zapiszKoszt(db, {
      ksefNumber: 'PROWIZJA-TEST', numerDokumentu: 'PROWIZJA/2026/06',
      // Publiczny identyfikator dostawcy rozpoznawany przez prowizjaAllegroZaMiesiac.
      sprzedawcaNip: '5252674798', sprzedawcaNazwa: 'Allegro',
      dataWystawienia: '2026-06-30', dataTrwalegoZapisu: '2026-06-30T12:00:00Z',
      netto: '5.00', vat: '1.15', brutto: '6.15', waluta: 'PLN', rodzaj: 'VAT', maZalacznik: 0,
    });
    const { app } = await zbudujOms({ db, env });
    try {
      const odp = await app.inject({ method: 'GET', url: '/finanse?od=2026-06-01&do=2026-06-30',
        headers: { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` } });
      expect(odp.statusCode).toBe(200);
      // Kwota musi być w kaflu Allegro — całkowity przychód też wynosi 100 zł.
      const kafel = odp.body.match(/Prowizja Allegro ÷ sprzedaż Allegro<\/div>([\s\S]*?)<\/div>\s*<\/div>/)?.[1];
      expect(kafel).toBeDefined();
      expect(kafel).toMatch(/przy sprzedaży\s+100,00 zł/);
      expect(kafel).toMatch(/5,00 zł\s+z 1 dokumentu/);
      expect(kafel).toMatch(/kafel-wartosc">\s*5,0%\s*<\/div>/);
    } finally { await app.close(); }
  });

  it('PLC_ALLEGRO typu Allegro liczy sprzedaż i udział także z historii bez sklepu', async () => {
    const wynik = await policz('PLC_ALLEGRO', 'allegro');
    expect(wynik.sprzedazAllegroGrosze).toBe(10_000);
    // Brak dokumentów prowizyjnych oznacza 0%, a nie brak sprzedaży.
    expect(wynik.udzialProwizjiAllegro).toBe(0);
  });
  it('ALLEGRO_X bez definicji zachowuje wynik starej instalacji', async () => {
    const wynik = await policz('ALLEGRO_X', 'allegro', true);
    expect(wynik.sprzedazAllegroGrosze).toBe(10_000);
    expect(wynik.udzialProwizjiAllegro).toBe(0);
  });
  it('ALLEGRO_X z definicją Allegro zachowuje wynik starego prefiksu', async () => {
    const wynik = await policz('ALLEGRO_X', 'allegro');
    expect(wynik.sprzedazAllegroGrosze).toBe(10_000);
    expect(wynik.udzialProwizjiAllegro).toBe(0);
  });
  it.each(['SKLEP_ALLEGRO_LAMPY', 'ALLEGRO_SKLEP'])('WooCommerce %s nie jest sprzedażą Allegro', async (raport) => {
    const wynik = await policz(raport, 'woo');
    expect(wynik.sprzedazAllegroGrosze).toBe(0);
    expect(wynik.udzialProwizjiAllegro).toBeNull();
  });
});
