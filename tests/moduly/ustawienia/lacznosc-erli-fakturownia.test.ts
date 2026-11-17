import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import * as diagnostyka from '../../../src/oms/services/lacznosc.js';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zapiszWyborProgramu } from '../../../src/oms/db/wybor-programu.js';

// Ekran Ustawienia → Łączność ma sprawdzać każdą usługę, z której panel korzysta — także te dodane z panelu:
// sklep ERLI (kreator) i Fakturownię (wybór programu do faktur). Bez nich ekran mówił „Działa 9 z 9”,
// a zamówienia z ERLI albo faktury mogły stać z powodu sieci.

const env = { OMS_TRYB: 'produkcja', OMS_DB_PATH: ':memory:', OMS_USER: 'operator', OMS_PASS: 'atrapa',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const headers = { authorization: 'Basic ' + Buffer.from('operator:atrapa').toString('base64') };
const SEKRET_ERLI = 'sekret-testowy-erli';
const SEKRET_FAKTUROWNI = 'sekret-testowy-fakturowni';
afterEach(() => vi.restoreAllMocks());

function szpieg() {
  return vi.spyOn(diagnostyka, 'sprawdzLacznosc').mockImplementation(async ({ cele }: any) =>
    cele.map((cel: any) => ({ ...cel, ok: true, status: 200, komunikat: '' })));
}

function dodajSklepErli(db: any, klucz: string, nazwa: string, autoryzacja: string) {
  const t = '2026-11-17T12:00:00.000Z';
  db.prepare("INSERT INTO kanaly_sprzedazy(klucz,typ,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login) VALUES (?,'erli',?,'produkcja','panel',?,?,'wlaczone',?,1,1,0,?,?,1,'operator')")
    .run(klucz, nazwa, klucz.toUpperCase(), autoryzacja, t, t, t);
  zapiszKonfiguracjeIntegracji(db, 'erli:' + klucz, {
    ustawienia: { adresApi: 'https://erli.invalid/svc/shop-api' }, sekrety: { kluczApi: SEKRET_ERLI } });
}

it('sklep ERLI z panelu: połączony jest na liście, odłączony znika, klucz API nigdzie nie wychodzi', async () => {
  const pomiar = szpieg();
  const log = vi.fn();
  const a = await zbudujOms({ env, log });
  try {
    await a.app.inject({ url: '/ustawienia/lacznosc', headers });
    expect(pomiar.mock.calls.at(-1)?.[0]?.cele).toEqual([]);

    dodajSklepErli(a.db, 'erli_test1', 'Pracownia na ERLI', 'polaczone');
    const r = await a.app.inject({ url: '/ustawienia/lacznosc', headers });
    expect(r.statusCode).toBe(200);
    expect(pomiar.mock.calls.at(-1)?.[0]?.cele).toEqual([{ klucz: 'erli:erli_test1', nazwa: 'ERLI — Pracownia na ERLI',
      url: 'https://erli.invalid/svc/shop-api', host: 'erli.invalid' }]);
    expect(r.body).toContain('<strong>ERLI — Pracownia na ERLI</strong>');
    expect(r.body).not.toContain(SEKRET_ERLI);
    expect(JSON.stringify(pomiar.mock.calls)).not.toContain(SEKRET_ERLI);
    expect(JSON.stringify(log.mock.calls)).not.toContain(SEKRET_ERLI);

    a.db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='odlaczone' WHERE klucz='erli_test1'").run();
    await a.app.inject({ url: '/ustawienia/lacznosc', headers });
    expect(pomiar.mock.calls.at(-1)?.[0]?.cele).toEqual([]);
  } finally { await a.app.close(); a.db.close(); }
});

it('Fakturownia wybrana w panelu: po restarcie sprawdzany jest host konta, bez tokenu', async () => {
  const katalog = mkdtempSync(join(tmpdir(), 'lacznosc-fakturownia-'));
  const envPlik = { ...env, OMS_DB_PATH: join(katalog, 'oms.sqlite') };
  try {
    const pierwszy = await zbudujOms({ env: envPlik, log: () => {} });
    zapiszKonfiguracjeIntegracji(pierwszy.db, 'fakturownia', {
      ustawienia: { domena: 'pracownia-testowa' }, sekrety: { token: SEKRET_FAKTUROWNI } });
    zapiszWyborProgramu(pierwszy.db, 'fakturownia');
    await pierwszy.app.close(); pierwszy.db.close();

    const pomiar = szpieg();
    const log = vi.fn();
    const a = await zbudujOms({ env: envPlik, log });
    try {
      const r = await a.app.inject({ url: '/ustawienia/lacznosc', headers });
      expect(r.statusCode).toBe(200);
      expect(pomiar.mock.calls.at(-1)?.[0]?.cele).toEqual([{ klucz: 'fakturownia', nazwa: 'Fakturownia',
        url: 'https://pracownia-testowa.fakturownia.pl', host: 'pracownia-testowa.fakturownia.pl' }]);
      expect(r.body).toContain('<strong>Fakturownia</strong>');
      expect(r.body).not.toContain(SEKRET_FAKTUROWNI);
      expect(JSON.stringify(pomiar.mock.calls)).not.toContain(SEKRET_FAKTUROWNI);
      expect(JSON.stringify(log.mock.calls)).not.toContain(SEKRET_FAKTUROWNI);
    } finally { await a.app.close(); a.db.close(); }
  } finally { rmSync(katalog, { recursive: true, force: true }); }
});

it('Fakturownia z pliku konfiguracji: sprawdzany jest host konta z FAKTUROWNIA_DOMENA', async () => {
  const pomiar = szpieg();
  const a = await zbudujOms({ env: { ...env, OMS_PROGRAM_FAKTUROWY: 'fakturownia', FAKTUROWNIA_DOMENA: 'konto-z-pliku',
    FAKTUROWNIA_API_TOKEN: SEKRET_FAKTUROWNI }, log: () => {} });
  try {
    const r = await a.app.inject({ url: '/ustawienia/lacznosc', headers });
    expect(pomiar.mock.calls.at(-1)?.[0]?.cele).toEqual([{ klucz: 'fakturownia', nazwa: 'Fakturownia',
      url: 'https://konto-z-pliku.fakturownia.pl', host: 'konto-z-pliku.fakturownia.pl' }]);
    expect(r.body).not.toContain(SEKRET_FAKTUROWNI);
  } finally { await a.app.close(); a.db.close(); }
});
