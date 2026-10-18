import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const przygotuj = path.join(ROOT, 'scripts/instalacja-przygotuj.mjs');
const proba = path.join(ROOT, 'scripts/instalacja-proba.mjs');
const katalogi = [];
function katalog() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-instalacja-')); katalogi.push(p); return p; }
function uruchom(plik, args, env = {}) { return spawnSync(process.execPath, [plik, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }); }
function kontoIBaza(plik) { const db = new DatabaseSync(plik, { readOnly: true }); try { return { integrity: db.prepare('PRAGMA integrity_check').get().integrity_check, konto: db.prepare("SELECT login, hash_hasla FROM konta WHERE login='administrator-proby'").get() }; } finally { db.close(); } }
afterEach(() => { for (const p of katalogi.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

describe('instalacja próby PRZ-050', () => {
  it('odmawia nadpisania konfiguracji lub bazy i nie dziedziczy sekretu procesu', () => {
    const p = katalog();
    fs.writeFileSync(path.join(p, 'cudze-dane.txt'), 'nie ruszaj');
    const odmowa = uruchom(przygotuj, ['--katalog', p, '--port', '39150']);
    expect(odmowa.status).toBe(1);
    expect(fs.readFileSync(path.join(p, 'cudze-dane.txt'), 'utf8')).toBe('nie ruszaj');
    const czysty = path.join(p, 'pusty katalog');
    const pierwszy = uruchom(przygotuj, ['--katalog', czysty, '--port', '39150'], { CUDZY_SEKRET_INTEGRACJI: 'nie-wolno-wyniesc' });
    expect(pierwszy.status, pierwszy.stderr).toBe(0);
    expect(pierwszy.stdout).not.toContain('nie-wolno-wyniesc');
    expect(fs.readFileSync(path.join(czysty, 'proba.env'), 'utf8')).not.toContain('nie-wolno-wyniesc');
    const drugi = uruchom(przygotuj, ['--katalog', czysty, '--port', '39150']);
    expect(drugi.status).toBe(1);
    expect(drugi.stderr).toContain('INSTALACJA_ODMOWA_NADPISANIA');
    expect(fs.readFileSync(path.join(czysty, 'produkcja.env.example'), 'utf8')).toContain('OMS_SPRZEDAWCA_NIP=\n');
    const produkcja = fs.readFileSync(path.join(czysty, 'produkcja.env.example'), 'utf8');
    for (const klucz of ['OMS_DB_PATH', 'OMS_PROFORMY_KATALOG', 'OMS_ETYKIETY_KATALOG']) expect(produkcja).toContain(klucz + '=\n');
    // PRZ-093.08: pola adresu firmy jak w szablonie Dockera (deploy/klient/aktualizuj.sh) — puste, opcjonalne.
    for (const klucz of ['DPD_NADAWCA_NAZWA', 'DPD_NADAWCA_ULICA', 'DPD_NADAWCA_KOD', 'DPD_NADAWCA_MIASTO']) expect(produkcja).toContain(klucz + '=\n');
    expect(produkcja).toContain('Ustawienia → Firma');
  });

  it('odmawia zmienionego trybu, kanałów i katalogu bazy przed bootstrapem', () => {
    const p = katalog();
    expect(uruchom(przygotuj, ['--katalog', p, '--port', '39152']).status).toBe(0);
    const envPath = path.join(p, 'proba.env');
    fs.writeFileSync(envPath, fs.readFileSync(envPath, 'utf8').replace('OMS_TRYB=proba', 'OMS_TRYB=produkcja'));
    const wynik = uruchom(proba, ['--katalog', p, '--port', '39152']);
    expect(wynik.status).toBe(1);
    expect(wynik.stderr).toContain('INSTALACJA_NIEZGODNY_KATALOG');
    expect(fs.existsSync(path.join(p, 'oms.sqlite'))).toBe(false);
    const q = katalog(); expect(uruchom(przygotuj, ['--katalog', q, '--port', '39153']).status).toBe(0);
    const qenv = path.join(q, 'proba.env'); fs.writeFileSync(qenv, fs.readFileSync(qenv, 'utf8').replace('OMS_KANALY=[]', 'OMS_KANALY=[{"klucz":"x","typ":"woo","prefiks":"X"}]'));
    expect(uruchom(proba, ['--katalog', q, '--port', '39153']).status).toBe(1); expect(fs.existsSync(path.join(q, 'oms.sqlite'))).toBe(false);
    const r = katalog(); expect(uruchom(przygotuj, ['--katalog', r, '--port', '39154']).status).toBe(0);
    const renv = path.join(r, 'proba.env'); fs.writeFileSync(renv, fs.readFileSync(renv, 'utf8').replace('OMS_DB_PATH=', 'OMS_DB_PATH=zmieniony-'));
    expect(uruchom(proba, ['--katalog', r, '--port', '39154']).status).toBe(1); expect(fs.existsSync(path.join(r, 'oms.sqlite'))).toBe(false);
  });

  it('odmawia cudzej istniejącej bazy bez zmiany jej zawartości', () => {
    const p = katalog(); expect(uruchom(przygotuj, ['--katalog', p, '--port', '39155']).status).toBe(0);
    const db = path.join(p, 'oms.sqlite'); fs.writeFileSync(db, 'cudza-baza'); const przed = fs.readFileSync(db);
    const wynik = uruchom(proba, ['--katalog', p, '--port', '39155']);
    expect(wynik.status).toBe(1); expect(wynik.stderr).toContain('INSTALACJA_ODMOWA_NADPISANIA'); expect(fs.readFileSync(db)).toEqual(przed);
  });

  it.each(['administrator-proby.env', 'backup-proba.sqlite', 'odtworzenie'])('odmawia pozostałości %s przed założeniem administratora', plik => {
    const p = katalog(); expect(uruchom(przygotuj, ['--katalog', p, '--port', '39156']).status).toBe(0);
    const pozostalosc = path.join(p, plik);
    if (plik === 'odtworzenie') fs.mkdirSync(pozostalosc); else fs.writeFileSync(pozostalosc, 'cudze-dane');
    const wynik = uruchom(proba, ['--katalog', p, '--port', '39156']);
    expect(wynik.status).toBe(1); expect(wynik.stderr).toContain('INSTALACJA_ODMOWA_NADPISANIA');
    expect(fs.existsSync(path.join(p, 'oms.sqlite'))).toBe(false);
    if (plik !== 'odtworzenie') expect(fs.readFileSync(pozostalosc, 'utf8')).toBe('cudze-dane');
  });

  it('realnie uruchamia pustą bazę na loopback, zakłada admina oraz odtwarza kopię i otwiera panel', async () => {
    const p = path.join(katalog(), 'próba ze spacją');
    expect(uruchom(przygotuj, ['--katalog', p, '--port', '39151']).status).toBe(0);
    const wynik = uruchom(proba, ['--katalog', p, '--port', '39151'], { OMS_PASS: 'cudzy-sekret', ALLEGRO_CLIENT_SECRET: 'cudzy-sekret' });
    expect(wynik.status, wynik.stderr).toBe(0);
    expect(wynik.stdout).toContain('proba-zakonczona');
    expect(JSON.parse(wynik.stdout.trim().split(/\r?\n/).at(-1)).status).toBe('proba-zakonczona');
    expect(wynik.stdout).toContain('http://127.0.0.1:39151/login');
    expect(wynik.stdout).toContain(path.join(p, 'administrator-proby.env'));
    expect(`${wynik.stdout}${wynik.stderr}`).not.toContain('cudzy-sekret');
    expect(fs.existsSync(path.join(p, 'oms.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(p, 'backup-proba.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(p, 'odtworzenie', 'oms.sqlite'))).toBe(true);
    const dane = fs.readFileSync(path.join(p, 'administrator-proby.env'), 'utf8');
    expect(dane).toContain('login=administrator-proby');
    expect(dane).not.toContain('cudzy-sekret');
    const serwisowe = /OMS_PASS=(.+)/.exec(fs.readFileSync(path.join(p, 'proba.env'), 'utf8'))[1]; const admin = /haslo=(.+)/.exec(dane)[1];
    expect(`${wynik.stdout}${wynik.stderr}`).not.toContain(serwisowe); expect(`${wynik.stdout}${wynik.stderr}`).not.toContain(admin);
    const oryginal = kontoIBaza(path.join(p, 'oms.sqlite')); const kopia = kontoIBaza(path.join(p, 'backup-proba.sqlite')); const restore = kontoIBaza(path.join(p, 'odtworzenie', 'oms.sqlite'));
    for (const stan of [oryginal, kopia, restore]) { expect(stan.integrity).toBe('ok'); expect(stan.konto.login).toBe('administrator-proby'); }
    expect(kopia.konto.hash_hasla).toBe(oryginal.konto.hash_hasla); expect(restore.konto.hash_hasla).toBe(oryginal.konto.hash_hasla);
    const otwarcie = spawn(process.execPath, [path.join(ROOT, 'scripts/instalacja-otworz.mjs'), '--katalog', p, '--port', '39151'], {
      env: { ...process.env, OMS_PASS: 'cudzy-sekret', INFAKT_API_KEY: 'cudzy-sekret' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let wyjscie = '';
    otwarcie.stderr.on('data', chunk => { wyjscie += chunk.toString(); });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Otwarcie próby nie zgłosiło gotowości')), 10_000);
        otwarcie.once('error', e => { clearTimeout(timeout); reject(e); });
        otwarcie.once('exit', code => { clearTimeout(timeout); reject(new Error(`Otwarcie zakończyło się przed gotowością: ${code}`)); });
        otwarcie.stdout.on('data', chunk => {
          wyjscie += chunk.toString();
          if (wyjscie.includes('http://127.0.0.1:39151/login')) { clearTimeout(timeout); resolve(); }
        });
      });
      const odpowiedz = await fetch('http://127.0.0.1:39151/login', {
        method: 'POST', redirect: 'manual', headers: { origin: 'http://127.0.0.1:39151', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ uzytkownik: 'administrator-proby', haslo: admin, powrot: '/ustawienia/konta' }),
      });
      expect(odpowiedz.status).toBe(302);
      await odpowiedz.arrayBuffer();
      const serwis = await fetch('http://127.0.0.1:39151/login', {
        method: 'POST', redirect: 'manual', headers: { origin: 'http://127.0.0.1:39151', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ uzytkownik: 'serwis-proby', haslo: serwisowe, powrot: '/' }),
      });
      expect(serwis.status).toBe(401); await serwis.arrayBuffer();
      expect(wyjscie).not.toContain('cudzy-sekret'); expect(wyjscie).not.toContain(admin); expect(wyjscie).not.toContain(serwisowe);
    } finally {
      if (otwarcie.exitCode === null) {
        await new Promise(resolve => { otwarcie.once('exit', resolve); otwarcie.kill(); });
      }
    }
  }, 30_000);
});
