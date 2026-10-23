import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { wykonajMigracje } from '../../src/core/baza.ts';
import { modulUstawienia } from '../../src/moduly/ustawienia/modul.ts';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';
import { zgodneHaslo } from '../../src/domena/hasla.js';
import { synchronizujRole } from '../../src/moduly/ustawienia/role.js';
import { wydajLink, aktywnyLink, uzyjLinku } from '../../src/moduly/ustawienia/linki-hasla.js';
import { zapiszKonfiguracjeIntegracji } from '../../src/oms/db/konfiguracja-integracji.js';
import { plikiPaczki } from '../../scripts/paczka-klienta.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SKRYPT = path.join(ROOT, 'scripts/link-hasla-admina.mjs');
const SH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const teraz = () => new Date();
let katalog, plik, db, admin;
const uruchom = (args = [], env = {}) => spawnSync(process.execPath, [SKRYPT, ...args], {
  encoding: 'utf8', env: { ...process.env, OMS_DB_PATH: plik, OMS_ADRES_PANELU: '', ...env },
});
const tokenZ = (r) => r.stdout.match(/\/haslo\/([A-Za-z0-9_-]{43})/)?.[1];

beforeEach(() => {
  katalog = fs.mkdtempSync(path.join(ROOT, '.tmp-link-hasla-'));
  plik = path.join(katalog, 'oms.sqlite');
  db = openOmsDb(plik);
  wykonajMigracje(db, [modulUstawienia]);
  synchronizujRole(db, { teraz });
  admin = zalozKonto(db, { login: 'szef', imie: 'Administrator', haslo: 'Stare-testowe-123!', rola: 'administrator', admin: true });
  zalozKonto(db, { login: 'sprzedawca', imie: 'Sprzedaż', haslo: 'Testowe-123!', rola: 'sprzedaz' });
  db.prepare('INSERT INTO konta_email (konto_id, email, zmieniono_at) VALUES (?, ?, ?)').run(admin, 'szef@example.test', teraz().toISOString());
});
afterEach(() => { db?.close(); fs.rmSync(katalog, { recursive: true, force: true }); });

describe('odzyskanie hasła administratora z konsoli serwera', () => {
  it('paczka i obraz klienta zawierają skrypt uruchamiany przez aktualizator', () => {
    const plikSkryptu = 'scripts/link-hasla-admina.mjs';
    expect(plikiPaczki([plikSkryptu])).toEqual([plikSkryptu]);
    const dockerfile = fs.readFileSync(path.join(ROOT, 'deploy/klient/Dockerfile'), 'utf8');
    const kopie = dockerfile.split(/\r?\n/).filter(l => l.startsWith('COPY ')).flatMap(l => {
      const pola = l.trim().split(/\s+/).slice(1);
      const cel = pola.pop();
      return pola.filter(p => p === plikSkryptu).map(p => path.posix.join('/app', cel, path.posix.basename(p)));
    });
    expect(kopie).toContain('/app/scripts/link-hasla-admina.mjs');
  });

  it('bez loginu wypisuje wyłącznie loginy administratorów, bez linków i zapisów', () => {
    const r = uruchom();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('szef');
    expect(db.prepare('SELECT count(*) AS n FROM linki_hasla').get().n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM logowania').get().n).toBe(0);
  });

  // PRZ-109.12 (recenzja): lista tylko kont, dla których link da się wydać; pusta lista = odmowa z kodem ≠ 0.
  it('lista pomija wyłączonych administratorów, a pusta lista jest odmową', () => {
    zalozKonto(db, { login: 'byly-szef', imie: 'Były', haslo: 'Testowe-789!', rola: 'administrator', admin: true });
    db.prepare("UPDATE konta SET czynne = 0 WHERE login = 'byly-szef'").run();
    expect(uruchom().stdout.trim()).toBe('szef');
    db.prepare("UPDATE konta SET czynne = 0 WHERE login = 'szef'").run();
    const r = uruchom();
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Brak włączonych kont administratora');
  });

  it('konto zaproszone (bez zapisu scrypt) dostaje zaproszenie, jak przy „Pokaż link” w panelu', () => {
    db.prepare("UPDATE konta SET hash_hasla = 'zaproszone' WHERE id = ?").run(admin);
    const r = uruchom(['szef']);
    expect(r.status).toBe(0);
    expect(aktywnyLink(db, tokenZ(r), teraz)).toMatchObject({ kontoId: admin, cel: 'zaproszenie' });
  });

  it('wydaje reset na 48 h, zastępuje poprzedni link i nie zmienia hasła przed użyciem', () => {
    const poprzedni = wydajLink(db, { kontoId: admin, cel: 'reset', teraz });
    const r = uruchom(['szef'], { OMS_ADRES_PANELU: 'https://panel.example.test/' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^https:\/\/panel\.example\.test\/haslo\/[A-Za-z0-9_-]{43}$/);
    const token = tokenZ(r);
    expect(aktywnyLink(db, token, teraz)).toMatchObject({ kontoId: admin, cel: 'reset' });
    expect(aktywnyLink(db, poprzedni.token, teraz)).toBeNull();
    const link = db.prepare('SELECT * FROM linki_hasla ORDER BY id DESC LIMIT 1').get();
    expect(Date.parse(link.wygasa_at) - Date.parse(link.utworzone_at)).toBe(172800000);
    const hash = () => db.prepare('SELECT hash_hasla FROM konta WHERE id = ?').get(admin).hash_hasla;
    expect(zgodneHaslo('Stare-testowe-123!', hash())).toBe(true);
    expect(uzyjLinku(db, { token, haslo: 'Nowe-testowe-456!', teraz })).toEqual({ login: 'szef' });
    expect(zgodneHaslo('Stare-testowe-123!', hash())).toBe(false);
    expect(zgodneHaslo('Nowe-testowe-456!', hash())).toBe(true);
    expect(aktywnyLink(db, token, teraz)).toBeNull();
  });

  it('zostawia ślad konsoli w dzienniku kont bez tokenu i hasła', () => {
    const r = uruchom(['szef']);
    expect(r.status).toBe(0);
    const wpisy = db.prepare('SELECT * FROM logowania').all();
    expect(wpisy).toHaveLength(1);
    expect(JSON.stringify(wpisy).includes(tokenZ(r))).toBe(false);
    expect(wpisy[0]).toMatchObject({ login: 'szef', usluga: 'oms', ip: 'konsola serwera', wynik: 'link-hasla-z-konsoli' });
    expect(JSON.stringify(wpisy)).not.toContain('Stare-testowe-123!');
    expect(r.stderr).not.toContain(tokenZ(r));
  });

  it('używa adresu z Ustawień, ale env ma pierwszeństwo', () => {
    zapiszKonfiguracjeIntegracji(db, 'adres_panelu', { ustawienia: { adres: 'https://zapis.example.test' } });
    expect(uruchom(['szef']).stdout).toMatch(/^https:\/\/zapis\.example\.test\/haslo\//);
    expect(uruchom(['szef'], { OMS_ADRES_PANELU: 'https://env.example.test' }).stdout).toMatch(/^https:\/\/env\.example\.test\/haslo\//);
  });

  it('bez adresu zwraca samą ścieżkę raz i instrukcję doklejenia', () => {
    const r = uruchom(['szef']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\/haslo\/[A-Za-z0-9_-]{43}$/);
    expect(r.stderr).toContain('doklej do adresu panelu');
  });

  it.each([
    ['brak', 'Nie ma takiego konta'], ['sprzedawca', 'nie jest administratorem'], ['szef', 'wyłączone'],
  ])('odmawia dla konta %s bez wydania linku', (login, komunikat) => {
    if (login === 'szef') db.prepare('UPDATE konta SET czynne = 0 WHERE id = ?').run(admin);
    const r = uruchom([login]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(komunikat);
    expect(db.prepare('SELECT count(*) AS n FROM linki_hasla').get().n).toBe(0);
  });

  it('brak bazy nie tworzy pustej bazy', () => {
    const brak = path.join(katalog, 'brak.sqlite');
    const r = uruchom(['szef'], { OMS_DB_PATH: brak });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('bazy');
    expect(fs.existsSync(brak)).toBe(false);
  });

  it('podpolecenie aktualizatora przekazuje login do skryptu w kontenerze, także bez loginu i z błędem', () => {
    const docker = path.join(katalog, 'docker-test.sh');
    fs.writeFileSync(docker, `#!/bin/sh\nset -eu\n[ "$1" = exec ] && [ "$2" = oms ] && [ "$3" = node ] && [ "$4" = /app/scripts/link-hasla-admina.mjs ] || exit 98\nshift 4\nexec node "$TEST_SKRYPT" "$@"\n`, { mode: 0o755 });
    const aktualizator = path.join(katalog, 'aktualizuj.sh');
    fs.writeFileSync(aktualizator, fs.readFileSync(path.join(ROOT, 'deploy/klient/aktualizuj.sh'), 'utf8').replaceAll('\r\n', '\n'));
    const akt = (args) => spawnSync(SH, [aktualizator, 'link-hasla', ...args], { encoding: 'utf8', env: {
      ...process.env, OMS_AKT_BEZ_ROOTA: '1', OMS_DOCKER_BIN: docker.replaceAll('\\', '/'),
      OMS_KATALOG: katalog.replaceAll('\\', '/'), OMS_DB_PATH: plik, OMS_ADRES_PANELU: '', TEST_SKRYPT: SKRYPT.replaceAll('\\', '/'),
    } });
    expect(akt([]).stdout.trim()).toBe('szef');
    const r = akt(['szef']);
    expect(r.status).toBe(0);
    expect(aktywnyLink(db, tokenZ(r), teraz)).toMatchObject({ kontoId: admin });
    expect(akt(['brak']).status).not.toBe(0);
    expect(akt(['szef', 'nadmiar']).status).not.toBe(0);
  });
});
