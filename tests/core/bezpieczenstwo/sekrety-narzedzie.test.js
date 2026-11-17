// scripts/sekrety.mjs — narzędzie poświadczeń: stan bez klucza na pliku kopii, sprawdzenie zgodności klucza,
// klucz-zapewnij, odszyfruj (1 → 0), porzuć (podgląd, potwierdzenie, utrata klucza), sprzątaj; dwie wymiany klucza.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uruchom, kluczZPliku } from '../../../scripts/sekrety.mjs';
import { openOmsDb, otworzBazeStartu } from '../../../src/oms/db/db.ts';
import { zapiszKonfiguracjeIntegracji, wczytajKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zapiszTokeny } from '../../../src/oms/db/tokeny.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { utworzSejf, bajtyKlucza, idKlucza, KLUCZ_FORMATU, KLUCZ_SPRZATANIA } from '../../../src/core/bezpieczenstwo/sejf-sekretow.js';
import { konwertujSekrety, sprzatnijPlikBazy } from '../../../src/core/bezpieczenstwo/konwersja-sekretow.js';

const K1 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const K2 = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const K3 = 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8';
const id = (k) => idKlucza(bajtyKlucza(k));

let kat;
beforeEach(() => { kat = fs.mkdtempSync(path.join(os.tmpdir(), 'prz182-sekrety-')); });
afterEach(() => fs.rmSync(kat, { recursive: true, force: true }));

function cli(argv, env = {}) {
  const linie = [];
  const kod = uruchom(argv, env, (t) => linie.push(t));
  return { kod, wyjscie: linie.join('\n') };
}

/** Baza z poświadczeniami zaszyfrowanymi kluczem `k` (format 1, po sprzątaniu). */
function baza(plik, k, haslo = 'TAJNE-dpd') {
  const s = utworzSejf(bajtyKlucza(k));
  const db = openOmsDb(plik, { sejf: s });
  zapiszKonfiguracjeIntegracji(db, 'dpd', { ustawienia: { login: 'a' }, sekrety: { haslo } });
  zapiszTokeny(db, 'allegro-a', { accessToken: 'TAJNE-acc', refreshToken: 'TAJNE-ref', wygasaAt: 'x', refreshWygasaAt: 'x' });
  wczytajSekret(db);
  konwertujSekrety(db, s); sprzatnijPlikBazy(db);
  db.close();
  return plik;
}

describe('stan i sprawdz', () => {
  it('stan bez klucza podaje wymagane id z samej kopii, bez wartości', () => {
    const plik = baza(path.join(kat, 'oms.sqlite'), K1);
    const kopia = path.join(kat, 'kopia.sqlite');
    const d = new DatabaseSync(plik); d.exec(`VACUUM INTO '${kopia}'`); d.close();
    const { kod, wyjscie } = cli(['stan', '--baza', kopia]);
    expect(kod).toBe(0);
    expect(wyjscie).toContain(`wymagane id kluczy: ${id(K1)}`);
    expect(wyjscie).toMatch(/format: 1/);
    expect(wyjscie).not.toMatch(/TAJNE|AAEC/);
  });
  it('sprawdz: KLUCZ_ZGODNY z właściwym kluczem, KLUCZ_NIEZGODNY z innym — z oboma id', () => {
    const plik = baza(path.join(kat, 'oms.sqlite'), K1);
    expect(cli(['sprawdz', '--baza', plik], { OMS_KLUCZ_SEKRETOW: K1 })).toMatchObject({ kod: 0, wyjscie: expect.stringContaining('KLUCZ_ZGODNY') });
    const zly = cli(['sprawdz', '--baza', plik], { OMS_KLUCZ_SEKRETOW: K2 });
    expect(zly.kod).toBe(1);
    expect(zly.wyjscie).toContain(`KLUCZ_NIEZGODNY: kopia wymaga id ${id(K1)}, podano id ${id(K2)}`);
    expect(zly.wyjscie).not.toMatch(/TAJNE|AAEC|ICEi/);
  });
  it('złe użycie = kod 2', () => {
    expect(cli(['nieznane']).kod).toBe(2);
    expect(cli(['sprawdz']).kod).toBe(2);
  });
});

describe('klucz-zapewnij', () => {
  it('brak pliku i baza bez szyfrogramów → nowy klucz 600, wypisane tylko id; drugi raz — ten sam', () => {
    const plik = path.join(kat, 'config', 'klucz.env');
    const a = cli(['klucz-zapewnij', '--plik', plik]);
    expect(a.kod).toBe(0);
    const b = kluczZPliku(plik);
    expect(b).toHaveLength(32);
    expect(a.wyjscie).toBe(`KLUCZ_UTWORZONY id ${idKlucza(b)}`);
    if (process.platform !== 'win32') expect(fs.statSync(plik).mode & 0o777).toBe(0o600);
    const tresc = fs.readFileSync(plik, 'utf8');
    expect(cli(['klucz-zapewnij', '--plik', plik]).wyjscie).toBe(`KLUCZ_ISTNIEJE id ${idKlucza(b)}`);
    expect(fs.readFileSync(plik, 'utf8')).toBe(tresc);
  });
  it('pusty albo ucięty plik = odmowa, plik bez zmian', () => {
    const plik = path.join(kat, 'klucz.env');
    for (const t of ['', 'OMS_KLUCZ_SEKRETOW=', `OMS_KLUCZ_SEKRETOW=${K1.slice(0, 20)}`]) {
      fs.writeFileSync(plik, t);
      const w = cli(['klucz-zapewnij', '--plik', plik]);
      expect(w.kod).toBe(1);
      expect(w.wyjscie).toMatch(/ODMOWA/);
      expect(fs.readFileSync(plik, 'utf8')).toBe(t);
    }
  });
  it('plik tymczasowy osierocony przez poprzednią próbę (np. pełny dysk) nie blokuje zapisu klucza', () => {
    const plik = path.join(kat, 'klucz.env');
    fs.writeFileSync(path.join(kat, '.klucz.env.1.tmp'), '');
    fs.writeFileSync(path.join(kat, `.klucz.env.${process.pid}.tmp`), '');
    const w = cli(['klucz-zapewnij', '--plik', plik]);
    expect(w.kod).toBe(0);
    expect(w.wyjscie).toMatch(/^KLUCZ_UTWORZONY id [0-9a-f]{8}$/);
  });
  it('klucz.env czytany ściśle: cudzysłowy, dwie linie klucza albo CR = odmowa (compose i docker czytają je różnie)', () => {
    const plik = path.join(kat, 'klucz.env');
    for (const t of [`OMS_KLUCZ_SEKRETOW="${K1}"\n`, `OMS_KLUCZ_SEKRETOW=${K1}\nOMS_KLUCZ_SEKRETOW=${K2}\n`, `OMS_KLUCZ_SEKRETOW=${K1}\r\n`, `OMS_KLUCZ_SEKRETOW = ${K1}\n`, `OMS_KLUCZ_SEKRETOW= ${K1}\n`]) {
      fs.writeFileSync(plik, t);
      expect(kluczZPliku(plik), JSON.stringify(t)).toBeNull();
      expect(cli(['klucz-zapewnij', '--plik', plik]).kod).toBe(1);
    }
    fs.writeFileSync(plik, `# komentarz\nOMS_KLUCZ_SEKRETOW=${K1}\nOMS_KLUCZ_SEKRETOW_POPRZEDNI=${K2}\n`);
    expect(kluczZPliku(plik)?.toString('base64url')).toBe(K1);
  });
  it('stan przy złym kluczu w env działa jak bez klucza', () => {
    const plik = baza(path.join(kat, 'oms.sqlite'), K1);
    const w = cli(['stan', '--baza', plik], { OMS_KLUCZ_SEKRETOW: 'zly' });
    expect(w.kod).toBe(0);
    expect(w.wyjscie).toContain(`wymagane id kluczy: ${id(K1)}`);
    expect(w.wyjscie).not.toContain('zly');
  });
  it('brak pliku, a baza ma szyfrogramy → odmowa bez generowania', () => {
    const b = baza(path.join(kat, 'oms.sqlite'), K1);
    const plik = path.join(kat, 'klucz.env');
    const w = cli(['klucz-zapewnij', '--plik', plik, '--baza', b]);
    expect(w.kod).toBe(1);
    expect(w.wyjscie).toContain(id(K1));
    expect(fs.existsSync(plik)).toBe(false);
  });
});

describe('odszyfruj (format 1 → 0)', () => {
  it('jawne wartości wracają, znacznik znika, powtórzenie = sukces bez zmian; uszkodzony = odmowa bez częściowego zapisu', () => {
    const plik = baza(path.join(kat, 'oms.sqlite'), K1);
    expect(cli(['odszyfruj', '--baza', plik], { OMS_KLUCZ_SEKRETOW: K1 }).kod).toBe(0);
    const d = new DatabaseSync(plik);
    expect(JSON.parse(d.prepare("SELECT sekrety_json FROM konfiguracja_integracji WHERE integracja='dpd'").get().sekrety_json).haslo).toBe('TAJNE-dpd');
    expect(d.prepare('SELECT 1 FROM ustawienia WHERE klucz = ?').get(KLUCZ_FORMATU)).toBeUndefined();
    d.close();
    expect(cli(['odszyfruj', '--baza', plik], {}).wyjscie).toContain('ODSZYFROWANE wartości: 0');
    const plik2 = baza(path.join(kat, 'b.sqlite'), K1);
    const d2 = new DatabaseSync(plik2);
    d2.prepare("UPDATE tokeny_kanalu SET refresh_token = 'oms1.zle'").run();
    const przed = d2.prepare("SELECT sekrety_json FROM konfiguracja_integracji WHERE integracja='dpd'").get().sekrety_json;
    d2.close();
    expect(cli(['odszyfruj', '--baza', plik2], { OMS_KLUCZ_SEKRETOW: K1 }).kod).toBe(1);
    const d3 = new DatabaseSync(plik2);
    expect(d3.prepare("SELECT sekrety_json FROM konfiguracja_integracji WHERE integracja='dpd'").get().sekrety_json).toBe(przed);
    d3.close();
  });
  it('baza bez tabel = sukces bez zmian', () => {
    const plik = path.join(kat, 'pusta.sqlite'); new DatabaseSync(plik).close();
    expect(cli(['odszyfruj', '--baza', plik], {}).kod).toBe(0);
  });
});

describe('porzuc', () => {
  it('podgląd, potem usunięcie tylko wskazanych poświadczeń; ustawienia zostają', () => {
    const plik = baza(path.join(kat, 'oms.sqlite'), K1);
    const d = new DatabaseSync(plik);
    d.prepare("UPDATE konfiguracja_integracji SET sekrety_json = 'oms1.zle' WHERE integracja='dpd'").run();
    d.close();
    const podglad = cli(['porzuc', '--baza', plik], { OMS_KLUCZ_SEKRETOW: K1 });
    expect(podglad.wyjscie).toContain('integracja:dpd');
    expect(podglad.wyjscie).not.toContain('kanal:allegro-a');
    expect(cli(['porzuc', '--baza', plik, '--potwierdz', 'kanal:allegro-a'], { OMS_KLUCZ_SEKRETOW: K1 }).kod).toBe(1);
    expect(cli(['porzuc', '--baza', plik, '--potwierdz', 'integracja:dpd'], { OMS_KLUCZ_SEKRETOW: K1 }).kod).toBe(0);
    const db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K1 }, plik, { bezKataloguBazy: true });
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd')).toMatchObject({ ustawienia: { login: 'a' }, sekrety: {} });
    db.close();
  });
  it('utrata klucza: --nowy-klucz zapisuje nowy plik, porzuca nieczytelne, sekret sesji nowym kluczem; baza startuje', () => {
    const plik = baza(path.join(kat, 'oms.sqlite'), K1);
    const kluczPlik = path.join(kat, 'klucz.env');
    expect(cli(['porzuc', '--baza', plik, '--nowy-klucz', '--plik', kluczPlik]).kod).toBe(2); // bez potwierdzenia
    expect(fs.existsSync(kluczPlik)).toBe(false);
    // Podgląd po utracie klucza działa bez klucza: każde zaszyfrowane jest nieczytelne.
    expect(cli(['porzuc', '--baza', plik]).wyjscie).toMatch(/bez klucza.*integracja:dpd.*kanal:allegro-a.*sesja/);
    // Zła nazwa: odmowa, zanim powstanie nowy plik klucza.
    expect(cli(['porzuc', '--baza', plik, '--nowy-klucz', '--plik', kluczPlik, '--potwierdz', 'integracja:nie-ma']).kod).toBe(1);
    expect(fs.existsSync(kluczPlik)).toBe(false);
    const w = cli(['porzuc', '--baza', plik, '--nowy-klucz', '--plik', kluczPlik, '--potwierdz-wszystkie']);
    expect(w.kod).toBe(0);
    expect(w.wyjscie).toMatch(/PORZUCONE: .*integracja:dpd.*kanal:allegro-a.*sesja/);
    const nowy = kluczZPliku(kluczPlik).toString('base64url');
    const db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: nowy }, plik, { bezKataloguBazy: true });
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd').sekrety).toEqual({});
    expect(wczytajSekret(db)).toMatch(/^[0-9a-f]{64}$/);
    db.close();
    // Plik klucza istnieje — druga utrata tym poleceniem jest odmówiona.
    expect(cli(['porzuc', '--baza', plik, '--nowy-klucz', '--plik', kluczPlik, '--potwierdz-wszystkie']).kod).toBe(1);
  });
});

describe('sprzataj', () => {
  it('kończy sprzątanie po konwersji, drugi raz — nic do zrobienia', () => {
    const plik = path.join(kat, 'oms.sqlite');
    const db = openOmsDb(plik, { sejf: utworzSejf(bajtyKlucza(K1)) });
    db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, 'jawne', 'x')").run(KLUCZ_SPRZATANIA);
    db.close();
    expect(cli(['sprzataj', '--baza', plik]).wyjscie).toContain('SPRZATNIETE');
    expect(cli(['sprzataj', '--baza', plik]).wyjscie).toContain('NIC_DO_SPRZATANIA');
  });
});

describe('dwie wymiany klucza — test 6', () => {
  it('kopia sprzed pierwszej wymiany odtwarza się swoim kluczem jako poprzednim; id kluczy z samej kopii', () => {
    const plik = baza(path.join(kat, 'oms.sqlite'), K1, 'TAJNE-v1');
    const kopiaK1 = path.join(kat, 'kopia-k1.sqlite');
    let d = new DatabaseSync(plik); d.exec(`VACUUM INTO '${kopiaK1}'`); d.close();
    // Wymiana 1: K1 → K2.
    let db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K2, OMS_KLUCZ_SEKRETOW_POPRZEDNI: K1 }, plik, { bezKataloguBazy: true });
    konwertujSekrety(db, utworzSejf(bajtyKlucza(K2), bajtyKlucza(K1))); db.close();
    // Wymiana 2: K2 → K3.
    db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K3, OMS_KLUCZ_SEKRETOW_POPRZEDNI: K2 }, plik, { bezKataloguBazy: true });
    konwertujSekrety(db, utworzSejf(bajtyKlucza(K3), bajtyKlucza(K2))); db.close();
    expect(cli(['stan', '--baza', plik]).wyjscie).toContain(`wymagane id kluczy: ${id(K3)}`);
    // Najstarsza kopia: id z samej kopii, bez klucza.
    expect(cli(['stan', '--baza', kopiaK1]).wyjscie).toContain(`wymagane id kluczy: ${id(K1)}`);
    // Sam bieżący klucz nie otworzy starej kopii.
    expect(() => otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K3 }, kopiaK1, { bezKataloguBazy: true })).toThrow(/klucz/);
    // Procedura: bieżący + klucz tej kopii jako poprzedni → start przeszyfrowuje na bieżący.
    db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K3, OMS_KLUCZ_SEKRETOW_POPRZEDNI: K1 }, kopiaK1, { bezKataloguBazy: true });
    konwertujSekrety(db, utworzSejf(bajtyKlucza(K3), bajtyKlucza(K1)));
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd').sekrety.haslo).toBe('TAJNE-v1');
    db.close();
    // Potem linię poprzedniego klucza się usuwa — sam bieżący wystarcza.
    db = otworzBazeStartu({ OMS_KLUCZ_SEKRETOW: K3 }, kopiaK1, { bezKataloguBazy: true });
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd').sekrety.haslo).toBe('TAJNE-v1');
    db.close();
  });
});
