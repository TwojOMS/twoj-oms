// PRZ-059: kopie u klienta (deploy/klient/kopia.mjs) — dzienna kopia bazy, archiwum plików
// z rotacją, kopia na nośnik zewnętrzny i kopia operacji aktualizatora. Prawdziwy SQLite i pliki.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cykl, ustawienia, operacja, ZNACZNIK_NOSNIKA } from '../../deploy/klient/kopia.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKRYPT = path.join(ROOT, 'deploy/klient/kopia.mjs');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true }); });
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const H = 3600_000;

function instalacja({ zamowien = 3 } = {}) {
  const baza = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-kopia-'));
  katalogi.push(baza);
  const dane = path.join(baza, 'data');
  for (const k of ['data/etykiety/2026', 'data/proformy', 'backups', 'usb']) fs.mkdirSync(path.join(baza, k), { recursive: true });
  const db = new DatabaseSync(path.join(dane, 'oms.sqlite'));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE migracje (modul TEXT, numer INTEGER, nazwa TEXT, zastosowana_at TEXT, PRIMARY KEY (modul, numer))');
  db.exec("INSERT INTO migracje VALUES ('rdzen', 1, 'baseline', '2026-10-01')");
  db.exec('CREATE TABLE zamowienia (id INTEGER PRIMARY KEY, numer TEXT)');
  db.exec('CREATE TABLE konta (login TEXT)');
  db.exec("INSERT INTO konta VALUES ('administrator-proby')");
  for (let i = 1; i <= zamowien; i++) db.prepare('INSERT INTO zamowienia (numer) VALUES (?)').run(`DEMO-${i}`);
  db.close();
  fs.writeFileSync(path.join(dane, 'etykiety/2026/a.pdf'), Buffer.alloc(3000, 7));
  fs.writeFileSync(path.join(dane, 'proformy/p1.pdf'), Buffer.alloc(2000, 8));
  const env = { OMS_DB_PATH: path.join(dane, 'oms.sqlite'), OMS_KOPIE_KATALOG: path.join(baza, 'backups'), OMS_KOPIA_REZERWA_MB: '0' };
  return { baza, dane, kopie: path.join(baza, 'backups'), usb: path.join(baza, 'usb'), env };
}
// Katalogi testu leżą na jednym dysku; nośnik udaje osobne urządzenie (st_dev), jak pendrive.
const osobnyNosnik = (u, k) => ({ ...u, urzadzenie: p => (p.startsWith(k.usb) ? 2 : 1) });
const ile = plik => { const d = new DatabaseSync(plik, { readOnly: true }); try { return d.prepare('SELECT count(*) AS n FROM zamowienia').get().n; } finally { d.close(); } };

describe('kopia operacji aktualizatora', () => {
  it('robi spójną kopię mimo niezapisanego WAL, zapisuje listę migracji i odmawia drugiej kopii w tym samym katalogu', () => {
    const k = instalacja();
    // Otwarte połączenie z zapisem w WAL bez checkpointu: zwykłe `cp` pliku bazy zgubiłoby ten wiersz.
    const pisarz = new DatabaseSync(path.join(k.dane, 'oms.sqlite'));
    pisarz.exec('PRAGMA wal_autocheckpoint=0');
    pisarz.prepare('INSERT INTO zamowienia (numer) VALUES (?)').run('W-WAL');
    const op = path.join(k.baza, 'op'); fs.mkdirSync(op);
    const r = spawnSync(process.execPath, [SKRYPT, 'operacja', path.join(k.dane, 'oms.sqlite'), op], { encoding: 'utf8' });
    pisarz.close();
    expect(r.status, r.stderr).toBe(0);
    const w = JSON.parse(r.stdout);
    expect(w).toMatchObject({ ok: true, integralnosc: 'ok', zamowien: 4, kont: 1, migracji: 1 });
    expect(ile(path.join(op, 'oms.sqlite'))).toBe(4);
    expect(JSON.parse(fs.readFileSync(path.join(op, 'migracje.json'), 'utf8'))).toEqual([{ modul: 'rdzen', numer: 1, nazwa: 'baseline' }]);
    const przed = sha(path.join(op, 'oms.sqlite'));
    const r2 = spawnSync(process.execPath, [SKRYPT, 'operacja', path.join(k.dane, 'oms.sqlite'), op], { encoding: 'utf8' });
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('KOPIA_OPERACJI_JUZ_ISTNIEJE');
    expect(sha(path.join(op, 'oms.sqlite'))).toBe(przed);
  });

  it('nie zostawia kopii, gdy baza jest uszkodzona', () => {
    const k = instalacja();
    const plik = path.join(k.dane, 'oms.sqlite');
    fs.writeFileSync(plik, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(8192, 0x41)]));
    for (const p of [`${plik}-wal`, `${plik}-shm`]) fs.rmSync(p, { force: true });
    const op = path.join(k.baza, 'op'); fs.mkdirSync(op);
    expect(() => operacja(plik, op)).toThrow();
    expect(fs.readdirSync(op).filter(n => !n.startsWith('.tmp-'))).toEqual([]);
  });
});

describe('dzienna kopia bazy', () => {
  it('pierwsza od razu; tego samego dnia nie powtarza; nowy dzień po 03:00 UTC albo po 26 h robi następną', () => {
    const k = instalacja();
    const u = ustawienia(k.env);
    const w1 = cykl(u, { teraz: new Date('2026-10-10T12:00:00Z') });
    expect(w1.bledy).toEqual([]);
    expect(w1.baza).toMatchObject({ plik: 'oms-2026-10-10.sqlite', integralnosc: 'ok', zamowien: 3 });
    const plik = path.join(k.kopie, 'oms-2026-10-10.sqlite');
    fs.utimesSync(plik, new Date('2026-10-10T12:00:00Z'), new Date('2026-10-10T12:00:00Z'));
    expect(cykl(u, { teraz: new Date('2026-10-10T23:00:00Z') }).baza).toBeNull();
    // Nowy dzień, ale przed 03:00 UTC i mniej niż 26 h — czeka (kopia w nocy, nie w środku dnia pracy).
    expect(cykl(u, { teraz: new Date('2026-10-11T02:00:00Z') }).baza).toBeNull();
    expect(cykl(u, { teraz: new Date('2026-10-11T03:10:00Z') }).baza?.plik).toBe('oms-2026-10-11.sqlite');
    // Serwer wyłączany na noc: po włączeniu o 07:00 następnego dnia kopia powstaje od razu.
    fs.utimesSync(path.join(k.kopie, 'oms-2026-10-11.sqlite'), new Date('2026-10-11T03:10:00Z'), new Date('2026-10-11T03:10:00Z'));
    expect(cykl(u, { teraz: new Date('2026-10-12T07:00:00Z') }).baza?.plik).toBe('oms-2026-10-12.sqlite');
    // Kopia z wczoraj w południe (17 h), nowy dzień po 03:00 UTC — kopia nocna, bez czekania na 26 h.
    fs.utimesSync(path.join(k.kopie, 'oms-2026-10-12.sqlite'), new Date('2026-10-12T12:00:00Z'), new Date('2026-10-12T12:00:00Z'));
    expect(cykl(u, { teraz: new Date('2026-10-13T05:00:00Z') }).baza?.plik).toBe('oms-2026-10-13.sqlite');
  });

  it('rotuje wyłącznie własne kopie (zostaje 14) i nie dotyka obcych plików', () => {
    const k = instalacja();
    for (let d = 1; d <= 20; d++) fs.writeFileSync(path.join(k.kopie, `oms-2026-09-${String(d).padStart(2, '0')}.sqlite`), 'x');
    fs.writeFileSync(path.join(k.kopie, 'panel-2026-09-01.sqlite'), 'cudza');
    fs.writeFileSync(path.join(k.kopie, 'notatka.txt'), 'cudza');
    const w = cykl(ustawienia(k.env), { teraz: new Date('2026-10-10T12:00:00Z') });
    expect(w.bledy).toEqual([]);
    const zostaly = fs.readdirSync(k.kopie).filter(n => /^oms-.*\.sqlite$/.test(n)).sort();
    expect(zostaly).toHaveLength(14);
    expect(zostaly.at(-1)).toBe('oms-2026-10-10.sqlite');
    expect(zostaly[0]).toBe('oms-2026-09-08.sqlite');
    expect(fs.existsSync(path.join(k.kopie, 'panel-2026-09-01.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(k.kopie, 'notatka.txt'))).toBe(true);
  });
});

describe('archiwum etykiet i proform z rotacją', () => {
  it('co 7 dni nowe archiwum z obu katalogów, zostają 2', () => {
    const k = instalacja();
    const u = ustawienia(k.env);
    const dni = ['2026-10-01', '2026-10-08', '2026-10-15'];
    for (const d of dni) {
      const w = cykl(u, { teraz: new Date(`${d}T12:00:00Z`) });
      expect(w.bledy).toEqual([]);
      expect(w.archiwum?.archiwum).toBe(`pliki-${d}.tgz`);
      fs.utimesSync(path.join(k.kopie, `pliki-${d}.tgz`), new Date(`${d}T12:00:00Z`), new Date(`${d}T12:00:00Z`));
    }
    expect(cykl(u, { teraz: new Date('2026-10-20T12:00:00Z') }).archiwum).toBeNull();
    expect(fs.readdirSync(k.kopie).filter(n => n.endsWith('.tgz')).sort()).toEqual(['pliki-2026-10-08.tgz', 'pliki-2026-10-15.tgz']);
    const lista = spawnSync('tar', ['-tzf', '-'], { input: fs.readFileSync(path.join(k.kopie, 'pliki-2026-10-15.tgz')), encoding: 'utf8' }).stdout;
    expect(lista).toContain('etykiety/2026/a.pdf');
    expect(lista).toContain('proformy/p1.pdf');
  });
});

describe('kopia poza dyskiem', () => {
  it('bez pliku-znacznika nośnika nie zapisuje nic (pendrive niepodłączony = pusty katalog na tym samym dysku)', () => {
    const k = instalacja();
    const w = cykl(ustawienia({ ...k.env, OMS_KOPIA_ZEWNETRZNA: k.usb }), { teraz: new Date('2026-10-10T12:00:00Z') });
    expect(w.baza?.plik).toBe('oms-2026-10-10.sqlite');
    expect(w.bledy.join(' ')).toContain('KOPIA_ZEWNETRZNA_BRAK_NOSNIKA');
    expect(fs.readdirSync(k.usb)).toEqual([]);
  });

  it('z nośnikiem: kopia bazy z tym samym odciskiem, lustro plików tylko z nowymi, rotacja 30', () => {
    const k = instalacja();
    fs.writeFileSync(path.join(k.usb, ZNACZNIK_NOSNIKA), '');
    for (let d = 1; d <= 31; d++) fs.writeFileSync(path.join(k.usb, `oms-2026-08-${String(d).padStart(2, '0')}.sqlite`), 'stara');
    const u = osobnyNosnik(ustawienia({ ...k.env, OMS_KOPIA_ZEWNETRZNA: k.usb }), k);
    const w = cykl(u, { teraz: new Date('2026-10-10T12:00:00Z') });
    expect(w.bledy).toEqual([]);
    expect(w.zewnetrzna).toMatchObject({ baza: 'oms-2026-10-10.sqlite', plikow: 2 });
    expect(sha(path.join(k.usb, 'oms-2026-10-10.sqlite'))).toBe(sha(path.join(k.kopie, 'oms-2026-10-10.sqlite')));
    expect(ile(path.join(k.usb, 'oms-2026-10-10.sqlite'))).toBe(3);
    expect(fs.readFileSync(path.join(k.usb, 'pliki/etykiety/2026/a.pdf')).equals(fs.readFileSync(path.join(k.dane, 'etykiety/2026/a.pdf')))).toBe(true);
    expect(fs.existsSync(path.join(k.usb, 'pliki/proformy/p1.pdf'))).toBe(true);
    expect(fs.readdirSync(k.usb).filter(n => /^oms-.*\.sqlite$/.test(n))).toHaveLength(30);
    // Drugi cykl: tylko nowa etykieta; usunięta lokalnie zostaje na nośniku (archiwum, nie lustro kasujące).
    fs.writeFileSync(path.join(k.dane, 'etykiety/2026/b.pdf'), Buffer.alloc(100, 1));
    fs.rmSync(path.join(k.dane, 'etykiety/2026/a.pdf'));
    const w2 = cykl(u, { teraz: new Date('2026-10-10T13:00:00Z') });
    expect(w2.bledy).toEqual([]);
    expect(w2.zewnetrzna).toMatchObject({ baza: null, plikow: 1 });
    expect(fs.existsSync(path.join(k.usb, 'pliki/etykiety/2026/a.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(k.usb, 'pliki/etykiety/2026/b.pdf'))).toBe(true);
  });

  it('znacznik na tym samym dysku co baza (montowanie się nie udało): odmowa, nic nie zapisane', () => {
    const k = instalacja();
    fs.writeFileSync(path.join(k.usb, ZNACZNIK_NOSNIKA), '');
    const w = cykl(ustawienia({ ...k.env, OMS_KOPIA_ZEWNETRZNA: k.usb }), { teraz: new Date('2026-10-10T12:00:00Z') });
    expect(w.baza?.plik).toBe('oms-2026-10-10.sqlite');
    expect(w.bledy.join(' ')).toContain('KOPIA_ZEWNETRZNA_TEN_SAM_DYSK');
    expect(fs.readdirSync(k.usb)).toEqual([ZNACZNIK_NOSNIKA]);
  });

  it('brak miejsca na nośniku: odmowa przed zapisem', () => {
    const k = instalacja();
    fs.writeFileSync(path.join(k.usb, ZNACZNIK_NOSNIKA), '');
    const w = cykl(osobnyNosnik(ustawienia({ ...k.env, OMS_KOPIA_ZEWNETRZNA: k.usb, OMS_KOPIA_REZERWA_MB: String(1024 * 1024 * 1024) }), k), { teraz: new Date('2026-10-10T12:00:00Z') });
    expect(w.bledy.join(' ')).toContain('KOPIA_ZEWNETRZNA_BRAK_MIEJSCA');
    // Archiwum plików też sprawdza miejsce (bez tego co godzinę zapychało dysk do 100%).
    expect(w.bledy.join(' ')).toContain('KOPIA_ARCHIWUM_BRAK_MIEJSCA');
    expect(fs.readdirSync(k.kopie).filter(n => n.includes('pliki-'))).toEqual([]);
    expect(fs.readdirSync(k.usb)).toEqual([ZNACZNIK_NOSNIKA]);
  });

  it('polecenie `teraz` kończy się błędem, gdy kopia zewnętrzna się nie udała (kopia lokalna zostaje)', () => {
    const k = instalacja();
    const r = spawnSync(process.execPath, [SKRYPT, 'teraz'], { encoding: 'utf8', env: { ...process.env, ...k.env, OMS_KOPIA_ZEWNETRZNA: k.usb } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('KOPIA_ZEWNETRZNA_BRAK_NOSNIKA');
    expect(fs.readdirSync(k.kopie).some(n => /^oms-\d{4}-\d{2}-\d{2}\.sqlite$/.test(n))).toBe(true);
  });
});
