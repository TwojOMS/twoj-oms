// PRZ-182 — reset piaskownicy a poświadczenia zaszyfrowane w bazie (plan 4 p. 7, 3.11 „Reset piaskownicy”).
//  1. zwykły reset: zachowane wiersze Sandbox / Fakturowni przechodzą bajt w bajt (szyfrogram przypięty do klucza
//     głównego, który reset zachowuje) i są czytelne przez warstwę;
//  2. wznowienie z pliku resetu sprzed szyfrowania: jawne wartości po resecie leżą zaszyfrowane i są czytelne;
//  3. niezgodny klucz: odmowa PRZED usunięciem bazy i pliku resetu — oba zostają bajt w bajt, demo nie powstaje;
//  4. znacznik `sekrety.format` w świeżej bazie z generatora: ani generator (otwiera bazę bez zbudujAplikacje),
//     ani import resetu go nie stawiają — stawia go pierwszy start aplikacji (konwersja), bez przepisywania szyfrogramów.
// Wartości zmyślone („Pracownia Półcień”).
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { wykonajMigracje } from '../../src/core/baza.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import { modulKanaly } from '../../src/moduly/kanaly/modul.ts';
import { kopiaResetu, odczytajZlecenieResetu, wykonajZlecenieResetu, zlecResetDemo, znacznikResetuProby } from '../../src/oms/db/reset-demo.js';
import { bajtyKlucza, klasyfikuj, nowyKlucz, przypnijSejf, utworzSejf } from '../../src/core/bezpieczenstwo/sejf-sekretow.js';
import { formatBazy } from '../../src/core/bezpieczenstwo/konwersja-sekretow.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../src/oms/db/konfiguracja-integracji.js';
import { wczytajTokeny, zapiszTokeny } from '../../src/oms/db/tokeny.js';
import { ENV_DEMO, utworzBazeDemo } from '../../scripts/demo-dane.mjs';
import { uruchomPiaskownice } from '../../deploy/proba/atrapy/index.mjs';
import { KLUCZ_TESTOWY, SEJF_TESTOWY } from '../pomoc/sejf-testowy.ts';

const SEKRET_DEVICE = { clientId: 'zmyslony-id-sb', clientSecret: 'zmyslony-sekret-sb' };
const SEKRET_FAKTUROWNI = { token: 'zmyslony-token-polcien-proba-0001' };
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true }); });
const katalog = () => { const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-reset-sekrety-')); katalogi.push(k); return k; };
const inny = () => utworzSejf(bajtyKlucza(nowyKlucz()));

function baza(plik) {
  const db = openOmsDb(plik);
  wykonajMigracje(db, [modulRdzen, modulKanaly]);
  return db;
}
function kanalSandbox(db) {
  db.prepare(`INSERT INTO kanaly_sprzedazy (klucz,nazwa,srodowisko,zrodlo,konto_id,login,raport,autoryzacja,pobieranie,od_utc,
    wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login,typ,aplikacja)
    VALUES ('allegro-sb','Pracownia Półcień Sandbox','sandbox','panel','9001','polcien-sb','allegro-sb','polaczone','wlaczone',
    '2026-11-01T00:00:00Z',3,2,1,'2026-11-01','2026-11-02',7,'adam','allegro','device')`).run();
}
/** Baza piaskownicy w obecnym formacie: sekrety zapisane warstwą (szyfrogramy kluczem `sejf`). */
function bazaZaszyfrowana(plik, sejf = SEJF_TESTOWY) {
  const db = przypnijSejf(baza(plik), sejf);
  try {
    zapiszKonfiguracjeIntegracji(db, 'allegro_aplikacja_device:sandbox', { ustawienia: {}, sekrety: SEKRET_DEVICE });
    zapiszKonfiguracjeIntegracji(db, 'fakturownia', { ustawienia: { domena: 'pracownia-polcien' }, sekrety: SEKRET_FAKTUROWNI });
    kanalSandbox(db);
    zapiszTokeny(db, 'allegro-sb', { accessToken: 'dostep-sb', refreshToken: 'odswiez-sb', wygasaAt: '2026-11-05T00:00:00Z', refreshWygasaAt: '2027-02-01T00:00:00Z' });
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('test', 1, 'STARE-1', '10', '2026-11-10')").run();
  } finally { db.close(); }
}
/** Baza sprzed szyfrowania: sekrety jawne, bez znacznika formatu (surowy SQL — tak pisał stary kod). */
function bazaJawna(plik) {
  const db = baza(plik);
  try {
    db.prepare('INSERT INTO konfiguracja_integracji VALUES (?, ?, ?, ?, ?, ?)')
      .run('allegro_aplikacja_device:sandbox', '{}', JSON.stringify(SEKRET_DEVICE), 7, 'adam', '2026-11-01');
    db.prepare('INSERT INTO konfiguracja_integracji VALUES (?, ?, ?, ?, ?, ?)')
      .run('fakturownia', '{"domena":"pracownia-polcien"}', JSON.stringify(SEKRET_FAKTUROWNI), 7, 'adam', '2026-11-01');
    kanalSandbox(db);
    db.prepare(`INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
      VALUES ('allegro-sb', 'dostep-sb', 'odswiez-sb', '2026-11-05T00:00:00Z', '2027-02-01T00:00:00Z', '2026-11-02')`).run();
  } finally { db.close(); }
}
/** Plik resetu, jaki zapisuje start przed skasowaniem bazy (zlecenie + zachowane wiersze z bazy `plik`). */
function zapiszPlikResetu(plik) {
  const db = new DatabaseSync(plik);
  try {
    zlecResetDemo(db, { login: 'adam' });
    const dane = odczytajZlecenieResetu(db, { zachowajSandbox: true, zachowajFakturownie: true });
    fs.writeFileSync(kopiaResetu(plik), JSON.stringify(dane), { mode: 0o600 });
  } finally { db.close(); }
}
const swiezeDemo = (plik) => vi.fn(async () => {
  const db = baza(plik);
  try { db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('test', 1, 'DEMO-1', '20', '2026-11-12')").run(); }
  finally { db.close(); }
});
const surowe = (plik) => {
  const db = new DatabaseSync(plik, { readOnly: true });
  try {
    return {
      konfiguracja: Object.fromEntries(db.prepare('SELECT integracja, sekrety_json FROM konfiguracja_integracji ORDER BY integracja').all().map(w => [w.integracja, w.sekrety_json])),
      tokeny: db.prepare('SELECT kanal, access_token, refresh_token FROM tokeny_kanalu ORDER BY kanal').all().map(w => ({ ...w })),
    };
  } finally { db.close(); }
};
function czytelne(plik, sejf = SEJF_TESTOWY) {
  const db = przypnijSejf(new DatabaseSync(plik, { readOnly: true }), sejf);
  try {
    return { device: wczytajKonfiguracjeIntegracji(db, 'allegro_aplikacja_device:sandbox')?.sekrety,
      fakturownia: wczytajKonfiguracjeIntegracji(db, 'fakturownia')?.sekrety,
      tokeny: (({ access_token, refresh_token }) => ({ access_token, refresh_token }))(wczytajTokeny(db, 'allegro-sb') ?? {}) };
  } finally { db.close(); }
}
const OCZEKIWANE = { device: SEKRET_DEVICE, fakturownia: SEKRET_FAKTUROWNI, tokeny: { access_token: 'dostep-sb', refresh_token: 'odswiez-sb' } };

describe('PRZ-182 reset piaskownicy z poświadczeniami zaszyfrowanymi', () => {
  it('zwykły reset: zachowane szyfrogramy przechodzą bajt w bajt i są czytelne; demo świeże', async () => {
    const k = katalog(); const plik = path.join(k, 'oms.sqlite');
    bazaZaszyfrowana(plik);
    const przed = surowe(plik);
    fs.writeFileSync(znacznikResetuProby(plik), '2026-11-17T10:00:00Z\n');
    const wynik = await wykonajZlecenieResetu({ baza: plik, utworzBaze: swiezeDemo(plik), sejf: SEJF_TESTOWY, zachowajSandbox: true, zachowajFakturownie: true });
    expect(wynik.sandbox).toEqual({ konfiguracja: 1, kanaly: 1 });
    expect(wynik.fakturownia).toEqual(['fakturownia']);
    const po = surowe(plik);
    expect(po.konfiguracja['allegro_aplikacja_device:sandbox']).toBe(przed.konfiguracja['allegro_aplikacja_device:sandbox']);
    expect(po.konfiguracja.fakturownia).toBe(przed.konfiguracja.fakturownia);
    expect(po.tokeny).toEqual(przed.tokeny);
    expect(czytelne(plik)).toEqual(OCZEKIWANE);
    expect(fs.existsSync(kopiaResetu(plik))).toBe(false);
    const db = new DatabaseSync(plik, { readOnly: true });
    try { expect(db.prepare('SELECT numer FROM zamowienia').all().map(w => w.numer)).toEqual(['DEMO-1']); } finally { db.close(); }
  });

  it('wznowienie z pliku resetu sprzed szyfrowania: jawne wartości po resecie zaszyfrowane i czytelne', async () => {
    const k = katalog(); const plik = path.join(k, 'oms.sqlite');
    bazaJawna(plik);
    zapiszPlikResetu(plik);
    const plikResetu = fs.readFileSync(kopiaResetu(plik), 'utf8');
    expect(plikResetu).toContain(SEKRET_DEVICE.clientSecret); // plik naprawdę ze starego formatu
    // Awaria po skasowaniu bazy: zostaje sam plik resetu.
    for (const p of [plik, `${plik}-wal`, `${plik}-shm`]) fs.rmSync(p, { force: true });
    const utworz = swiezeDemo(plik);
    const wynik = await wykonajZlecenieResetu({ baza: plik, utworzBaze: utworz, sejf: SEJF_TESTOWY, zachowajSandbox: true, zachowajFakturownie: true });
    expect(utworz).toHaveBeenCalledTimes(1);
    expect(wynik.fakturownia).toEqual(['fakturownia']);
    const po = surowe(plik);
    for (const w of Object.values(po.konfiguracja)) expect(klasyfikuj(w, { json: true })).toBe('szyfrogram');
    for (const t of po.tokeny) expect([klasyfikuj(t.access_token), klasyfikuj(t.refresh_token)]).toEqual(['szyfrogram', 'szyfrogram']);
    expect(czytelne(plik)).toEqual(OCZEKIWANE);
    const bajty = fs.readFileSync(plik).toString('latin1');
    for (const jawny of [SEKRET_DEVICE.clientSecret, SEKRET_FAKTUROWNI.token, 'odswiez-sb']) expect(bajty).not.toContain(jawny);
    expect(fs.existsSync(kopiaResetu(plik))).toBe(false);
  });

  it('wznowienie z niezgodnym kluczem: odmowa przed usunięciem bazy i pliku resetu — oba bajt w bajt', async () => {
    const k = katalog(); const plik = path.join(k, 'oms.sqlite');
    bazaZaszyfrowana(plik);
    zapiszPlikResetu(plik);
    const bazaPrzed = fs.readFileSync(plik);
    const plikPrzed = fs.readFileSync(kopiaResetu(plik));
    const utworz = swiezeDemo(plik);
    const blad = await wykonajZlecenieResetu({ baza: plik, utworzBaze: utworz, sejf: inny(), zachowajSandbox: true, zachowajFakturownie: true })
      .then(() => null, (e) => e);
    // Kontrola bazy tym kluczem przed czymkolwiek (BladKonfiguracji z oboma id kluczy).
    expect(blad?.cause?.name).toBe('BladKonfiguracji');
    expect(blad.cause.message).toMatch(/kluczem o id/);
    expect(utworz).not.toHaveBeenCalled();
    expect(fs.readFileSync(plik).equals(bazaPrzed)).toBe(true);
    expect(fs.readFileSync(kopiaResetu(plik)).equals(plikPrzed)).toBe(true);
    // Klucz bieżący (ten z instalacji) dokańcza ten sam reset.
    await wykonajZlecenieResetu({ baza: plik, utworzBaze: swiezeDemo(plik), sejf: SEJF_TESTOWY, zachowajSandbox: true, zachowajFakturownie: true });
    expect(czytelne(plik)).toEqual(OCZEKIWANE);
  });

  it('wznowienie z niezgodnym kluczem bez bazy (awaria po skasowaniu): plik resetu zostaje, demo nie powstaje', async () => {
    const k = katalog(); const plik = path.join(k, 'oms.sqlite');
    bazaZaszyfrowana(plik);
    zapiszPlikResetu(plik);
    for (const p of [plik, `${plik}-wal`, `${plik}-shm`]) fs.rmSync(p, { force: true });
    const plikPrzed = fs.readFileSync(kopiaResetu(plik));
    const utworz = swiezeDemo(plik);
    await expect(wykonajZlecenieResetu({ baza: plik, utworzBaze: utworz, sejf: inny(), zachowajSandbox: true, zachowajFakturownie: true }))
      .rejects.toMatchObject({ cause: { name: 'BladSekretow', kod: 'INNY_KLUCZ' } });
    expect(utworz).not.toHaveBeenCalled();
    expect(fs.existsSync(plik)).toBe(false);
    expect(fs.readFileSync(kopiaResetu(plik)).equals(plikPrzed)).toBe(true);
  });

  it('nowy reset z niezgodnym kluczem: odmowa przed zapisem pliku resetu; baza i jej poświadczenia zostają', async () => {
    const k = katalog(); const plik = path.join(k, 'oms.sqlite');
    bazaZaszyfrowana(plik);
    const przed = surowe(plik);
    fs.writeFileSync(znacznikResetuProby(plik), 'x');
    const utworz = swiezeDemo(plik);
    await expect(wykonajZlecenieResetu({ baza: plik, utworzBaze: utworz, sejf: inny(), zachowajSandbox: true, zachowajFakturownie: true }))
      .rejects.toMatchObject({ cause: { name: 'BladKonfiguracji', message: expect.stringMatching(/kluczem o id/) } });
    expect(utworz).not.toHaveBeenCalled();
    expect(fs.existsSync(kopiaResetu(plik))).toBe(false);
    // Znacznik nie zamienił się w zlecenie w bazie — kontrola klucza była przed pierwszym zapisem.
    expect(fs.existsSync(znacznikResetuProby(plik))).toBe(true);
    const z = new DatabaseSync(plik, { readOnly: true });
    try { expect(odczytajZlecenieResetu(z)).toBeNull(); } finally { z.close(); }
    expect(surowe(plik)).toEqual(przed);
    const db = new DatabaseSync(plik, { readOnly: true });
    try { expect(db.prepare('SELECT numer FROM zamowienia').all().map(w => w.numer)).toEqual(['STARE-1']); } finally { db.close(); }
  });
});

describe('PRZ-182 znacznik formatu w świeżej bazie piaskownicy', () => {
  function srodowisko() {
    const k = katalog();
    return { k, env: { ...ENV_DEMO, OMS_DB_PATH: path.join(k, 'oms.sqlite'), OMS_PORT: '0', OMS_USER: 'serwis-proby',
      OMS_PASS: 'haslo-serwisowe-testu', OMS_PROFORMY_KATALOG: path.join(k, 'proformy'), OMS_ETYKIETY_KATALOG: path.join(k, 'etykiety'),
      OMS_KLUCZ_SEKRETOW: KLUCZ_TESTOWY } };
  }
  const odczyt = (plik, f) => { const db = new DatabaseSync(plik, { readOnly: true }); try { return f(db); } finally { db.close(); } };
  const erli = (db) => db.prepare("SELECT sekrety_json FROM konfiguracja_integracji WHERE integracja LIKE 'erli:%'").get()?.sekrety_json;

  it('generator i import resetu nie stawiają znacznika; stawia go pierwszy start, nie przepisując szyfrogramów', async () => {
    const { env } = srodowisko();
    const plik = env.OMS_DB_PATH;
    // Baza sprzed szyfrowania ze zleceniem resetu (jak `proba.ps1 reset` na starej piaskownicy).
    bazaJawna(plik);
    fs.writeFileSync(znacznikResetuProby(plik), 'x');
    const dzis = '2026-11-17';
    const wynik = await wykonajZlecenieResetu({ baza: plik, sejf: SEJF_TESTOWY, zachowajSandbox: true, zachowajFakturownie: true,
      utworzBaze: async () => {
        await utworzBazeDemo({ baza: plik, dzis, env });
        // Świeża baza z generatora: sekret ERLI już zaszyfrowany warstwą, znacznika formatu jeszcze nie ma.
        odczyt(plik, (db) => {
          expect(formatBazy(db)).toBeNull();
          expect(klasyfikuj(erli(db), { json: true })).toBe('szyfrogram');
        });
      } });
    expect(wynik.fakturownia).toEqual(['fakturownia']);
    // Po imporcie resetu: dalej bez znacznika, przeniesione wiersze zaszyfrowane.
    const poResecie = odczyt(plik, (db) => ({ format: formatBazy(db), erli: erli(db) }));
    expect(poResecie.format).toBeNull();
    const surowePoResecie = surowe(plik);
    for (const w of Object.values(surowePoResecie.konfiguracja)) expect(['pusty', 'szyfrogram']).toContain(klasyfikuj(w, { json: true }));
    // Pierwszy start (uruchomPiaskownice → zbudujAplikacje → konwersja): kontrola przechodzi, znacznik = 1.
    const { zamknij } = await uruchomPiaskownice(env, { host: '127.0.0.1' });
    await zamknij();
    expect(odczyt(plik, formatBazy)).toBe(1);
    const poStarcie = surowe(plik);
    expect(poStarcie.konfiguracja).toEqual(surowePoResecie.konfiguracja);
    // Start dopisuje tokeny atrap kont demo (atrapy/kanaly.mjs) — wiersze sprzed startu zostają bajt w bajt.
    expect(poStarcie.tokeny.filter(t => surowePoResecie.tokeny.some(s => s.kanal === t.kanal))).toEqual(surowePoResecie.tokeny);
    expect(czytelne(plik)).toEqual(OCZEKIWANE);
    // Drugi start z tym samym kluczem — bez zmian; z innym kluczem — odmowa, zanim cokolwiek się zapisze.
    await expect(uruchomPiaskownice({ ...env, OMS_KLUCZ_SEKRETOW: nowyKlucz() }, { host: '127.0.0.1' }))
      .rejects.toMatchObject({ name: 'BladKonfiguracji' });
    expect(surowe(plik)).toEqual(poStarcie);
  }, 120_000);
});
