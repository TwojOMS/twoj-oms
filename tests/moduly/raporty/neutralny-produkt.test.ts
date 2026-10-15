import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { ustawGranice, zapiszHistorie } from '../../../src/oms/db/historia-sprzedazy.js';
import { KANALY } from '../../pomoc/raporty-historyczne-fixture.js';
import { wgrajDaneStartowe, zapiszDaneMiesiaca, daneMiesiaca } from '../../../src/oms/db/dane-miesieczne.js';
import { KLIENCI_WDT } from '../../../src/domena/sprzedaz-okresu.js';
import { PODLOGA, PODLOGA_ZWROTOW, rachunekOkresu } from '../../../src/domena/rachunek-zarzadczy.js';
import { zamowieniaOkresu } from '../../../src/domena/statystyki-okresu.js';
import { wczytajRaporty } from '../../../src/moduly/raporty/konfiguracja.ts';
import { regulyHistorii, konfiguracjaHistorii } from '../../../src/moduly/kanaly/historia.ts';

// PRZ-027: produkt startuje bez danych i reguł firmy. Wszystko, co różni instalacje
// (WDT, filtry testowe, daty pokrycia, etykiety, dane miesięczne), przychodzi z env albo
// z jawnego importu. Dane poniżej są fikcyjne.
const env = { OMS_USER: 'operator027', OMS_PASS: 'fixture-027',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const reguly = { OMS_KLIENCI_WDT: 'WDT@Klient.example', OMS_HISTORIA_MAILE_TESTOWE: 'wlasny@instalacja.example',
  OMS_HISTORIA_DOMENY_TESTOWE: 'proba.example', OMS_HISTORIA_PREFIKSY_TESTOWE: 'qa',
  OMS_HISTORIA_NAZWY_TESTOWE: 'atrapa' };
const headers = { authorization: `Basic ${Buffer.from('operator027:fixture-027').toString('base64')}` };
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

let transport: MockInstance<typeof fetch>;
beforeEach(() => { transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona')); });
afterEach(() => { expect(transport).not.toHaveBeenCalled(); transport.mockRestore(); });

const ile = (db: any, sql: string, ...p: unknown[]) => db.prepare(sql).get(...p).c;
const markeryDanych = (db: any) => ile(db, "SELECT COUNT(*) AS c FROM migracje_jednorazowe WHERE nazwa LIKE 'dane-miesieczne%'");

async function zAplikacja(srodowisko: Record<string, string>, db: any, test: (z: any) => Promise<void>) {
  const z = await zbudujOms({ env: srodowisko, db });
  try { await test(z); } finally { await z.app.close(); }
}

describe('PRZ-027 neutralny start produktu', () => {
  it('produkcyjny openOmsDb nie wgrywa danych miesięcznych ani ich znacznika', () => {
    const db = openOmsDb();
    try {
      expect(ile(db, 'SELECT COUNT(*) AS c FROM dane_miesieczne')).toBe(0);
      expect(markeryDanych(db)).toBe(0);
    } finally { db.close(); }
  });

  it('pełny bootstrap z własną bazą startuje z pustym dane_miesieczne i neutralną konfiguracją raportów', async () => {
    const z = await zbudujOms({ env });
    try {
      expect(ile(z.db, 'SELECT COUNT(*) AS c FROM dane_miesieczne')).toBe(0);
      expect(markeryDanych(z.db)).toBe(0);
      const config = z.usluga('raporty', 'config') as any;
      expect(config.regulySprzedazy.klienciWdt.size).toBe(0);
      for (const [email, nazwa] of [['qa1@proba.example', 'Atrapa'], ['wlasny@instalacja.example', 'x'], ['', '']])
        expect(config.regulySprzedazy.czyTestowe(email, nazwa)).toBe(false);
      expect(config).toMatchObject({ podlogaZwrotow: null, pierwszyDzienOms: null, nazwyKanalow: {},
        nazwaSklepuHistorii: null, dataImportuHistorii: null });
    } finally { await z.app.close(); z.db.close(); }
  });

  // Domyślna lista modułów i własna baza bootstrapu. Granice historii to dane operacyjne
  // instalacji, nie seed: bez nich raport słusznie przerywa. Przy awarii asercja pokazuje
  // prawdziwą treść odpowiedzi, nie tylko kod.
  it('domyślny bootstrap renderuje /raporty i /statystyki jako HTML 200 przy neutralnej konfiguracji', async () => {
    const z = await zbudujOms({ env });
    try {
      for (const k of KANALY) ustawGranice(z.db, k, '2031-07-02', 'fixture-027', null);
      for (const url of ['/raporty?od=2031-06-01&do=2031-07-31', '/statystyki?od=2031-06-01&do=2031-07-31']) {
        const odp = await z.app.inject({ method: 'GET', url, headers });
        const html = String(odp.headers['content-type'] ?? '').includes('text/html');
        expect({ url, status: odp.statusCode, body: odp.statusCode === 200 && html ? 'HTML' : odp.body })
          .toEqual({ url, status: 200, body: 'HTML' });
      }
    } finally { await z.app.close(); z.db.close(); }
  });

  // PRZ-073: GDD jest kanałem algorytmicznym — granicę ma w każdej instancji (generator demo
  // zakłada ją wszystkim kanałom raportu). O kanale mówi tylko instancja z `tagGdd`.
  it('ostrzeżenie o kanale GDD stoi tylko w instancji, której klasyfikacja ma tagGdd', async () => {
    const pasGdd = async (srodowisko: Record<string, string>) => {
      const z = await zbudujOms({ env: srodowisko });
      try {
        for (const k of ['DROPSHIPPING', 'GDD', 'B2B', 'RECZNE', 'INDYWIDUALNE']) ustawGranice(z.db, k, '2031-07-02', 'fixture-073', null);
        const odp = await z.app.inject({ method: 'GET', url: '/raporty?od=2031-06-01&do=2031-07-31', headers });
        expect(odp.statusCode).toBe(200);
        return odp.body.includes('Po granicy historii kanał GDD nie istnieje');
      } finally { await z.app.close(); z.db.close(); }
    };
    expect(await pasGdd(env)).toBe(false);
    expect(await pasGdd({ ...env, OMS_HISTORIA_KLASYFIKACJA: JSON.stringify({ konta: [], tagGdd: 9 }) })).toBe(true);
  });

  it('domeny nie mają firmowych defaultów: pusty WDT, brak podłóg, rachunek odmawia bez podłogi', () => {
    expect(KLIENCI_WDT.size).toBe(0);
    expect(PODLOGA).toBeNull();
    expect(PODLOGA_ZWROTOW).toBeNull();
    const db = openOmsDb();
    try {
      let blad: any;
      try { rachunekOkresu(db, { od: '2031-01-01', do: '2031-01-31' }); } catch (e) { blad = e; }
      expect(blad?.dlaOperatora).toBe(true);
      expect(blad.message).toContain('podłogi');
    } finally { db.close(); }
  });

  it('statystyki bez skonfigurowanego pierwszego dnia mówią o nieznanym pokryciu, bez daty firmy', async () => {
    const db = openOmsDb();
    try {
      await zAplikacja(env, db, async (z) => {
        const odp = await z.app.inject({ method: 'GET', url: '/statystyki?od=2031-01-01&do=2031-01-31', headers });
        expect(odp.statusCode).toBe(200);
        expect(odp.body).toContain('pokrycie wybranego okresu pozostaje nieznane');
        expect(odp.body).not.toMatch(/obejmują zamówienia <strong>od/);
      });
    } finally { db.close(); }
  });
});

describe('PRZ-027 WDT i filtry testowe — jedna reguła z kanaly/historia.ts', () => {
  const probki: [string, string][] = [
    ['wdt@klient.example', 'Firma UE'], ['WLASNY@instalacja.example', 'Ktoś'], ['ala@proba.example', 'Ala'],
    ['qa-7@sklep.example', 'Kupiec'], ['kupiec@sklep.example', 'Sklep ATRAPA sp.'], ['kupiec@sklep.example', 'Kupiec'],
    ['ala@proba.example.pl', 'Ala'], ['', ''],
  ];

  it('raporty, import historii i reguły kanałów dają identyczne decyzje dla tego samego env', () => {
    const r = wczytajRaporty(reguly).regulySprzedazy;
    const h = regulyHistorii(reguly);
    const imp = konfiguracjaHistorii({ ...reguly, X_HISTORIA_KONTO_APILO: '21' }, 'sklep', 'X');
    expect([...r.klienciWdt]).toEqual(['wdt@klient.example']);
    expect([...imp.klienciWdt]).toEqual([...r.klienciWdt]);
    const decyzje = probki.map(([e, n]) => r.czyTestowe(e, n));
    expect(decyzje).toEqual([false, true, true, true, true, false, false, false]);
    expect(probki.map(([e, n]) => h.czyTestowe(e, n))).toEqual(decyzje);
    expect(probki.map(([e, n]) => imp.czyTestowe(e, n))).toEqual(decyzje);
  });

  it('alias WDT historii działa w raportach, a sprzeczne listy blokują start aplikacji', async () => {
    expect([...wczytajRaporty({ OMS_HISTORIA_MAILE_WDT: 'wdt@klient.example' }).regulySprzedazy.klienciWdt])
      .toEqual(['wdt@klient.example']);
    const db = openOmsDb();
    try {
      await expect(zbudujOms({ env: { ...env, OMS_KLIENCI_WDT: 'a@klient.example', OMS_HISTORIA_MAILE_WDT: 'b@klient.example' }, db }))
        .rejects.toThrow(/Konflikt OMS_KLIENCI_WDT/);
    } finally { db.close(); }
  });

  // Te same wiersze historii; różni się wyłącznie env. Eksport CSV i statystyki idą przez
  // prawdziwy bootstrap i trasy, więc reguła musi dotrzeć z konfiguracji do każdego zapytania.
  function zasiej(db: any) {
    for (const k of KANALY) ustawGranice(db, k, '2031-07-02', 'fixture-027', null);
    const wiersz = (apiloId: string, numer: string, dzien: string, email: string, nazwa: string) => zapiszHistorie(db, {
      apiloId, platformAccountId: 21, numer, dzien, utworzoneAt: `${dzien}T10:00:00.000Z`, brutto: '246.00',
      tagi: [], status: 15, paymentStatus: 2, klientEmail: email, klientNazwa: nazwa,
      faktura: 0, pozycje: [{ nazwa: 'Produkt fikcyjny', ilosc: 1, bruttoLinii: '246.00', typ: 1 }],
    });
    wiersz('FX-N1', 'N-1', '2031-06-10', 'kupiec@sklep.example', 'Kupiec');
    wiersz('FX-N2', 'N-2', '2031-06-11', 'WDT@klient.example', 'Firma UE');
    wiersz('FX-N3', 'N-3', '2031-06-12', 'qa-7@sklep.example', 'Kupiec');
    wiersz('FX-N4', 'N-4', '2031-06-13', 'kupiec@sklep.example', 'Sklep ATRAPA sp.');
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, klient_json, utworzone_at, indywidualne)"
      + " VALUES ('reczne', 27201, 'N-5', '123.00', ?, '2031-07-10T10:00:00Z', 0)")
      .run(JSON.stringify({ email: 'ala@proba.example' }));
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, klient_json, utworzone_at, indywidualne)"
      + " VALUES ('reczne', 27202, 'N-6', '123.00', ?, '2031-07-11T10:00:00Z', 0)")
      .run(JSON.stringify({ email: 'wdt@klient.example' }));
  }
  const csv = async (z: any) => {
    const odp = await z.app.inject({ method: 'GET', url: '/raporty/eksport.csv?od=2031-06-01&do=2031-07-31', headers });
    expect(odp.statusCode).toBe(200);
    return odp.body.split(CRLF).slice(1);
  };

  it('neutralny env: eksport liczy wszystkie zamówienia z VAT 23%', async () => {
    const db = openOmsDb();
    try {
      zasiej(db);
      await zAplikacja({ ...env, OMS_HISTORIA_KLASYFIKACJA: '{"konta":[{"konto":21,"raport":"RECZNE"}]}' }, db, async (z) => {
        expect(await csv(z)).toEqual([
          '2031-06-10;RECZNE;N-1;Apilo;246,00;200,00;nie;tak',
          '2031-06-11;RECZNE;N-2;Apilo;246,00;200,00;nie;tak',
          '2031-06-12;RECZNE;N-3;Apilo;246,00;200,00;nie;tak',
          '2031-06-13;RECZNE;N-4;Apilo;246,00;200,00;nie;tak',
          '2031-07-10;RECZNE;N-5;OMS;123,00;100,00;nie;nie',
          '2031-07-11;RECZNE;N-6;OMS;123,00;100,00;nie;nie',
        ]);
      });
    } finally { db.close(); }
  });

  it('jawny env: ta sama reguła wycina testowe w obu epokach i zeruje VAT klienta WDT', async () => {
    const db = openOmsDb();
    try {
      zasiej(db);
      await zAplikacja({ ...env, ...reguly, OMS_HISTORIA_KLASYFIKACJA: '{"konta":[{"konto":21,"raport":"RECZNE"}]}' }, db, async (z) => {
        expect(await csv(z)).toEqual([
          '2031-06-10;RECZNE;N-1;Apilo;246,00;200,00;nie;tak',
          '2031-06-11;RECZNE;N-2;Apilo;246,00;246,00;nie;tak',
          '2031-07-11;RECZNE;N-6;OMS;123,00;123,00;nie;nie',
        ]);
        // Statystyki korzystają z tej samej konfiguracji: testowe N-5 nie wchodzi do okresu.
        const config = z.usluga('raporty', 'config') as any;
        const numery = (r: any) => zamowieniaOkresu(db, { od: '2031-07-01', do: '2031-07-31' }, r).map((w: any) => w.numer).sort();
        expect(numery(config.regulySprzedazy)).toEqual(['N-6']);
        expect(numery(undefined)).toEqual(['N-5', 'N-6']);
      });
    } finally { db.close(); }
  });
});

describe('PRZ-027 konfiguracja dat pokrycia i etykiet', () => {
  it('przyjmuje realne dni, także 29 lutego roku przestępnego, i niepuste etykiety', () => {
    const c = wczytajRaporty({ OMS_RAPORTY_PODLOGA_ZWROTOW: ' 2028-02-29 ', OMS_STATYSTYKI_PIERWSZY_DZIEN: '2031-12-31',
      OMS_RAPORTY_DATA_IMPORTU_HISTORII: '2031-01-01', OMS_RAPORTY_SKLEP_HISTORII: ' sklep.example ',
      OMS_RAPORTY_NAZWY_KANALOW: '{"B2B":"Hurt","RECZNE":"Ręczne"}' });
    expect(c).toMatchObject({ podlogaZwrotow: '2028-02-29', pierwszyDzienOms: '2031-12-31',
      dataImportuHistorii: '2031-01-01', nazwaSklepuHistorii: 'sklep.example',
      nazwyKanalow: { B2B: 'Hurt', RECZNE: 'Ręczne' } });
  });

  it.each([
    ['OMS_RAPORTY_PODLOGA_ZWROTOW', '2031-02-29', /niepoprawna data kalendarzowa/],
    ['OMS_RAPORTY_PODLOGA_ZWROTOW', '2031-04-31', /niepoprawna data kalendarzowa/],
    ['OMS_STATYSTYKI_PIERWSZY_DZIEN', '2031-13-01', /niepoprawna data kalendarzowa/],
    ['OMS_STATYSTYKI_PIERWSZY_DZIEN', '2031-7-3', /RRRR-MM-DD/],
    ['OMS_RAPORTY_DATA_IMPORTU_HISTORII', '2031-07-03T00:00:00Z', /RRRR-MM-DD/],
    ['OMS_RAPORTY_DATA_IMPORTU_HISTORII', '03.07.2031', /RRRR-MM-DD/],
  ])('odrzuca %s=%s z nazwą klucza', (klucz, wartosc, wzor) => {
    expect(() => wczytajRaporty({ [klucz]: wartosc })).toThrow(klucz);
    expect(() => wczytajRaporty({ [klucz]: wartosc })).toThrow(wzor);
  });

  it.each(['[]', 'null', '"B2B"', '{"B2B":""}', '{"B2B":"  "}', '{"B2B":1}', '{"B2B":null}', '{B2B:"x"}'])(
    'odrzuca etykiety kanałów %s', (json) => {
      expect(() => wczytajRaporty({ OMS_RAPORTY_NAZWY_KANALOW: json })).toThrow();
    });

  it('błędna data w env zatrzymuje bootstrap, zanim powstanie aplikacja', async () => {
    const db = openOmsDb();
    try {
      await expect(zbudujOms({ env: { ...env, OMS_STATYSTYKI_PIERWSZY_DZIEN: '2031-02-30' }, db }))
        .rejects.toThrow(/OMS_STATYSTYKI_PIERWSZY_DZIEN/);
    } finally { db.close(); }
  });
});

describe('PRZ-027 jawny import danych miesięcznych', () => {
  const wiersz = (miesiac: string, razem = '100.00') =>
    [miesiac, '60.00', '30.00', '10.00', razem, '0.00', '0.00', '1000.00', '400.00', '0.00', null];
  let db: any;
  beforeEach(() => { db = openOmsDb(); });
  afterEach(() => db.close());
  const stan = () => ({ wiersze: ile(db, 'SELECT COUNT(*) AS c FROM dane_miesieczne'), markery: markeryDanych(db) });

  it.each([
    ['bez opcji', undefined],
    ['bez nazwy migracji', { wiersze: [wiersz('2031-01')] }],
    ['pusta nazwa migracji', { nazwaMigracji: '  ', wiersze: [wiersz('2031-01')] }],
    ['bez wierszy', { nazwaMigracji: 'dane-miesieczne/fx' }],
    ['10 pól', { nazwaMigracji: 'dane-miesieczne/fx', wiersze: [wiersz('2031-01').slice(0, 10)] }],
    ['12 pól', { nazwaMigracji: 'dane-miesieczne/fx', wiersze: [[...wiersz('2031-01'), 'nadmiar']] }],
    ['obiekt zamiast krotki', { nazwaMigracji: 'dane-miesieczne/fx', wiersze: [{ miesiac: '2031-01' }] }],
    ['miesiąc 13', { nazwaMigracji: 'dane-miesieczne/fx', wiersze: [wiersz('2031-01'), wiersz('2031-13')] }],
    ['miesiąc bez zera', { nazwaMigracji: 'dane-miesieczne/fx', wiersze: [wiersz('2031-1')] }],
  ])('odmawia %s i niczego nie zapisuje', (_opis, opcje) => {
    expect(() => wgrajDaneStartowe(db, opcje as any)).toThrow();
    expect(stan()).toEqual({ wiersze: 0, markery: 0 });
  });

  it('błąd zapisu w połowie cofa wcześniejsze wiersze i nie stawia znacznika; ponowienie wgrywa komplet raz', () => {
    const zly = wiersz('2031-02'); zly[1] = { nie: 'kwota' } as any;
    expect(() => wgrajDaneStartowe(db, { nazwaMigracji: 'dane-miesieczne/fx', wiersze: [wiersz('2031-01'), zly] })).toThrow();
    expect(stan()).toEqual({ wiersze: 0, markery: 0 });
    expect(db.isTransaction).toBe(false);

    wgrajDaneStartowe(db, { nazwaMigracji: 'dane-miesieczne/fx', wiersze: [wiersz('2031-01'), wiersz('2031-02')] });
    expect(stan()).toEqual({ wiersze: 2, markery: 1 });
    // Znacznik zamyka import: druga próba z innymi kwotami niczego nie zmienia.
    wgrajDaneStartowe(db, { nazwaMigracji: 'dane-miesieczne/fx', wiersze: [wiersz('2031-01', '999.00'), wiersz('2031-03')] });
    expect(stan()).toEqual({ wiersze: 2, markery: 1 });
    expect(daneMiesiaca(db, '2031-01').zus_razem).toBe('100.00');
  });

  it('import nie nadpisuje miesiąca wpisanego wcześniej przez człowieka', () => {
    zapiszDaneMiesiaca(db, '2031-02', { zusRazem: '1 234,56', uwagi: 'wpis operatora' });
    wgrajDaneStartowe(db, { nazwaMigracji: 'dane-miesieczne/fx', wiersze: [wiersz('2031-01'), wiersz('2031-02', '1.00')] });
    const reczny = daneMiesiaca(db, '2031-02');
    expect(reczny.zus_razem).toBe('1234.56');
    expect(reczny.uwagi).toBe('wpis operatora');
    expect(reczny.zus_spoleczne).toBeNull();
    expect(daneMiesiaca(db, '2031-01').zus_razem).toBe('100.00');
    expect(stan()).toEqual({ wiersze: 2, markery: 1 });
  });
});

describe('PRZ-027 zastrzeżenie historii bez konta (F27-1)', () => {
  // Baza ma prawdziwy wiersz Apilo, więc zdanie „nie ma ani jednego wiersza z Apilo” byłoby
  // nieprawdą. Bez OMS_RAPORTY_KONTO_HISTORII granica jest nieznana z braku konfiguracji.
  it('GET /raporty bez konta historii mówi o nieustawionym koncie, nie o braku wierszy Apilo', async () => {
    const db = openOmsDb();
    try {
      for (const k of KANALY) ustawGranice(db, k, '2031-07-02', 'fixture-027', null);
      zapiszHistorie(db, {
        apiloId: 'FX-K1', platformAccountId: 21, numer: 'K-1', dzien: '2031-06-10',
        utworzoneAt: '2031-06-10T10:00:00.000Z', brutto: '246.00', tagi: [], status: 15, paymentStatus: 2,
        klientEmail: 'kupiec@sklep.example', klientNazwa: 'Kupiec', faktura: 0,
        pozycje: [{ nazwa: 'Produkt fikcyjny', ilosc: 1, bruttoLinii: '246.00', typ: 1 }],
      });
      expect(ile(db, "SELECT COUNT(*) AS c FROM sprzedaz_historyczna WHERE zrodlo = 'apilo'")).toBe(1);
      expect(env).not.toHaveProperty('OMS_RAPORTY_KONTO_HISTORII');
      await zAplikacja({ ...env, OMS_HISTORIA_KLASYFIKACJA: '{"konta":[{"konto":21,"raport":"RECZNE"}]}' }, db, async (z) => {
        const odp = await z.app.inject({ method: 'GET', url: '/raporty?od=2031-06-01&do=2031-07-31', headers });
        expect(odp.statusCode).toBe(200);
        expect(odp.body).toContain('Nie ustawiono konta historii');
        expect(odp.body).toContain('OMS_RAPORTY_KONTO_HISTORII');
        expect(odp.body).not.toContain('nie ma ani jednego wiersza z Apilo');
      });
    } finally { db.close(); }
  });
});
