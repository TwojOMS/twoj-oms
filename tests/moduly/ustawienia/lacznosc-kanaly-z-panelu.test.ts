import { afterEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import * as diagnostyka from '../../../src/oms/services/lacznosc.js';

// Ekran Ustawienia → Łączność: sklep WooCommerce i konto Allegro dodane z panelu (nie z pliku) też są
// sprawdzane — tylko połączone, pod adresem, z którym łączy się program, bez kluczy i tokenów.

const env = {
  OMS_TRYB: 'produkcja',
  OMS_DB_PATH: ':memory:',
  OMS_USER: 'operator',
  OMS_PASS: 'atrapa',
  OMS_SPRZEDAWCA_NIP: '1234563218',
  OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(),
  OMS_ETYKIETY_KATALOG: tmpdir(),
};
const headers = { authorization: 'Basic ' + Buffer.from('operator:atrapa').toString('base64') };
afterEach(() => vi.restoreAllMocks());

function dodajKanal(db: any, klucz: string, typ: string, nazwa: string, srodowisko: string, autoryzacja: string) {
  const t = '2026-11-17T12:00:00.000Z';
  db.prepare(
    "INSERT INTO kanaly_sprzedazy(klucz,typ,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login) VALUES (?,?,?,?,'panel',?,?,'wlaczone',?,1,1,0,?,?,1,'operator')",
  ).run(klucz, typ, nazwa, srodowisko, klucz.toUpperCase(), autoryzacja, t, t, t);
}

it('sklep Woo i konto Allegro z panelu: połączone są na liście, odłączone znikają', async () => {
  const pomiar = vi
    .spyOn(diagnostyka, 'sprawdzLacznosc')
    .mockImplementation(async ({ cele }: any) =>
      cele.map((cel: any) => ({ ...cel, ok: true, status: 200, komunikat: '' })),
    );
  const a = await zbudujOms({ env, log: () => {} });
  try {
    await a.app.inject({ url: '/ustawienia/lacznosc', headers });
    expect(pomiar.mock.calls.at(-1)?.[0]?.cele).toEqual([]);

    dodajKanal(a.db, 'woo_test1', 'woo', 'Sklep z lampami', 'produkcja', 'polaczone');
    a.db
      .prepare(
        "INSERT INTO kanaly_sklepy(klucz,adres,ustawienia_json,sprawdzono_at,zmieniono_at) VALUES ('woo_test1','https://sklep.invalid','{}',NULL,'2026-11-17T12:00:00.000Z')",
      )
      .run();
    dodajKanal(a.db, 'allegro_panel1', 'allegro', 'Konto testowe', 'sandbox', 'polaczone');

    const r = await a.app.inject({ url: '/ustawienia/lacznosc', headers });
    expect(r.statusCode).toBe(200);
    expect(pomiar.mock.calls.at(-1)?.[0]?.cele).toEqual([
      { klucz: 'sklep:woo_test1', nazwa: 'Sklep Sklep z lampami', url: 'https://sklep.invalid', host: 'sklep.invalid' },
      {
        klucz: 'allegro:allegro_panel1',
        nazwa: 'Allegro — Konto testowe',
        url: 'https://api.allegro.pl.allegrosandbox.pl',
        host: 'api.allegro.pl.allegrosandbox.pl',
      },
    ]);
    expect(r.body).toContain('<strong>Allegro — Konto testowe</strong>');

    a.db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='odlaczone'").run();
    await a.app.inject({ url: '/ustawienia/lacznosc', headers });
    expect(pomiar.mock.calls.at(-1)?.[0]?.cele).toEqual([]);
  } finally {
    await a.app.close();
    a.db.close();
  }
});

// Zasada właściciela (17.11): kanał dodany w konfiguratorze MUSI pojawić się na ekranie Łączność. Strażnik po rejestrze
// typów: nowy typ kanału bez wpisu tutaj (i bez opisu w src/moduly/kanaly/lacznosc-kanalow.ts) = czerwony test.
const KANAL_Z_KONFIGURATORA: Record<string, (db: any) => string> = {
  woo: (db) => {
    dodajKanal(db, 'woo_s1', 'woo', 'Sklep straznika', 'produkcja', 'polaczone');
    db.prepare(
      "INSERT INTO kanaly_sklepy(klucz,adres,ustawienia_json,sprawdzono_at,zmieniono_at) VALUES ('woo_s1','https://straznik.invalid','{}',NULL,'2026-11-17T12:00:00.000Z')",
    ).run();
    return 'sklep:woo_s1';
  },
  allegro: (db) => {
    dodajKanal(db, 'allegro_s1', 'allegro', 'Konto straznika', 'produkcja', 'polaczone');
    return 'allegro:allegro_s1';
  },
  erli: (db) => {
    dodajKanal(db, 'erli_s1', 'erli', 'ERLI straznika', 'produkcja', 'polaczone');
    return 'erli:erli_s1';
  },
};

it('strażnik: każdy typ kanału z rejestru, dodany w konfiguratorze, jest na ekranie Łączność', async () => {
  const { TYPY_KANALOW } = await import('../../../src/domena/moduly-kanalow.ts');
  expect(
    Object.keys(KANAL_Z_KONFIGURATORA).sort(),
    'nowy typ kanału — dopisz go do ekranu Łączność i do tego testu',
  ).toEqual([...TYPY_KANALOW].sort());
  const pomiar = vi.spyOn(diagnostyka, 'sprawdzLacznosc').mockResolvedValue([]);
  const a = await zbudujOms({ env, log: () => {} });
  try {
    const oczekiwane = TYPY_KANALOW.map((typ) => KANAL_Z_KONFIGURATORA[typ](a.db));
    await a.usluga<{ sprawdz: () => Promise<unknown> }>('ustawienia', 'lacznosc').sprawdz();
    const cele = pomiar.mock.calls[0][0]?.cele as { klucz: string; host: string | null }[];
    for (const klucz of oczekiwane) {
      const c = cele.find((x) => x.klucz === klucz);
      expect(c, `brak na ekranie: ${klucz}`).toBeDefined();
      expect(c!.host, `bez adresu: ${klucz}`).toBeTruthy();
    }
  } finally {
    await a.app.close();
    a.db.close();
  }
});

it('konto Allegro z panelu w produkcji sprawdzane pod api.allegro.pl', async () => {
  const pomiar = vi.spyOn(diagnostyka, 'sprawdzLacznosc').mockResolvedValue([]);
  const a = await zbudujOms({ env, log: () => {} });
  try {
    dodajKanal(a.db, 'allegro_panel2', 'allegro', 'Konto główne', 'produkcja', 'polaczone');
    await a.usluga<{ sprawdz: () => Promise<unknown> }>('ustawienia', 'lacznosc').sprawdz();
    expect(pomiar.mock.calls[0][0]?.cele).toEqual([
      {
        klucz: 'allegro:allegro_panel2',
        nazwa: 'Allegro — Konto główne',
        url: 'https://api.allegro.pl',
        host: 'api.allegro.pl',
      },
    ]);
  } finally {
    await a.app.close();
    a.db.close();
  }
});
