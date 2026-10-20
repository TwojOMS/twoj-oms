// PRZ-062: przejście instalacji klienta z próby na pracę (aktualizuj.sh produkcja → accept | recover).
// Całe sekwencje na skutkach: katalogi danych, kopie, konfiguracja, blokada, kontenery (atrapa dockera ze
// stanem), prawdziwa baza SQLite, prawdziwy kopia.mjs (kopia próby przed zmianą i pierwsza kopia pracy).
// Decyzja: czysta baza produkcyjna OBOK — próba w całości do /opt/oms/proba-archiwum/<op>/, nowe konto.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { tarUstar } from '../../scripts/paczka-klienta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AKTUALIZATOR = path.join(ROOT, 'deploy/klient/aktualizuj.sh');
const KOPIA = path.join(ROOT, 'deploy/klient/kopia.mjs');
const ATRAPA = path.join(ROOT, 'tests/instalacja/atrapa-dockera.mjs');
const SH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const u = p => p.replaceAll('\\', '/');
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true }); });

const COMMIT = 'a'.repeat(39) + '1';
const WYD = `oms-${COMMIT.slice(0, 12)}`;
const HASLO_PROBY = 'tajne-haslo-serwisu-proby';
const DZIS = new Date().toISOString().slice(0, 10);

/** Instalacja po PRZ-058/059: próba z demo (3 zamówienia, konto próby, kopia z dziś), oms + kopia działają. */
function instalacja({ bezPrzejscia = false } = {}) {
  const baza = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-przejscie-'));
  katalogi.push(baza);
  const oms = path.join(baza, 'opt-oms');
  for (const d of ['releases', 'config', 'data/etykiety', 'data/proformy', 'backups', '../docker-root']) fs.mkdirSync(path.join(oms, d), { recursive: true });
  const k = { baza: u(baza), oms: u(oms) };
  const db = new DatabaseSync(path.join(oms, 'data/oms.sqlite'));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE migracje (modul TEXT, numer INTEGER, nazwa TEXT, zastosowana_at TEXT, PRIMARY KEY (modul, numer))');
  db.exec("INSERT INTO migracje VALUES ('rdzen', 1, 'baseline', '2026-10-01')");
  db.exec('CREATE TABLE zamowienia (id INTEGER PRIMARY KEY, numer TEXT)');
  db.exec('CREATE TABLE konta (login TEXT)');
  db.exec("INSERT INTO konta VALUES ('administrator-proby')");
  for (const n of ['DEMO-001', 'DEMO-002', 'DEMO-003']) db.prepare('INSERT INTO zamowienia (numer) VALUES (?)').run(n);
  db.close();
  fs.writeFileSync(path.join(oms, 'data/proformy/demo.pdf'), 'proforma próby');
  fs.writeFileSync(path.join(oms, 'config/oms.env'), `OMS_TRYB=proba\nOMS_USER=serwis-proby\nOMS_PASS=${HASLO_PROBY}\nOMS_SPRZEDAWCA_NIP=1234563218\nOMS_RACHUNEK=34109010140000000000000000\n`);
  fs.writeFileSync(path.join(oms, 'config/administrator-proby.env'), 'login=administrator-proby\nhaslo=haslo-administratora-proby\n');
  fs.writeFileSync(path.join(oms, 'config/produkcja.env.example'), '# szablon z instalacji\n');
  // Kopia próby z DZIŚ: ta sama nazwa, którą dostanie pierwsza kopia pracy — powrót nie może ich pomylić.
  fs.writeFileSync(path.join(oms, `backups/oms-${DZIS}.sqlite`), 'kopia-proby');
  const pliki = new Map([
    [`${WYD}/wydanie.json`, Buffer.from(JSON.stringify({ commit: COMMIT, tree: 'e'.repeat(40) }) + '\n')],
    [`${WYD}/deploy/klient/compose.yaml`, Buffer.from('name: oms\n')],
    [`${WYD}/deploy/klient/.env`, Buffer.from(`OMS_REVISION=${COMMIT}\n`)],
    [`${WYD}/deploy/klient/aktualizuj.sh`, fs.readFileSync(AKTUALIZATOR)],
    [`${WYD}/deploy/klient/kopia.mjs`, fs.readFileSync(KOPIA)],
    // Wydanie sprzed PRZ-062 nie ma skryptu pierwszego startu pracy.
    ...(bezPrzejscia ? [] : [[`${WYD}/scripts/produkcja-pierwszy-start.mjs`, Buffer.from('// atrapa\n')]]),
  ]);
  const x = spawnSync('tar', ['-xzf', '-', '-C', u(path.join(oms, 'releases'))], { input: gzipSync(tarUstar(pliki, 1760000000)), encoding: 'utf8' });
  if (x.status !== 0) throw Error('tar: ' + x.stderr);
  const plikCompose = path.join(oms, 'releases', WYD, 'deploy/klient/compose.yaml');
  for (const args of [['compose', '-f', plikCompose, 'build', 'oms'], ['compose', '-f', plikCompose, 'up', '-d', 'oms', 'kopia']]) {
    const r = spawnSync(process.execPath, [ATRAPA, ...args], { encoding: 'utf8', env: { ...process.env, TEST_BAZA: k.baza, OMS_KATALOG: k.oms } });
    if (r.status !== 0) throw Error(r.stderr);
  }
  fs.copyFileSync(AKTUALIZATOR, path.join(oms, 'aktualizuj.sh'));
  return k;
}
function akt(k, args, env = {}) {
  const wrapper = path.join(k.baza, 'docker');
  if (!fs.existsSync(wrapper)) fs.writeFileSync(wrapper, `#!/bin/sh\nexport MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'\nexec "${u(process.execPath)}" "${u(ATRAPA)}" "$@"\n`, { mode: 0o755 });
  const r = spawnSync(SH, [`${k.oms}/aktualizuj.sh`, ...args], { encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, OMS_KATALOG: k.oms, OMS_DOCKER_BIN: u(wrapper), OMS_AKT_BEZ_ROOTA: '1', OMS_AKT_CZEKAJ_S: '3', OMS_AKT_ODSTEP_S: '1',
      OMS_AKT_MIN_DOCKER_MB: '1', OMS_AKT_REZERWA_MB: '1', TEST_BAZA: k.baza, ...env } });
  return { ...r, wyjscie: `${r.stdout}\n${r.stderr}` };
}
const plik = (k, p) => path.join(k.oms, p);
const istnieje = (k, p) => fs.existsSync(plik(k, p));
const czytaj = (k, p) => fs.readFileSync(plik(k, p), 'utf8');
const stanDockera = k => JSON.parse(fs.readFileSync(path.join(k.baza, 'docker-stan.json'), 'utf8'));
const operacja = r => /operacja=([0-9a-f-]{20})/.exec(r.wyjscie)?.[1];
const zapytaj = (k, p, sql) => { const d = new DatabaseSync(plik(k, p), { readOnly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };
const zamowienia = (k, p = 'data/oms.sqlite') => zapytaj(k, p, 'SELECT numer FROM zamowienia ORDER BY id').map(w => w.numer);
const konta = (k, p = 'data/oms.sqlite') => zapytaj(k, p, 'SELECT login FROM konta').map(w => w.login);

/** Pierwsze wywołanie zakłada szablon; uzupełnienie jak operator (nano). */
function uzupelnij(k, zmiany = {}) {
  const pola = { OMS_SPRZEDAWCA_NIP: '1111111111', OMS_RACHUNEK: '09109010140000000000000062', DPD_NADAWCA_NAZWA: 'Pracownia Przykładowa sp. z o.o.',
    DPD_NADAWCA_ULICA: 'Klockowa 1', DPD_NADAWCA_KOD: '00-950', DPD_NADAWCA_MIASTO: 'Warszawa', ...zmiany };
  let t = czytaj(k, 'config/produkcja.env');
  for (const [n, w] of Object.entries(pola)) t = t.match(new RegExp(`^${n}=`, 'm')) ? t.replace(new RegExp(`^${n}=.*$`, 'm'), `${n}=${w}`) : `${t}${n}=${w}\n`;
  fs.writeFileSync(plik(k, 'config/produkcja.env'), t);
}
function przelaczona(k, env = {}) {
  expect(akt(k, ['produkcja']).status).toBe(0);
  uzupelnij(k);
  const r = akt(k, ['produkcja'], env);
  return { r, op: operacja(r) };
}

describe('przejście próba → praca: przygotowanie i odmowy', () => {
  it('pierwsze wywołanie zakłada produkcja.env z losowym hasłem serwisowym i listą pól; próba nietknięta', () => {
    const k = instalacja();
    const przed = JSON.stringify(stanDockera(k).kontenery);
    const r = akt(k, ['produkcja']);
    expect(r.status, r.wyjscie).toBe(0);
    expect(r.stdout).toContain('UTWORZONO');
    expect(r.stdout).toContain('OMS_SPRZEDAWCA_NIP');
    // PRZ-102.20: rachunek też nie jest polem do uzupełnienia (można w panelu: Ustawienia → Firma) — w szablonie, pusty.
    expect(r.stdout).not.toContain('OMS_RACHUNEK');
    // PRZ-093.08: adres firmy już nie jest polem do uzupełnienia (można go wpisać w panelu) — jest w szablonie, pusty.
    expect(r.stdout).not.toContain('DPD_NADAWCA_');
    const t = czytaj(k, 'config/produkcja.env');
    for (const n of ['DPD_NADAWCA_NAZWA', 'DPD_NADAWCA_ULICA', 'DPD_NADAWCA_KOD', 'DPD_NADAWCA_MIASTO']) expect(t).toMatch(new RegExp(`^${n}=$`, 'm'));
    expect(t).toContain('Ustawienia → Firma');
    expect(t).toMatch(/^# Rachunek firmy[^\n]*\n#[^\n]*w panelu \(Ustawienia → Firma[^\n]*\nOMS_RACHUNEK=$/m);
    expect(t).toMatch(/^OMS_TRYB=produkcja$/m);
    expect(t).toMatch(/^OMS_PASS=[0-9a-f]{48}$/m);
    expect(t).toMatch(/^OMS_KANALY=\[\]$/m);
    expect(r.wyjscie).not.toContain(/^OMS_PASS=(.*)$/m.exec(t)[1]);
    if (process.platform !== 'win32') expect(fs.statSync(plik(k, 'config/produkcja.env')).mode & 0o777).toBe(0o600);
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(JSON.stringify(stanDockera(k).kontenery)).toBe(przed);
    // Drugie hasło nie powstaje: plik już jest, a puste pola są odmową z nazwami.
    const r2 = akt(k, ['produkcja']);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('PRODUKCJA_NIEWYPELNIONE_POLA: OMS_SPRZEDAWCA_NIP — ');
    expect(czytaj(k, 'config/produkcja.env')).toBe(t);
  });

  it('odmawia wartości przepisanych z próby (hasło serwisowe, fikcyjny NIP i rachunek) — nazwą, bez wartości', () => {
    const k = instalacja();
    akt(k, ['produkcja']);
    for (const [n, w] of [['OMS_PASS', HASLO_PROBY], ['OMS_SPRZEDAWCA_NIP', '1234563218'], ['OMS_RACHUNEK', '34109010140000000000000000']]) {
      uzupelnij(k, { [n]: w });
      const r = akt(k, ['produkcja']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`PRODUKCJA_WARTOSC_Z_PROBY: ${n}`);
      expect(r.wyjscie).not.toContain(HASLO_PROBY);
      uzupelnij(k, { OMS_PASS: 'c'.repeat(48), OMS_SPRZEDAWCA_NIP: '1111111111', OMS_RACHUNEK: '09109010140000000000000062' });
    }
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
  });

  it('pole w cudzysłowie albo z CRLF liczy się jak w compose; OMS_TRYB inny niż produkcja to brak', () => {
    const k = instalacja();
    akt(k, ['produkcja']);
    // PRZ-093.08: puste-w-cudzysłowie sprawdzane na NIP-ie (adres firmy przestał być wymagany).
    uzupelnij(k, { OMS_SPRZEDAWCA_NIP: '""', OMS_TRYB: 'proba' });
    // Druga, pusta linia OMS_USER na końcu: compose bierze OSTATNIĄ — więc to brak (recenzja D8 r1). PRZ-102.20: dawniej
    // sprawdzane na OMS_RACHUNEK, który przestał być wymagany (można go wpisać w panelu).
    fs.writeFileSync(plik(k, 'config/produkcja.env'), (czytaj(k, 'config/produkcja.env') + 'OMS_USER=\n').replaceAll('\n', '\r\n'));
    const r = akt(k, ['produkcja']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PRODUKCJA_NIEWYPELNIONE_POLA: OMS_TRYB(=produkcja) OMS_SPRZEDAWCA_NIP OMS_USER — ');
  });

  // PRZ-093.08: firma bez adresu w pliku przechodzi na pracę — adres wpisze w panelu (Ustawienia → Firma).
  it('bez adresu firmy w pliku przejście na pracę rusza (adres nie jest wymagany do startu)', () => {
    const k = instalacja();
    akt(k, ['produkcja']);
    uzupelnij(k, { DPD_NADAWCA_NAZWA: '', DPD_NADAWCA_ULICA: '', DPD_NADAWCA_KOD: '', DPD_NADAWCA_MIASTO: '' });
    const r = akt(k, ['produkcja']);
    expect(r.status, r.wyjscie).toBe(0);
    expect(r.stderr).not.toContain('PRODUKCJA_NIEWYPELNIONE_POLA');
    expect(r.stdout).toContain('NEEDS_ACCEPT operacja=');
  });

  // PRZ-102.20: firma bez rachunku w pliku przechodzi na pracę — rachunek wpisze w panelu (Ustawienia → Firma).
  it('bez rachunku w pliku przejście na pracę rusza (pusty rachunek nie jest ani brakiem, ani wartością z próby)', () => {
    const k = instalacja();
    akt(k, ['produkcja']);
    uzupelnij(k, { OMS_RACHUNEK: '' });
    const r = akt(k, ['produkcja']);
    expect(r.status, r.wyjscie).toBe(0);
    expect(r.stderr).not.toContain('PRODUKCJA_NIEWYPELNIONE_POLA');
    expect(r.stderr).not.toContain('PRODUKCJA_WARTOSC_Z_PROBY');
    expect(r.stdout).toContain('NEEDS_ACCEPT operacja=');
  });
});

describe('przejście próba → praca: przełączenie, accept, recover', () => {
  it('czysta baza obok: próba w archiwum z kopią, praca na pustej bazie z nowym kontem; accept kończy, drugie przejście odmawia', () => {
    const k = instalacja();
    const { r, op } = przelaczona(k);
    expect(r.status, r.wyjscie).toBe(0);
    expect(r.stdout).toContain(`NEEDS_ACCEPT operacja=${op}`);
    const arch = `proba-archiwum/${op}`;
    // Próba w całości w archiwum: baza z DEMO i kontem próby, kopia ze spójnością, jej konfiguracja i kopie.
    expect(zamowienia(k, `${arch}/data/oms.sqlite`)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(konta(k, `${arch}/data/oms.sqlite`)).toEqual(['administrator-proby']);
    expect(zamowienia(k, `${arch}/kopia/oms.sqlite`)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(czytaj(k, `${arch}/kopia/wynik.json`)).toContain('"integralnosc":"ok"');
    expect(czytaj(k, `${arch}/data/proformy/demo.pdf`)).toBe('proforma próby');
    expect(czytaj(k, `${arch}/config/oms.env`)).toMatch(/^OMS_TRYB=proba$/m);
    expect(czytaj(k, `${arch}/config/administrator-proby.env`)).toContain('administrator-proby');
    expect(czytaj(k, `${arch}/backups/oms-${DZIS}.sqlite`)).toBe('kopia-proby');
    // Praca: pusta baza, nowe konto, konfiguracja pracy na miejscu oms.env, dane konta w pliku (nie na ekranie).
    expect(zamowienia(k)).toEqual([]);
    expect(konta(k)).toEqual(['administrator']);
    expect(istnieje(k, 'data/proformy/demo.pdf')).toBe(false);
    expect(czytaj(k, 'config/oms.env')).toMatch(/^OMS_TRYB=produkcja$/m);
    expect(istnieje(k, 'config/produkcja.env')).toBe(false);
    expect(istnieje(k, 'config/administrator-proby.env')).toBe(false);
    expect(czytaj(k, 'config/administrator.env')).toBe('login=administrator\nhaslo=atrapa-haslo-administratora-0123456789\n');
    expect(r.wyjscie).not.toContain('atrapa-haslo-administratora');
    expect(r.wyjscie).not.toContain(/^OMS_PASS=(.*)$/m.exec(czytaj(k, 'config/oms.env'))[1]);
    // Pierwsza kopia pracy prawdziwym kopia.mjs: baza bez DEMO.
    expect(zamowienia(k, `backups/oms-${DZIS}.sqlite`)).toEqual([]);
    // Kolejność: zatrzymanie próby, kopia próby, dopiero potem start na nowej konfiguracji.
    const w = stanDockera(k).wywolania;
    const idx = f => w.findIndex(x => x.includes(f));
    expect(idx('run --rm')).toBeGreaterThan(idx('stop oms-kopia oms'));
    expect(w.findLastIndex(x => x.includes('up -d --no-build --no-deps --force-recreate oms'))).toBeGreaterThan(idx('run --rm'));
    expect(czytaj(k, 'update-state/blokada/stan')).toMatch(/^typ=produkcja$/m);
    expect(akt(k, ['status']).stdout).toContain(`dalej: odbiór pracy, potem accept ${op}`);
    // deploy w oknie odbioru odmawia.
    expect(akt(k, ['deploy', '/brak.tar.gz', 'f'.repeat(64)]).stderr).toContain('ODMOWA_TRWA_OPERACJA');

    const a = akt(k, ['accept', op]);
    expect(a.status, a.wyjscie).toBe(0);
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    expect(czytaj(k, 'update-state/biezace').trim()).toBe(WYD);
    expect(czytaj(k, 'update-state/historia')).toMatch(new RegExp(`${op} NEEDS_ACCEPT produkcja`));
    const drugi = akt(k, ['produkcja']);
    expect(drugi.status).toBe(1);
    expect(drugi.stderr).toContain('TO_NIE_JEST_PROBA');
    expect(zamowienia(k, `${arch}/data/oms.sqlite`)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
  });

  it('recover z okna odbioru wraca do próby: jej baza, konto, kopie i konfiguracja; praca odłożona, konfiguracja pracy znów w produkcja.env', () => {
    const k = instalacja();
    const { r, op } = przelaczona(k);
    expect(r.status, r.wyjscie).toBe(0);
    const konfPracy = czytaj(k, 'config/oms.env');
    const rc = akt(k, ['recover', op]);
    expect(rc.status, rc.wyjscie).toBe(0);
    expect(rc.stdout).toContain(`RECOVERED operacja=${op} — wróciła próba`);
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(konta(k)).toEqual(['administrator-proby']);
    expect(czytaj(k, 'config/oms.env')).toMatch(/^OMS_TRYB=proba$/m);
    expect(czytaj(k, 'config/produkcja.env')).toBe(konfPracy);
    expect(czytaj(k, 'config/administrator-proby.env')).toContain('administrator-proby');
    expect(istnieje(k, 'config/administrator.env')).toBe(false);
    expect(czytaj(k, `backups/oms-${DZIS}.sqlite`)).toBe('kopia-proby');
    const arch = plik(k, `proba-archiwum/${op}`);
    const odl = fs.readdirSync(arch).find(n => n.startsWith('produkcja-odlozona-'));
    expect(zamowienia(k, `proba-archiwum/${op}/${odl}/backups/oms-${DZIS}.sqlite`)).toEqual([]);
    expect(konta(k, `proba-archiwum/${op}/${odl}/data/oms.sqlite`)).toEqual(['administrator']);
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    expect(stanDockera(k).kontenery.oms.dziala).toBe(true);
    // Ponowne przejście po poprawkach działa (konfiguracja pracy czeka).
    const znowu = akt(k, ['produkcja']);
    expect(znowu.status, znowu.wyjscie).toBe(0);
    expect(zamowienia(k)).toEqual([]);
  });

  it('OMS odrzuca konfigurację pracy (pętla restartów): automatyczny powrót do próby, dziennik zachowany, blokada zdjęta', () => {
    const k = instalacja();
    akt(k, ['produkcja']);
    uzupelnij(k, { TEST_NIE_WSTANIE: '1' });
    const r = akt(k, ['produkcja']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('KANDYDAT_W_PETLI_RESTARTOW');
    expect(r.stderr).toContain('WYCOFANE na etapie uruchomione');
    // Powody z nazwą zmiennej (bez wartości), nie ogon stosu wywołań (próba na VM 10.10).
    expect(r.stderr).toContain('[rdzen] OMS_SPRZEDAWCA_NIP: niepoprawny NIP');
    expect(r.stderr).not.toContain('at przygotujModuly');
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(czytaj(k, 'config/oms.env')).toMatch(/^OMS_TRYB=proba$/m);
    expect(czytaj(k, 'config/produkcja.env')).toMatch(/^TEST_NIE_WSTANIE=1$/m);
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    const op = /proba-archiwum\/([0-9a-f-]{20})\//.exec(r.stderr)[1];
    expect(czytaj(k, `proba-archiwum/${op}/dziennik-nieudanej-produkcji.txt`)).toContain('OMS_SPRZEDAWCA_NIP');
    expect(stanDockera(k).kontenery.oms.zepsuty).toBeUndefined();
  });

  it('nieudane założenie konta: powrót do próby, bez pliku z danymi konta', () => {
    const k = instalacja();
    const { r } = przelaczona(k, { TEST_PIERWSZY_START_BLAD: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PRODUKCJA_PIERWSZY_START_NIEUDANY');
    expect(r.stderr).toContain('WYCOFANE na etapie konto');
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(istnieje(k, 'config/administrator.env')).toBe(false);
    expect(istnieje(k, 'config/administrator.env.tmp')).toBe(false);
  });

  it.each([
    ['kopia próby', 'run --rm'],
    ['start pracy', 'up -d --no-build --no-deps --force-recreate oms'],
    ['pierwszy start', 'node scripts/produkcja-pierwszy-start'],
  ])('kill -9 aktualizatora (%s): status mówi „recover”, recover przywraca próbę bez strat', (_n, fragment) => {
    const k = instalacja();
    akt(k, ['produkcja']);
    uzupelnij(k);
    const r = akt(k, ['produkcja'], { TEST_ZABIJ_PRZY: fragment });
    expect(r.status).not.toBe(0);
    const stan = czytaj(k, 'update-state/blokada/stan');
    const op = /^operacja=(.+)$/m.exec(stan)[1];
    expect(akt(k, ['status']).stdout).toContain(`dalej: recover ${op} (powrót do próby`);
    expect(akt(k, ['produkcja']).stderr).toContain('ODMOWA_TRWA_OPERACJA');
    const rc = akt(k, ['recover', op]);
    expect(rc.status, rc.wyjscie).toBe(0);
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(konta(k)).toEqual(['administrator-proby']);
    expect(czytaj(k, 'config/oms.env')).toMatch(/^OMS_TRYB=proba$/m);
    expect(czytaj(k, 'config/produkcja.env')).toMatch(/^OMS_TRYB=produkcja$/m);
    expect(czytaj(k, `backups/oms-${DZIS}.sqlite`)).toBe('kopia-proby');
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    expect(stanDockera(k).kontenery.oms.dziala).toBe(true);
  });
});

// Poprawki po recenzji D8 r1 (P3-3, P3-4, P3-5, P3-6).
describe('przejście próba → praca: odmowy i przerwania po recenzji', () => {
  it('wydanie bez skryptu przejścia: odmowa przed blokadą, próba nie zatrzymana', () => {
    const k = instalacja({ bezPrzejscia: true });
    akt(k, ['produkcja']); uzupelnij(k);
    const przed = JSON.stringify(stanDockera(k).kontenery);
    const r = akt(k, ['produkcja']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('WYDANIE_BEZ_PRZEJSCIA');
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    expect(JSON.stringify(stanDockera(k).kontenery)).toBe(przed);
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
  });

  it('recover po pracy z zamówieniami: odmowa bez --porzuc-prace (OMS pracuje dalej), z nim — powrót, praca odłożona', () => {
    const k = instalacja();
    const { r, op } = przelaczona(k);
    expect(r.status, r.wyjscie).toBe(0);
    const db = new DatabaseSync(plik(k, 'data/oms.sqlite'));
    db.prepare("INSERT INTO zamowienia (numer) VALUES ('PRAWDZIWE-1')").run(); db.close();
    const odmowa = akt(k, ['recover', op]);
    expect(odmowa.status).toBe(1);
    expect(odmowa.stderr).toContain('PRACA_MA_ZAMOWIENIA (1)');
    expect(odmowa.stderr).toContain(`recover ${op} --porzuc-prace`);
    expect(stanDockera(k).kontenery.oms.dziala).toBe(true);
    expect(zamowienia(k)).toEqual(['PRAWDZIWE-1']);
    expect(czytaj(k, 'update-state/blokada/stan')).toMatch(/^etap=czeka_na_akceptacje$/m);
    expect(akt(k, ['recover', op, '--przywroc-baze']).stderr).toContain('PRZYWROC_BAZE_NIE_DOTYCZY_PRZEJSCIA');
    const rc = akt(k, ['recover', op, '--porzuc-prace']);
    expect(rc.status, rc.wyjscie).toBe(0);
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    const odl = fs.readdirSync(plik(k, `proba-archiwum/${op}`)).find(n => n.startsWith('produkcja-odlozona-'));
    expect(zamowienia(k, `proba-archiwum/${op}/${odl}/data/oms.sqlite`)).toEqual(['PRAWDZIWE-1']);
  });

  it('skasowane archiwum próby przed decyzją: recover odmawia bez zatrzymania pracy, accept nadal możliwy', () => {
    const k = instalacja();
    const { r, op } = przelaczona(k);
    expect(r.status, r.wyjscie).toBe(0);
    fs.rmSync(plik(k, 'proba-archiwum'), { recursive: true, force: true });
    const rc = akt(k, ['recover', op]);
    expect(rc.status).toBe(1);
    expect(rc.stderr).toContain('POWROT_NIEMOZLIWY');
    expect(stanDockera(k).kontenery.oms.dziala).toBe(true);
    expect(czytaj(k, 'config/oms.env')).toMatch(/^OMS_TRYB=produkcja$/m);
    // Etap nie przeszedł w „przywracanie”: accept dalej kończy przejście.
    const a = akt(k, ['accept', op]);
    expect(a.status, a.wyjscie).toBe(0);
  });

  it.each([
    ['przed przeniesieniami (zatrzymanie)', 'stop oms-kopia oms'],
    ['po przeniesieniach (start próby)', 'up -d --no-build --no-deps --force-recreate oms'],
  ])('kill -9 w trakcie samego recover (%s): ponowny recover kończy powrót bez strat', (_n, fragment) => {
    const k = instalacja();
    const { r, op } = przelaczona(k);
    expect(r.status, r.wyjscie).toBe(0);
    const pierwszy = akt(k, ['recover', op], { TEST_ZABIJ_PRZY: fragment });
    expect(pierwszy.status).not.toBe(0);
    expect(czytaj(k, 'update-state/blokada/stan')).toMatch(/^etap=przywracanie$/m);
    expect(akt(k, ['status']).stdout).toContain(`dalej: recover ${op}`);
    const drugi = akt(k, ['recover', op]);
    expect(drugi.status, drugi.wyjscie).toBe(0);
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(konta(k)).toEqual(['administrator-proby']);
    expect(czytaj(k, `backups/oms-${DZIS}.sqlite`)).toBe('kopia-proby');
    expect(czytaj(k, 'config/oms.env')).toMatch(/^OMS_TRYB=proba$/m);
    expect(czytaj(k, 'config/produkcja.env')).toMatch(/^OMS_TRYB=produkcja$/m);
    const odl = fs.readdirSync(plik(k, `proba-archiwum/${op}`)).filter(n => n.startsWith('produkcja-odlozona-'));
    expect(odl.flatMap(n => fs.existsSync(plik(k, `proba-archiwum/${op}/${n}/data/oms.sqlite`)) ? [konta(k, `proba-archiwum/${op}/${n}/data/oms.sqlite`)] : [])).toEqual([['administrator']]);
    expect(stanDockera(k).kontenery.oms.dziala).toBe(true);
  });

  it('przerwanie w środku przełączania (dane próby już w archiwum, część kopii też, bez znacznika): recover przywraca wszystko', () => {
    const k = instalacja();
    fs.writeFileSync(plik(k, 'backups/oms-2026-10-08.sqlite'), 'kopia-proby-starsza');
    akt(k, ['produkcja']); uzupelnij(k);
    const r = akt(k, ['produkcja'], { TEST_ZABIJ_PRZY: 'run --rm' });
    expect(r.status).not.toBe(0);
    const op = /^operacja=(.+)$/m.exec(czytaj(k, 'update-state/blokada/stan'))[1];
    const arch = `proba-archiwum/${op}`;
    // Stan po przerwaniu shella w pół drogi pętli (czysty shell — atrapa nie ma tu punktu zabicia):
    fs.renameSync(plik(k, 'data'), plik(k, `${arch}/data`));
    fs.mkdirSync(plik(k, 'data'));
    fs.renameSync(plik(k, `backups/oms-${DZIS}.sqlite`), plik(k, `${arch}/backups/oms-${DZIS}.sqlite`));
    fs.writeFileSync(plik(k, 'update-state/blokada/stan'), czytaj(k, 'update-state/blokada/stan').replace(/^etap=.*$/m, 'etap=przelaczanie'));
    for (let i = 0; i < 2; i++) {
      const rc = akt(k, ['recover', op]);
      if (i === 0) expect(rc.status, rc.wyjscie).toBe(0);
      else expect(rc.stderr).toContain('BRAK_OPERACJI_W_TOKU');
    }
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(czytaj(k, `backups/oms-${DZIS}.sqlite`)).toBe('kopia-proby');
    expect(czytaj(k, 'backups/oms-2026-10-08.sqlite')).toBe('kopia-proby-starsza');
    expect(czytaj(k, 'config/oms.env')).toMatch(/^OMS_TRYB=proba$/m);
    expect(stanDockera(k).kontenery.oms.dziala).toBe(true);
  });
});
