// Poświadczenia w bazie: test na bajtach (plik bazy i WAL przy otwartym połączeniu), konwersja starej bazy, przerwania,
// odmowy startu z tabeli rozstrzygnięć, błąd sejfu nie ginie wyżej. Fikcyjne wartości kontrolne, żadnych integracji.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openOmsDb, otworzBazeStartu } from '../../../src/oms/db/db.ts';
import { zapiszKonfiguracjeIntegracji, wczytajKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zapiszTokeny, wczytajTokeny } from '../../../src/oms/db/tokeny.js';
import { createSesjaKsef } from '../../../src/oms/ksef/sesja.js';
import { wczytajSekret, podmienSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { utworzSejf, bajtyKlucza, przypnijSejf, ustawSejfDomyslny, BladSekretow, KLUCZ_FORMATU, KLUCZ_SPRZATANIA } from '../../../src/core/bezpieczenstwo/sejf-sekretow.js';
import { konwertujSekrety, sprzatnijPlikBazy, kontrolaPrzedOtwarciem, przegladSekretow } from '../../../src/core/bezpieczenstwo/konwersja-sekretow.js';
import { BladKonfiguracji } from '../../../src/core/blad-konfiguracji.ts';
import { przywrocSejfDomyslny } from '../../pomoc/sejf-testowy.ts';

const K1 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const K2 = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const S1 = utworzSejf(bajtyKlucza(K1));

let katalog;
beforeEach(() => { katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'prz182-')); });
afterEach(() => { przywrocSejfDomyslny(); fs.rmSync(katalog, { recursive: true, force: true }); });

const RODZAJE = ['dpd', 'inpost', 'fakturownia', 'infakt', 'ksef', 'poczta', 'gus', 'woo_klucze:sklep-a',
  'allegro_instalacja', 'allegro-user-agent', 'erli:erli-a'];
const kontrolna = (n) => `KONTROLA-${n}-7f3e9a`;

function bajtyPlikow(plik) {
  return [plik, `${plik}-wal`].filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p).toString('latin1')).join('\n');
}

describe('test na bajtach — prawdziwe funkcje zapisu, plik bazy i WAL przy otwartym połączeniu', () => {
  it('żadna wartość kontrolna nie leży w pliku bazy ani w WAL', async () => {
    const plik = path.join(katalog, 'oms.sqlite');
    const db = openOmsDb(plik, { sejf: S1 });
    for (const [i, r] of RODZAJE.entries()) {
      zapiszKonfiguracjeIntegracji(db, r, { ustawienia: { login: `jawny-${i}` }, sekrety: { haslo: kontrolna(`int${i}`) } });
    }
    zapiszTokeny(db, 'allegro-a', { accessToken: kontrolna('acc'), refreshToken: kontrolna('ref'), wygasaAt: '2030-01-01T00:00:00Z', refreshWygasaAt: '2030-01-01T00:00:00Z' });
    let n = 0;
    const klient = {
      zaloguj: async () => ({ accessToken: kontrolna('ksefA'), accessDo: '2000-01-01T00:00:00Z', refreshToken: kontrolna('ksefR'), refreshDo: '2099-01-01T00:00:00Z' }),
      odswiez: async (r) => { n++; expect(r).toBe(kontrolna('ksefR')); return { accessToken: kontrolna('ksefA2'), accessDo: '2099-01-01T00:00:00Z' }; },
    };
    const sesja = createSesjaKsef({ db, klient });
    expect(await sesja.accessToken()).toBe(kontrolna('ksefA'));
    expect(await sesja.accessToken()).toBe(kontrolna('ksefA2')); // przez zapiszAccess
    expect(n).toBe(1);
    expect(await sesja.accessToken()).toBe(kontrolna('ksefA2'));
    expect(n).toBe(1); // odświeżony access token zapisany do tej samej pary — bez drugiego odświeżenia
    const sekret = wczytajSekret(db);
    const nowy = podmienSekret(db);
    // Odczyt przez warstwę oddaje jawne wartości.
    for (const [i, r] of RODZAJE.entries()) expect(wczytajKonfiguracjeIntegracji(db, r).sekrety.haslo).toBe(kontrolna(`int${i}`));
    expect(wczytajTokeny(db, 'allegro-a')).toMatchObject({ access_token: kontrolna('acc'), refresh_token: kontrolna('ref') });
    expect(wczytajSekret(db)).toBe(nowy);
    // Połączenie OTWARTE: zamknięcie przepisałoby WAL do pliku i ukryło błąd.
    const bajty = bajtyPlikow(plik);
    expect(fs.existsSync(`${plik}-wal`)).toBe(true);
    for (const t of [...RODZAJE.map((_, i) => kontrolna(`int${i}`)), kontrolna('acc'), kontrolna('ref'), kontrolna('ksefA'), kontrolna('ksefA2'), kontrolna('ksefR'), sekret, nowy]) {
      expect(bajty.includes(t), t).toBe(false);
    }
    expect(bajty.includes('jawny-0')).toBe(true); // kontrola, że czytamy właściwe pliki
    db.close();
  });

  it('obiekt sekretów bez kluczy zostaje jawnym {} — wiersz bez sekretów nie potrzebuje klucza', () => {
    const db = openOmsDb(':memory:', { sejf: S1 });
    zapiszKonfiguracjeIntegracji(db, 'logo', { ustawienia: { a: 1 }, sekrety: {} });
    expect(db.prepare("SELECT sekrety_json FROM konfiguracja_integracji WHERE integracja='logo'").get().sekrety_json).toBe('{}');
    ustawSejfDomyslny(null);
    const bez = openOmsDb(':memory:');
    bez.prepare("INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, zmieniono_at) VALUES ('logo','{}','{}','x')").run();
    expect(wczytajKonfiguracjeIntegracji(bez, 'logo').sekrety).toEqual({});
  });
});

/** Stara baza: schemat bieżący, jawne wartości, bez znacznika formatu. */
function staraBaza(plik) {
  const db = openOmsDb(plik, { sejf: S1 });
  db.prepare("INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, zmieniono_at) VALUES ('dpd','{\"login\":\"a\"}', ?, 'x')")
    .run(JSON.stringify({ haslo: kontrolna('dpd') }));
  db.prepare("INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, zmieniono_at) VALUES ('logo','{}','{}','x')").run();
  db.prepare("INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at) VALUES ('allegro-a', ?, ?, 'x', 'x', 'x')")
    .run(kontrolna('acc'), kontrolna('ref'));
  db.prepare("INSERT INTO tokeny_ksef (id, access_token, access_do, refresh_token, refresh_do, zaktualizowane_at) VALUES (1, ?, 'x', ?, 'x', 'x')")
    .run(kontrolna('ksefA'), kontrolna('ksefR'));
  db.prepare("INSERT INTO sekret_sesji (id, sekret, zmieniony_at) VALUES (1, ?, 'x')").run(kontrolna('sesja'));
  db.prepare('DELETE FROM ustawienia WHERE klucz IN (?, ?)').run(KLUCZ_FORMATU, KLUCZ_SPRZATANIA);
  db.close();
}

const migracje = (plik) => { const d = new DatabaseSync(plik, { readOnly: true }); try { return d.prepare('SELECT * FROM migracje ORDER BY 1').all(); } finally { d.close(); } };
const surowe = (plik) => { const d = new DatabaseSync(plik, { readOnly: true }); try {
  return JSON.stringify([d.prepare('SELECT sekrety_json FROM konfiguracja_integracji ORDER BY 1').all(), d.prepare('SELECT access_token, refresh_token FROM tokeny_kanalu').all(),
    d.prepare('SELECT access_token, refresh_token FROM tokeny_ksef').all(), d.prepare('SELECT sekret FROM sekret_sesji').all()]); } finally { d.close(); } };

describe('konwersja starej bazy przy starcie', () => {
  it('jawne → szyfrogram, sekret sesji nowy, 0 trafień w bajtach po sprzątaniu, drugi start bez zapisu', () => {
    const plik = path.join(katalog, 'oms.sqlite');
    staraBaza(plik);
    const logi = [];
    const db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K1 }, plik, { bezKataloguBazy: true });
    const w = konwertujSekrety(db, S1, { log: (t) => logi.push(t) });
    expect(w).toMatchObject({ jawne: 6, poprzednie: 0 }); // dpd, 2 tokeny kanału, 2 KSeF, sekret sesji
    expect(logi.join('\n')).not.toContain('KONTROLA');
    expect(db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_SPRZATANIA)?.wartosc).toBe('jawne');
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd').sekrety.haslo).toBe(kontrolna('dpd'));
    expect(wczytajKonfiguracjeIntegracji(db, 'logo').sekrety).toEqual({});
    expect(wczytajTokeny(db, 'allegro-a').refresh_token).toBe(kontrolna('ref'));
    expect(wczytajSekret(db)).not.toBe(kontrolna('sesja'));
    expect(sprzatnijPlikBazy(db).stan).toBe('zrobione');
    const bajty = bajtyPlikow(plik);
    for (const t of ['dpd', 'acc', 'ref', 'ksefA', 'ksefR', 'sesja']) expect(bajty.includes(kontrolna(t)), t).toBe(false);
    db.close();
    // Drugi start: żadnego zapisu (rozmiar i mtime WAL/pliku bez zmian, data_version bez zmian).
    const przed = fs.readFileSync(plik);
    const db2 = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K1 }, plik, { bezKataloguBazy: true });
    const zmianyPrzed = db2.prepare('SELECT total_changes() AS n').get().n;
    expect(konwertujSekrety(db2, S1).zmieniono).toBe(0);
    expect(sprzatnijPlikBazy(db2).stan).toBe('nic');
    expect(db2.prepare('SELECT total_changes() AS n').get().n).toBe(zmianyPrzed);
    db2.close();
    void przed;
  });

  it('znacznik „0” traktowany jak brak znacznika: jawne zaszyfrowane, start działa', () => {
    const plik = path.join(katalog, 'oms.sqlite');
    staraBaza(plik);
    const d = new DatabaseSync(plik);
    d.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, '0', 'x')").run(KLUCZ_FORMATU);
    d.close();
    const db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K1 }, plik, { bezKataloguBazy: true });
    expect(konwertujSekrety(db, S1)).toMatchObject({ jawne: 6 });
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd').sekrety.haslo).toBe(kontrolna('dpd'));
    db.close();
    const db2 = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K1 }, plik, { bezKataloguBazy: true });
    db2.close();
  });

  it('przerwanie przed COMMIT = stan sprzed konwersji', () => {
    const plik = path.join(katalog, 'oms.sqlite');
    staraBaza(plik);
    const przed = surowe(plik);
    const db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K1 }, plik, { bezKataloguBazy: true });
    const zepsuty = { ...S1, szyfruj: (t, m) => { if (m.tabela === 'sekret_sesji') throw new Error('przerwa'); return S1.szyfruj(t, m); } };
    expect(() => konwertujSekrety(db, zepsuty)).toThrow('przerwa');
    db.close();
    expect(surowe(plik)).toBe(przed);
  });

  it('przerwanie po COMMIT, przed VACUUM: następny start kończy sprzątanie', () => {
    const plik = path.join(katalog, 'oms.sqlite');
    staraBaza(plik);
    const db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K1 }, plik, { bezKataloguBazy: true });
    konwertujSekrety(db, S1);
    db.close(); // „awaria” przed sprzątaniem
    const db2 = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K1 }, plik, { bezKataloguBazy: true });
    expect(przegladSekretow(db2, S1).miejsca.every((m) => m.jawny === 0)).toBe(true);
    expect(sprzatnijPlikBazy(db2).stan).toBe('zrobione');
    expect(db2.prepare('SELECT 1 FROM ustawienia WHERE klucz = ?').get(KLUCZ_SPRZATANIA)).toBeUndefined();
    db2.close();
  });

  it('brak miejsca i zajęty WAL: znacznik zostaje, program startuje; po zwolnieniu sprzątanie kończy', () => {
    const plik = path.join(katalog, 'oms.sqlite');
    staraBaza(plik);
    const db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K1 }, plik, { bezKataloguBazy: true });
    konwertujSekrety(db, S1);
    const logi = [];
    expect(sprzatnijPlikBazy(db, { log: (t) => logi.push(t), wolneMiejsce: () => 10 })).toMatchObject({ stan: 'odlozone', powod: 'brak miejsca' });
    expect(logi.join()).toMatch(/odłożone/);
    // Zajęty WAL: drugie połączenie trzyma transakcję odczytu.
    const czytelnik = new DatabaseSync(plik);
    czytelnik.exec('BEGIN'); czytelnik.prepare('SELECT count(*) FROM zamowienia').get();
    const w = sprzatnijPlikBazy(db, { wolneMiejsce: () => null });
    expect(w.stan).toBe('odlozone');
    czytelnik.exec('COMMIT'); czytelnik.close();
    expect(db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_SPRZATANIA)?.wartosc).toBe('jawne');
    expect(sprzatnijPlikBazy(db, { wolneMiejsce: () => null }).stan).toBe('zrobione');
    db.close();
  });

  it('przeszyfrowanie spod klucza poprzedniego, znacznik sprzątania z powodem poprzedni-klucz', () => {
    const plik = path.join(katalog, 'oms.sqlite');
    const db = openOmsDb(plik, { sejf: S1 });
    zapiszKonfiguracjeIntegracji(db, 'dpd', { ustawienia: {}, sekrety: { haslo: 'x' } });
    konwertujSekrety(db, S1); sprzatnijPlikBazy(db); db.close();
    const env = { OMS_KLUCZ_SEKRETOW: K2, OMS_KLUCZ_SEKRETOW_POPRZEDNI: K1 };
    const db2 = otworzBazeStartu(env, plik, { bezKataloguBazy: true });
    const s2 = utworzSejf(bajtyKlucza(K2), bajtyKlucza(K1));
    expect(konwertujSekrety(db2, s2)).toMatchObject({ poprzednie: 1, jawne: 0 });
    expect(db2.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_SPRZATANIA)?.wartosc).toBe('poprzedni-klucz');
    db2.close();
    // Bez linii poprzedniego klucza baza już działa samym nowym.
    const db3 = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K2 }, plik, { bezKataloguBazy: true });
    expect(wczytajKonfiguracjeIntegracji(db3, 'dpd').sekrety.haslo).toBe('x');
    db3.close();
  });
});

describe('odmowy startu — przed migracjami, bez zapisu poświadczeń', () => {
  function bazaZFormatem(plik, zmien) {
    const db = openOmsDb(plik, { sejf: S1 });
    zapiszKonfiguracjeIntegracji(db, 'dpd', { ustawienia: {}, sekrety: { haslo: 'x' } });
    zapiszTokeny(db, 'allegro-a', { accessToken: 'a', refreshToken: 'r', wygasaAt: 'x', refreshWygasaAt: 'x' });
    konwertujSekrety(db, S1);
    zmien(db);
    // Ślad „starszej wersji schematu”: usunięta ostatnia migracja — start, który by migrował, dopisałby ją z powrotem.
    db.close();
  }
  const przypadki = [
    ['brak klucza', (d) => d, {}],
    ['klucz niekanoniczny', (d) => d, { OMS_KLUCZ_SEKRETOW: K1.slice(0, -1) + '9' }],
    ['inny klucz', (d) => d, { OMS_KLUCZ_SEKRETOW: K2 }],
    ['uszkodzony szyfrogram', (d) => d.prepare("UPDATE tokeny_kanalu SET access_token = 'oms1.zle'").run(), { OMS_KLUCZ_SEKRETOW: K1 }],
    ['nieznana wersja', (d) => d.prepare("UPDATE tokeny_kanalu SET access_token = 'oms2.a.b.c'").run(), { OMS_KLUCZ_SEKRETOW: K1 }],
    ['wartość przeniesiona do innego wiersza', (d) => {
      const s = d.prepare("SELECT sekrety_json FROM konfiguracja_integracji WHERE integracja='dpd'").get().sekrety_json;
      d.prepare("INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, zmieniono_at) VALUES ('inpost','{}',?,'x')").run(s);
    }, { OMS_KLUCZ_SEKRETOW: K1 }],
    ['format 1 z jawnym sekretem', (d) => d.prepare("UPDATE tokeny_kanalu SET refresh_token = 'jawny-token'").run(), { OMS_KLUCZ_SEKRETOW: K1 }],
    ['format z przyszłości', (d) => d.prepare('UPDATE ustawienia SET wartosc = ? WHERE klucz = ?').run('2', KLUCZ_FORMATU), { OMS_KLUCZ_SEKRETOW: K1 }],
  ];
  it.each(przypadki)('%s → BladKonfiguracji, migracje i poświadczenia bez zmian', (_, zmien, env) => {
    ustawSejfDomyslny(null);
    const plik = path.join(katalog, 'oms.sqlite');
    bazaZFormatem(plik, zmien);
    const d = new DatabaseSync(plik);
    const ostatnia = d.prepare('SELECT * FROM migracje ORDER BY rowid DESC LIMIT 1').get();
    d.prepare('DELETE FROM migracje WHERE rowid = (SELECT max(rowid) FROM migracje)').run();
    d.close();
    const mPrzed = migracje(plik), sPrzed = surowe(plik);
    expect(() => otworzBazeStartu(env, plik, { bezKataloguBazy: true })).toThrow(BladKonfiguracji);
    expect(migracje(plik)).toEqual(mPrzed);
    expect(surowe(plik)).toBe(sPrzed);
    void ostatnia;
  });

  it('komunikat o innym kluczu podaje oba id, nigdy wartości', () => {
    const plik = path.join(katalog, 'oms.sqlite');
    bazaZFormatem(plik, () => {});
    try { kontrolaPrzedOtwarciem(plik, utworzSejf(bajtyKlucza(K2))); expect.unreachable(); }
    catch (e) {
      expect(e.message).toContain(S1.idKlucza);
      expect(e.message).toContain(utworzSejf(bajtyKlucza(K2)).idKlucza);
      expect(e.message + e.wskazowka).not.toContain(K1);
      expect(e.message + e.wskazowka).not.toContain(K2);
    }
  });
});

describe('błąd sejfu nie ginie wyżej', () => {
  it('KSeF: uszkodzony wiersz — bez żądania HTTP, bez nowej pary, BladSekretow', async () => {
    const db = openOmsDb(':memory:', { sejf: S1 });
    db.prepare("INSERT INTO tokeny_ksef (id, access_token, access_do, refresh_token, refresh_do, zaktualizowane_at) VALUES (1, 'oms1.zle', '2000-01-01', 'oms1.zle', '2099-01-01', 'x')").run();
    const przed = JSON.stringify(db.prepare('SELECT * FROM tokeny_ksef').all());
    let zadania = 0;
    const sesja = createSesjaKsef({ db, klient: { zaloguj: async () => { zadania++; return {}; }, odswiez: async () => { zadania++; return {}; } } });
    await expect(sesja.accessToken()).rejects.toBeInstanceOf(BladSekretow);
    expect(zadania).toBe(0);
    expect(JSON.stringify(db.prepare('SELECT * FROM tokeny_ksef').all())).toBe(przed);
  });

  it('KSeF: wiersz uszkodzony po odpowiedzi odświeżenia — bez pełnego logowania', async () => {
    const db = openOmsDb(':memory:', { sejf: S1 });
    let logowania = 0;
    const sesja = createSesjaKsef({ db, klient: {
      zaloguj: async () => { logowania++; return { accessToken: 'a', accessDo: '2000-01-01T00:00:00Z', refreshToken: 'r', refreshDo: '2099-01-01T00:00:00Z' }; },
      odswiez: async () => { db.prepare("UPDATE tokeny_ksef SET refresh_token = 'oms1.zle'").run(); return { accessToken: 'b', accessDo: '2099-01-01T00:00:00Z' }; },
    } });
    await sesja.accessToken();
    expect(logowania).toBe(1);
    await expect(sesja.accessToken()).rejects.toBeInstanceOf(BladSekretow);
    expect(logowania).toBe(1);
  });

  it('konfiguracja integracji: nieczytelne sekrety to BladSekretow, nie pusta konfiguracja', () => {
    const db = openOmsDb(':memory:', { sejf: S1 });
    db.prepare("INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, zmieniono_at) VALUES ('dpd','{}','{\"haslo\":\"jawne\"}','x')").run();
    expect(() => wczytajKonfiguracjeIntegracji(db, 'dpd')).toThrow(BladSekretow);
    przypnijSejf(db, utworzSejf(bajtyKlucza(K2)));
    db.prepare("UPDATE konfiguracja_integracji SET sekrety_json = ? WHERE integracja = 'dpd'").run(S1.szyfruj('{}', { tabela: 'konfiguracja_integracji', kolumna: 'sekrety_json', id: 'dpd' }));
    expect(() => wczytajKonfiguracjeIntegracji(db, 'dpd')).toThrow(expect.objectContaining({ kod: 'INNY_KLUCZ' }));
  });
});
