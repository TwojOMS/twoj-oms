// PRZ-062: pierwszy start produkcji w kontenerze klienta (scripts/produkcja-pierwszy-start.mjs) — na
// prawdziwym OMS w trybie produkcja i świeżej bazie: granice raportu, pierwsze konto przez panel,
// degradacja konta serwisowego, na stdout tylko dane konta; odmowy na bazie z danymi i w próbie.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uruchomOms } from '../../src/main.ts';
import { planGranic } from '../../scripts/produkcja-pierwszy-start.mjs';
import { wykonaj as wykonajGranice } from "../../scripts/inicjalizuj-granice-bez-historii.mjs";

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKRYPT = path.join(ROOT, 'scripts/produkcja-pierwszy-start.mjs');
const katalogi: string[] = [];
afterEach(() => { for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true }); });

const wolnyPort = () => new Promise<number>((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });
const KANALY = [{ klucz: 'woo_przykladowa', typ: 'woo', prefiks: 'WOO_PRZYKLADOWA', etykieta: 'sklep.przykladowa.example', raport: 'SKLEP_PRZYKLADOWA' }];

const SH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const u = (p: string) => p.replaceAll('\\', '/');

/**
 * Konfiguracja pracy dokładnie z szablonu, który zakłada `aktualizuj.sh produkcja` (pierwsze wywołanie),
 * odczytana jak env_file compose (NAZWA=wartość, komentarze pominięte), uzupełniona jak przez operatora,
 * plus to, co compose klienta ustawia w `environment` (ścieżki i port).
 */
function konfiguracjaZSzablonu(k: string): Record<string, string> {
  const oms = path.join(k, 'opt-oms');
  fs.mkdirSync(path.join(oms, 'config'), { recursive: true });
  fs.writeFileSync(path.join(oms, 'config/oms.env'), 'OMS_TRYB=proba\nOMS_PASS=proba\n');
  const r = spawnSync(SH, [u(path.join(ROOT, 'deploy/klient/aktualizuj.sh')), 'produkcja'], { encoding: 'utf8',
    env: { ...process.env, OMS_KATALOG: u(oms), OMS_AKT_BEZ_ROOTA: '1' } });
  if (r.status !== 0) throw new Error(r.stderr);
  const env: Record<string, string> = {};
  for (const linia of fs.readFileSync(path.join(oms, 'config/produkcja.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(linia);
    if (m) env[m[1]] = m[2];
  }
  return { ...env, OMS_SPRZEDAWCA_NIP: '1111111111', OMS_RACHUNEK: '50109010140000000000000003',
    DPD_NADAWCA_NAZWA: 'Pracownia Przykładowa sp. z o.o.', DPD_NADAWCA_ULICA: 'Klockowa 1', DPD_NADAWCA_KOD: '00-950', DPD_NADAWCA_MIASTO: 'Warszawa' };
}

async function srodowisko(extra: Record<string, string> = {}) {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'prz062-pierwszy-'));
  katalogi.push(k);
  for (const d of ['proformy', 'etykiety']) fs.mkdirSync(path.join(k, d));
  const port = await wolnyPort();
  const env: Record<string, string> = { ...konfiguracjaZSzablonu(k), OMS_DB_PATH: path.join(k, 'oms.sqlite'), OMS_PORT: String(port),
    OMS_PROFORMY_KATALOG: path.join(k, 'proformy'), OMS_ETYKIETY_KATALOG: path.join(k, 'etykiety'), OMS_KANALY: JSON.stringify(KANALY), ...extra };
  return { k, port, env };
}
function uruchomSkrypt(env: Record<string, string>, argumenty: string[] = []) {
  return new Promise<{ kod: number | null; stdout: string; stderr: string }>((ok) => {
    const p = spawn(process.execPath, [SKRYPT, ...argumenty], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env } });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (kod) => ok({ kod, stdout, stderr }));
  });
}
async function zalogujStatus(port: number, uzytkownik: string, haslo: string) {
  const r = await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST', redirect: 'manual',
    headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ uzytkownik, haslo, powrot: '/' }).toString() });
  return r.status;
}

describe('produkcja-pierwszy-start.mjs', () => {
  it('świeża baza produkcji: granice każdego kanału raportowego, administrator przez panel, konto serwisowe przestaje logować', async () => {
    const { env, port } = await srodowisko();
    const oms = await uruchomOms(env, '127.0.0.1');
    try {
      const r = await uruchomSkrypt(env);
      expect(r.kod, r.stderr).toBe(0);
      const linie = r.stdout.trimEnd().split('\n');
      expect(linie).toHaveLength(2);
      expect(linie[0]).toBe('login=administrator');
      const haslo = linie[1].replace(/^haslo=/, '');
      expect(haslo).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(r.stderr).not.toContain(haslo); expect(r.stderr).not.toContain(env.OMS_PASS);
      expect(JSON.parse(r.stderr.trim().split('\n').at(-1)!)).toMatchObject({ status: 'produkcja-pierwszy-start', konto: 'administrator' });
      expect(await zalogujStatus(port, 'administrator', haslo)).toBe(302);
      expect(await zalogujStatus(port, env.OMS_USER, env.OMS_PASS)).toBe(401);
      const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
      try {
        const g = db.prepare('SELECT kanal, zrodlo FROM granice_historii ORDER BY kanal').all().map((w: any) => `${w.kanal}:${w.zrodlo}`);
        // PRZ-089: GDD i INDYWIDUALNE (kanały Szkicownia) tylko z konfiguracji — czysta instalacja ich nie zakłada.
        expect(g).toEqual(['B2B', 'DROPSHIPPING', 'RECZNE', 'SKLEP_PRZYKLADOWA'].map(k => `${k}:oms-bez-historii`));
      } finally { db.close(); }
      // Drugi raz: konto już jest — odmowa, bez nowego hasła na stdout.
      const drugi = await uruchomSkrypt(env);
      expect(drugi.kod).toBe(1); expect(drugi.stdout).toBe(''); expect(drugi.stderr).toContain('PRODUKCJA_KONTO_JUZ_ISTNIEJE');
    } finally { await oms.zamknij(); }
  }, 60_000);

  it('odmawia na bazie z zamówieniami i w trybie próby', async () => {
    const { env } = await srodowisko();
    const oms = await uruchomOms(env, '127.0.0.1');
    await oms.zamknij();
    const db = new DatabaseSync(env.OMS_DB_PATH);
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, utworzone_at, kwota_brutto, metoda_wysylki) VALUES ('woo_przykladowa','1','X-1','2026-10-01T10:00:00','1.00','dpd')").run();
    db.close();
    const r = await uruchomSkrypt(env);
    expect(r.kod).toBe(1); expect(r.stdout).toBe(''); expect(r.stderr).toContain('PRODUKCJA_BAZA_NIE_JEST_NOWA');
    const proba = await uruchomSkrypt({ ...env, OMS_TRYB: 'proba' });
    expect(proba.kod).toBe(1); expect(proba.stderr).toContain('PRODUKCJA_TO_NIE_PRODUKCJA');
  }, 60_000);

  it('dzień granicy: wczoraj, a dla kanału pobierającego od wcześniejszej daty — dzień przed <P>_OD', () => {
    const teraz = new Date('2026-10-15T09:00:00Z');
    const plan = (od?: string) => planGranic({ OMS_KANALY: JSON.stringify(KANALY), ...(od ? { WOO_PRZYKLADOWA_OD: od } : {}) }, teraz).plan;
    expect(plan().find(p => p.kanal === 'SKLEP_PRZYKLADOWA')!.doDnia).toBe('2026-10-14');
    expect(plan('2026-10-01').find(p => p.kanal === 'SKLEP_PRZYKLADOWA')!.doDnia).toBe('2026-09-30');
    expect(plan('2026-10-20').find(p => p.kanal === 'SKLEP_PRZYKLADOWA')!.doDnia).toBe('2026-10-14');
    expect(plan('2026-10-01').find(p => p.kanal === 'RECZNE')!.doDnia).toBe('2026-10-14');
  });

  // Recenzja D8 r1, P2-1: granica kanału dopisanego po przejściu liczona tą samą regułą, nie w głowie.
  it('--granice: kanał dopisany po przejściu dostaje granicę dzień przed OD, istniejące zostają, bez konta i bez HTTP', async () => {
    const { env } = await srodowisko({ OMS_KANALY: '[]' });
    const oms = await uruchomOms(env, '127.0.0.1');
    await oms.zamknij();
    const pierwszy = await uruchomSkrypt({ ...env, OMS_PORT: '1' });
    expect(pierwszy.kod).toBe(1); // bez działającego OMS konto się nie założy — ale granice wbudowane już są
    const poPrzejsciu = { ...env, OMS_KANALY: JSON.stringify(KANALY), WOO_PRZYKLADOWA_OD: '2026-10-01' };
    const r = await uruchomSkrypt({ ...poPrzejsciu, OMS_PORT: '1' }, ['--granice']);
    expect(r.kod, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'granice', zalozone: ['SKLEP_PRZYKLADOWA=2026-09-30'], pominiete: [] });
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      // PRZ-089: wbudowane bez GDD/INDYWIDUALNE (3) + kanał klienta = 4.
      expect(db.prepare('SELECT COUNT(*) AS n FROM granice_historii').get().n).toBe(4);
      expect(db.prepare('SELECT COUNT(*) AS n FROM konta').get().n).toBe(0);
    } finally { db.close(); }
    const znowu = await uruchomSkrypt({ ...poPrzejsciu, OMS_PORT: '1' }, ['--granice']);
    expect(JSON.parse(znowu.stdout).zalozone).toEqual([]);
  }, 60_000);

  it('ręczna granica w dniu OD kanału albo później: odmowa z nazwą zmiennej, nic nie zapisane', async () => {
    const { env } = await srodowisko();
    const oms = await uruchomOms(env, '127.0.0.1');
    await oms.zamknij();
    const e = { ...env, WOO_PRZYKLADOWA_OD: '2026-10-20' };
    for (const dzien of ['2026-10-20', '2026-11-01'])
      expect(() => wykonajGranice([env.OMS_DB_PATH, 'SKLEP_PRZYKLADOWA', dzien], e)).toThrow(/WOO_PRZYKLADOWA_OD \(2026-10-20\)/);
    wykonajGranice([env.OMS_DB_PATH, 'SKLEP_PRZYKLADOWA', '2026-10-19'], e);
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try { expect(db.prepare("SELECT do_dnia FROM granice_historii WHERE kanal = 'SKLEP_PRZYKLADOWA'").all()).toEqual([{ do_dnia: '2026-10-19' }]); }
    finally { db.close(); }
  }, 60_000);
});
