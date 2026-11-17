// Aktualizator V0 instalacji klienta (deploy/klient/aktualizuj.sh). Testy całych sekwencji
// deploy → accept | recover i ich SKUTKÓW: wskaźnik wydania, blokada, obrazy kontenerów (atrapa dockera
// ze stanem), prawdziwa baza SQLite i kopia operacji robiona prawdziwym kopia.mjs.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tarUstar } from '../../scripts/paczka-klienta.mjs';
import { bajtyKlucza, idKlucza, nowyKlucz, utworzSejf } from '../../src/core/bezpieczenstwo/sejf-sekretow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AKTUALIZATOR = path.join(ROOT, 'deploy/klient/aktualizuj.sh');
const KOPIA = path.join(ROOT, 'deploy/klient/kopia.mjs');
const ATRAPA = path.join(ROOT, 'tests/instalacja/atrapa-dockera.mjs');
const SH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const u = p => p.replaceAll('\\', '/');
const sha = b => createHash('sha256').update(b).digest('hex');
const katalogi = [];
afterEach(() => { for (const k of katalogi.splice(0)) fs.rmSync(k, { recursive: true, force: true }); });

const COMMIT = { A: 'a'.repeat(39) + '1', B: 'b'.repeat(39) + '2', C: 'c'.repeat(39) + '3', D: 'd'.repeat(39) + '4' };
const wyd = c => `oms-${c.slice(0, 12)}`;

/** Paczka wydania w formacie paczka-klienta.mjs (ustar, root, jeden katalog oms-<12>). */
function paczka(k, nazwa, { commit = COMMIT[nazwa], znaczniki = [], dodatkowe = new Map(), aktualizator = fs.readFileSync(AKTUALIZATOR), wydanieJson } = {}) {
  const top = wyd(commit);
  const pliki = new Map([
    [`${top}/wydanie.json`, Buffer.from(wydanieJson ?? JSON.stringify({ commit, tree: 'e'.repeat(40), rodzaj: 'klient-docker' }, null, 2) + '\n')],
    [`${top}/deploy/klient/compose.yaml`, Buffer.from('name: oms\n')],
    [`${top}/deploy/klient/.env`, Buffer.from(`# wersja\nOMS_REVISION=${commit}\n`)],
    [`${top}/deploy/klient/aktualizuj.sh`, aktualizator],
    [`${top}/deploy/klient/kopia.mjs`, fs.readFileSync(KOPIA)],
    [`${top}/src/oms.js`, Buffer.from('// kod\n')],
    ...znaczniki.map(z => [`${top}/${z}`, Buffer.from('1')]),
    ...dodatkowe,
  ]);
  const bajty = gzipSync(tarUstar(pliki, 1760000000));
  const plik = path.join(k.paczki, `${nazwa}-${top}.tar.gz`);
  fs.writeFileSync(plik, bajty);
  return { plik: u(plik), sha: sha(bajty), top };
}

function docker(k, ...args) {
  return spawnSync(process.execPath, [ATRAPA, ...args], { encoding: 'utf8', env: { ...process.env, TEST_BAZA: k.baza, OMS_KATALOG: k.oms } });
}
const stanDockera = k => JSON.parse(fs.readFileSync(path.join(k.baza, 'docker-stan.json'), 'utf8'));
const kontener = (k, n) => stanDockera(k).kontenery[n];
const rewizja = (k, n) => stanDockera(k).obrazy[kontener(k, n).obraz].revision;

// Wydanie z narzędziem poświadczeń — scripts/sekrety.mjs w paczce przekazuje wywołanie prawdziwemu narzędziu.
const NARZEDZIE = Buffer.from(`import { uruchom } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/sekrety.mjs')).href)};\nprocess.exitCode = uruchom(process.argv.slice(2));\n`);
const SEKRET_INFAKT = '{"apiKey":"KONTROLA-INFAKT-sekret-12345"}';
const MIEJSCE_INFAKT = { tabela: 'konfiguracja_integracji', kolumna: 'sekrety_json', id: 'infakt' };
const wydanieJson = (commit, format) => JSON.stringify({ commit, tree: 'e'.repeat(40), rodzaj: 'klient-docker', ...(format === undefined ? {} : { formatSekretow: format }) }, null, 2) + '\n';
/** Paczka wydania znającego format poświadczeń `format`: z narzędziem i (domyślnie) startem szyfrującym bazę. */
function paczkaZSekretami(k, nazwa, { format = 1, znaczniki = ['TEST_SZYFRUJE'], commit = COMMIT[nazwa], ...reszta } = {}) {
  return paczka(k, nazwa, { ...reszta, commit, znaczniki, wydanieJson: wydanieJson(commit, format), dodatkowe: new Map([[`${wyd(commit)}/scripts/sekrety.mjs`, NARZEDZIE]]) });
}

/** Instalacja: wydanie A rozpakowane, obraz zbudowany, oms + kopia działają; bez wskaźnika. */
function instalacja({ formatA, dodatkoweA = new Map() } = {}) {
  const baza = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-akt-'));
  katalogi.push(baza);
  const oms = path.join(baza, 'opt-oms');
  for (const d of ['releases', 'config', 'data/etykiety', 'data/proformy', 'backups', '../paczki', '../docker-root']) fs.mkdirSync(path.join(oms, d), { recursive: true });
  const k = { baza: u(baza), oms: u(oms), paczki: path.join(baza, 'paczki') };
  const db = new DatabaseSync(path.join(oms, 'data/oms.sqlite'));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE migracje (modul TEXT, numer INTEGER, nazwa TEXT, zastosowana_at TEXT, PRIMARY KEY (modul, numer))');
  db.exec("INSERT INTO migracje VALUES ('rdzen', 1, 'baseline', '2026-10-01')");
  db.exec('CREATE TABLE zamowienia (id INTEGER PRIMARY KEY, numer TEXT)');
  db.exec('CREATE TABLE konta (login TEXT)');
  db.exec("INSERT INTO konta VALUES ('administrator-proby')");
  for (const n of ['DEMO-001', 'DEMO-002', 'DEMO-003']) db.prepare('INSERT INTO zamowienia (numer) VALUES (?)').run(n);
  // Poświadczenie integracji zapisane jawnie (baza sprzed szyfrowania) i tabela ustawień ze znacznikiem formatu.
  db.exec('CREATE TABLE ustawienia (klucz TEXT PRIMARY KEY, wartosc TEXT, zmienione_at TEXT)');
  db.exec('CREATE TABLE konfiguracja_integracji (integracja TEXT PRIMARY KEY, sekrety_json TEXT)');
  db.prepare("INSERT INTO konfiguracja_integracji VALUES ('infakt', ?)").run(SEKRET_INFAKT);
  db.close();
  fs.writeFileSync(path.join(oms, 'data/etykiety/e1.pdf'), 'etykieta');
  fs.writeFileSync(path.join(oms, 'data/proformy/p1.pdf'), 'proforma');
  fs.writeFileSync(path.join(oms, 'config/oms.env'), 'OMS_TRYB=proba\nOMS_PASS=tajne-haslo-serwisu\n');
  const a = paczka(k, 'A', { dodatkowe: dodatkoweA, ...(formatA === undefined ? {} : { wydanieJson: wydanieJson(COMMIT.A, formatA) }) });
  const x = spawnSync('tar', ['-xzf', '-', '-C', u(path.join(oms, 'releases'))], { input: fs.readFileSync(a.plik), encoding: 'utf8' });
  if (x.status !== 0) throw Error('tar: ' + x.stderr);
  const plikCompose = path.join(oms, 'releases', a.top, 'deploy/klient/compose.yaml');
  for (const args of [['compose', '-f', plikCompose, 'build', 'oms'], ['compose', '-f', plikCompose, 'up', '-d', 'oms', 'kopia']]) {
    const r = docker(k, ...args); if (r.status !== 0) throw Error(r.stderr);
  }
  fs.copyFileSync(AKTUALIZATOR, path.join(oms, 'aktualizuj.sh'));
  return k;
}

function akt(k, args, env = {}) {
  const wrapper = path.join(k.baza, 'docker');
  if (!fs.existsSync(wrapper)) {
    fs.writeFileSync(wrapper, `#!/bin/sh\nexport MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'\nexec "${u(process.execPath)}" "${u(ATRAPA)}" "$@"\n`, { mode: 0o755 });
  }
  const r = spawnSync(SH, [`${k.oms}/aktualizuj.sh`, ...args], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, OMS_KATALOG: k.oms, OMS_DOCKER_BIN: u(wrapper), OMS_AKT_BEZ_ROOTA: '1', OMS_AKT_CZEKAJ_S: '3', OMS_AKT_ODSTEP_S: '1',
      OMS_AKT_MIN_DOCKER_MB: '1', OMS_AKT_REZERWA_MB: '1', TEST_BAZA: k.baza, ...env },
  });
  return { ...r, wyjscie: `${r.stdout}\n${r.stderr}` };
}
const plik = (k, p) => path.join(k.oms, p);
const istnieje = (k, p) => fs.existsSync(plik(k, p));
const czytaj = (k, p) => fs.readFileSync(plik(k, p), 'utf8');
const operacja = r => /operacja=([0-9a-f-]{20})/.exec(r.wyjscie)?.[1];
const zamowienia = (k, p = 'data/oms.sqlite') => {
  const d = new DatabaseSync(plik(k, p), { readOnly: true });
  try { return d.prepare('SELECT numer FROM zamowienia ORDER BY id').all().map(w => w.numer); } finally { d.close(); }
};
const migracjeBazy = k => {
  const d = new DatabaseSync(plik(k, 'data/oms.sqlite'), { readOnly: true });
  try { return d.prepare('SELECT modul, numer FROM migracje ORDER BY modul, numer').all().map(w => `${w.modul}/${w.numer}`); } finally { d.close(); }
};
function zainstalujAktualizatorZ(k, p) {
  const r = spawnSync('tar', ['-xzOf', '-', `${p.top}/deploy/klient/aktualizuj.sh`], { input: fs.readFileSync(p.plik) });
  fs.writeFileSync(plik(k, 'aktualizuj.sh'), r.stdout);
}

describe('aktualizator V0: deploy → accept', () => {
  it('instalacja sprzed aktualizatora: adopcja, kopia operacji przy zatrzymanym OMS, kandydat na swoim obrazie, accept przesuwa wskaźnik', () => {
    const k = instalacja();
    const obrazA = kontener(k, 'oms').obraz;
    const b = paczka(k, 'B');
    expect(akt(k, ['status']).stdout).toContain('biezace: brak wskaźnika');
    const r = akt(k, ['deploy', b.plik, b.sha]);
    expect(r.status, r.wyjscie).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`NEEDS_ACCEPT operacja=[0-9a-f-]{20} cel=${COMMIT.B} obraz=sha256:[0-9a-f]{64} przerwa_s=\\d+`));
    const op = operacja(r);
    // Kandydat działa na obrazie zbudowanym z B; oba kontenery na tym samym obrazie.
    expect(rewizja(k, 'oms')).toBe(COMMIT.B);
    expect(kontener(k, 'oms-kopia').obraz).toBe(kontener(k, 'oms').obraz);
    expect(kontener(k, 'oms').obraz).not.toBe(obrazA);
    // Blokada trzyma do decyzji; wskaźnik nadal na A (adopcja zapisała go pod blokadą).
    expect(czytaj(k, 'update-state/blokada/stan')).toMatch(/^etap=czeka_na_akceptacje$/m);
    expect(czytaj(k, 'update-state/biezace').trim()).toBe(wyd(COMMIT.A));
    // Kopia operacji: baza spójna (te same zamówienia), lista migracji, NAZWY zmiennych konfiguracji (
    // bez wartości — recover konfiguracji nie przywraca) i pliki, odciski.
    const opdir = `backups/operacje/${op}`;
    expect(zamowienia(k, `${opdir}/oms.sqlite`)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(JSON.parse(czytaj(k, `${opdir}/migracje.json`))).toEqual([{ modul: 'rdzen', numer: 1, nazwa: 'baseline' }]);
    expect(istnieje(k, `${opdir}/config/oms.env`)).toBe(false);
    expect(czytaj(k, `${opdir}/config/nazwy-zmiennych.txt`)).toBe('oms.env OMS_TRYB\noms.env OMS_PASS\n');
    expect(czytaj(k, `${opdir}/pliki/etykiety/e1.pdf`)).toBe('etykieta');
    expect(czytaj(k, `${opdir}/pliki/proformy/p1.pdf`)).toBe('proforma');
    expect(czytaj(k, `${opdir}/kopia.sha256`)).toContain('./oms.sqlite');
    // Kolejność skutków: zatrzymanie OMS przed kopią, kopia przed startem kandydata.
    const w = stanDockera(k).wywolania;
    const idx = f => w.findIndex(x => x.includes(f));
    expect(idx('stop oms')).toBeGreaterThan(idx(`${wyd(COMMIT.B)}/deploy/klient/compose.yaml build oms`));
    expect(idx('run --rm')).toBeGreaterThan(idx('stop oms'));
    expect(idx(`${wyd(COMMIT.B)}/deploy/klient/compose.yaml up`)).toBeGreaterThan(idx('run --rm'));
    // Hasło z konfiguracji nie trafia na ekran.
    expect(r.wyjscie).not.toContain('tajne-haslo-serwisu');
    // Wydanie B rozpakowane z odciskami i sumą paczki; A nietknięte.
    expect(czytaj(k, `releases/${b.top}/.paczka.sha256`).trim()).toBe(b.sha);
    expect(istnieje(k, `releases/${wyd(COMMIT.A)}/wydanie.json`)).toBe(true);

    const a = akt(k, ['accept', op]);
    expect(a.status, a.wyjscie).toBe(0);
    expect(a.stdout).toContain(`ACCEPTED operacja=${op} wydanie=${wyd(COMMIT.B)}`);
    expect(czytaj(k, 'update-state/biezace').trim()).toBe(wyd(COMMIT.B));
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(czytaj(k, 'update-state/historia')).toMatch(new RegExp(`${op} ACCEPT ${wyd(COMMIT.A)} -> ${wyd(COMMIT.B)}`));
    const s = akt(k, ['status']).stdout;
    expect(s).toContain(`biezace: ${wyd(COMMIT.B)}`);
    expect(s).toContain('blokada: brak');
  });

  it('druga operacja odmawia, gdy pierwsza trwa; accept i recover obcej operacji odmawiają — bez zmian stanu', () => {
    const k = instalacja();
    const b = paczka(k, 'B'); const c = paczka(k, 'C');
    const op = operacja(akt(k, ['deploy', b.plik, b.sha]));
    const przed = { stan: czytaj(k, 'update-state/blokada/stan'), docker: JSON.stringify(stanDockera(k).kontenery) };
    const r = akt(k, ['deploy', c.plik, c.sha]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`ODMOWA_TRWA_OPERACJA ${op}`);
    expect(istnieje(k, `releases/${c.top}`)).toBe(false);
    const obca = '20990101-000000-ffff';
    expect(akt(k, ['accept', obca]).stderr).toContain('NIE_TA_OPERACJA');
    expect(akt(k, ['recover', obca]).stderr).toContain('NIE_TA_OPERACJA');
    expect(czytaj(k, 'update-state/blokada/stan')).toBe(przed.stan);
    expect(JSON.stringify(stanDockera(k).kontenery)).toBe(przed.docker);
  });
});

describe('aktualizator V0: recover', () => {
  it('komunikat użycia recover podaje obie opcje (oba miejsca: brak operacji i nieznana opcja)', () => {
    const k = instalacja();
    const bezOperacji = akt(k, ['recover']);
    expect(bezOperacji.status).not.toBe(0);
    expect(bezOperacji.stderr).toContain('recover <operacja> [--przywroc-baze | --porzuc-prace]');
    const zlaOpcja = akt(k, ['recover', '20990101-000000-ffff', '--zla-opcja']);
    expect(zlaOpcja.status).not.toBe(0);
    expect(zlaOpcja.stderr).toContain('[--przywroc-baze | --porzuc-prace]');
  });

  function poAkceptacjiB() {
    const k = instalacja();
    const b = paczka(k, 'B');
    expect(akt(k, ['accept', operacja(akt(k, ['deploy', b.plik, b.sha]))]).status).toBe(0);
    return { k, obrazB: kontener(k, 'oms').obraz };
  }

  it('zepsuty start kandydata: deploy kończy się błędem i trzyma blokadę; recover wraca do poprzedniego obrazu, dane bez strat', () => {
    const { k, obrazB } = poAkceptacjiB();
    const c = paczka(k, 'C', { znaczniki: ['TEST_ZEPSUTY'] });
    zainstalujAktualizatorZ(k, c);
    const r = akt(k, ['deploy', c.plik, c.sha]);
    expect(r.status).toBe(1);
    // Proces pada w kółko: koniec czekania po trzecim restarcie, nie po pełnym limicie (krótsza przerwa).
    expect(r.stderr).toContain('KANDYDAT_W_PETLI_RESTARTOW');
    expect(r.stderr).toContain('recover');
    const stan = czytaj(k, 'update-state/blokada/stan');
    expect(stan).toMatch(/^etap=uruchomione$/m);
    const op = /^operacja=(.+)$/m.exec(stan)[1];
    expect(akt(k, ['status']).stdout).toContain(`dalej: recover ${op}`);
    expect(akt(k, ['accept', op]).stderr).toContain('NIEPRAWIDLOWY_ETAP');
    const rec = akt(k, ['recover', op]);
    expect(rec.status, rec.wyjscie).toBe(0);
    expect(rec.stdout).toContain(`RECOVERED operacja=${op} wydanie=${wyd(COMMIT.B)} obraz=${obrazB}`);
    expect(rec.stdout).toContain('MIGRACJE bez zmian');
    // Zawieszony start (bez restartów) kończy się po limicie czekania.
    const k2 = instalacja();
    const w = paczka(k2, 'B', { znaczniki: ['TEST_WISI'] });
    const r2 = akt(k2, ['deploy', w.plik, w.sha], { OMS_AKT_CZEKAJ_S: '2' });
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('OMS_NIE_WSTAL w 2 s');
    // /health 200, ale w kontenerze inny kod: sam 200 nie identyfikuje kodu — odmowa NEEDS_ACCEPT.
    const k3 = instalacja();
    const inny = paczka(k3, 'B', { znaczniki: ['TEST_INNY_KOD'] });
    const r3 = akt(k3, ['deploy', inny.plik, inny.sha]);
    expect(r3.status).toBe(1);
    expect(r3.stderr).toContain('WERSJA_W_KONTENERZE_NIEZGODNA');
    expect(r3.stdout).not.toContain('NEEDS_ACCEPT');
    expect(czytaj(k3, 'update-state/blokada/stan')).toMatch(/^etap=uruchomione$/m);
    expect(kontener(k, 'oms')).toEqual({ obraz: obrazB, dziala: true });
    expect(kontener(k, 'oms-kopia')).toEqual({ obraz: obrazB, dziala: true });
    expect(czytaj(k, 'update-state/biezace').trim()).toBe(wyd(COMMIT.B));
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
  });

  it('kandydat zmigrował bazę: recover domyślnie zostawia bazę i mówi o migracji; --przywroc-baze wraca do kopii operacji, obecną odkłada', () => {
    for (const przywroc of [false, true]) {
      const { k, obrazB } = poAkceptacjiB();
      const c = paczka(k, 'C', { znaczniki: ['TEST_MIGRACJA', 'TEST_ZEPSUTY'] });
      zainstalujAktualizatorZ(k, c);
      const op = /^operacja=(.+)$/m.exec((akt(k, ['deploy', c.plik, c.sha]), czytaj(k, 'update-state/blokada/stan')))[1];
      expect(migracjeBazy(k)).toEqual(['rdzen/1', 'rdzen/99']);
      expect(zamowienia(k)).toHaveLength(4);
      const rec = akt(k, przywroc ? ['recover', op, '--przywroc-baze'] : ['recover', op]);
      expect(rec.status, rec.wyjscie).toBe(0);
      expect(rec.stdout).toContain('MIGRACJE kandydat zmienił listę migracji względem kopii operacji: {"nowe":["rdzen/99 proba-kandydata"],"brakujace":[]}');
      expect(kontener(k, 'oms').obraz).toBe(obrazB);
      if (przywroc) {
        expect(rec.stdout).toContain('przywracam bazę z kopii operacji');
        expect(migracjeBazy(k)).toEqual(['rdzen/1']);
        expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
        const odlozone = fs.readdirSync(plik(k, `backups/operacje/${op}`)).filter(n => n.startsWith('po-kandydacie-'));
        expect(odlozone).toHaveLength(1);
        expect(zamowienia(k, `backups/operacje/${op}/${odlozone[0]}/oms.sqlite`)).toHaveLength(4);
      } else {
        expect(rec.stdout).toContain('--przywroc-baze');
        expect(migracjeBazy(k)).toEqual(['rdzen/1', 'rdzen/99']);
        expect(zamowienia(k)).toHaveLength(4);
      }
    }
  });

  it('powtórzony recover --przywroc-baze (stare wydanie nie wstało) nie nadpisuje odłożonej bazy kandydata', () => {
    const { k, obrazB } = poAkceptacjiB();
    const c = paczka(k, 'C', { znaczniki: ['TEST_MIGRACJA', 'TEST_ZEPSUTY'] });
    zainstalujAktualizatorZ(k, c);
    akt(k, ['deploy', c.plik, c.sha]);
    const op = /^operacja=(.+)$/m.exec(czytaj(k, 'update-state/blokada/stan'))[1];
    // B nie wstaje (np. start dłuższy niż limit na wolnym eMMC) — pierwsza próba kończy się błędem.
    const zepsuj = plik(k, `releases/${wyd(COMMIT.B)}/TEST_WISI`);
    fs.writeFileSync(zepsuj, '1');
    const r1 = akt(k, ['recover', op, '--przywroc-baze'], { OMS_AKT_CZEKAJ_S: '1' });
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain('POWROT_NIEUDANY');
    expect(czytaj(k, 'update-state/blokada/stan')).toMatch(/^etap=przywracanie$/m);
    fs.rmSync(zepsuj);
    const r2 = akt(k, ['recover', op, '--przywroc-baze']);
    expect(r2.status, r2.wyjscie).toBe(0);
    expect(r2.stdout).toContain('BAZA już przywrócona w tej operacji — pomijam');
    expect(kontener(k, 'oms').obraz).toBe(obrazB);
    const odlozone = fs.readdirSync(plik(k, `backups/operacje/${op}`)).filter(n => n.startsWith('po-kandydacie'));
    expect(odlozone).toHaveLength(1);
    // Zamówienie zapisane przez kandydata przetrwało w odłożonej bazie.
    expect(zamowienia(k, `backups/operacje/${op}/${odlozone[0]}/oms.sqlite`).some(n => n.startsWith('PO-KANDYDACIE'))).toBe(true);
    expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
  });

  it('accept przerwany po zapisaniu wskaźnika: recover odmawia (wróciłby pod nogami), drugi accept kończy', () => {
    const k = instalacja();
    const b = paczka(k, 'B');
    const op = operacja(akt(k, ['deploy', b.plik, b.sha]));
    const a = akt(k, ['accept', op], { TEST_ZABIJ_PRZY: 'builder prune' });
    expect(a.status).not.toBe(0);
    expect(czytaj(k, 'update-state/biezace').trim()).toBe(wyd(COMMIT.B));
    expect(czytaj(k, 'update-state/blokada/stan')).toMatch(/^etap=akceptowanie$/m);
    expect(akt(k, ['recover', op]).stderr).toContain('AKCEPTACJA_JUZ_ZAPISANA');
    const a2 = akt(k, ['accept', op]);
    expect(a2.status, a2.wyjscie).toBe(0);
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
  });
});

describe('aktualizator V0: przerwanie w połowie (kill -9, restart maszyny)', () => {
  // [opis, fragment polecenia dockera, przy którym ginie proces, etap w blokadzie, czy stary OMS działa po kill]
  const punkty = [
    ['budowanie obrazu', 'compose.yaml build oms', 'rozpakowane', true],
    ['zatrzymywanie OMS', 'stop oms-kopia oms', 'zatrzymane', true],
    ['kopia operacji', 'run --rm', 'zatrzymane', false],
    ['start kandydata', `${wyd(COMMIT.B)}/deploy/klient/compose.yaml up -d --no-build --no-deps --force-recreate oms`, 'uruchomione', false],
  ];
  for (const [opis, fragment, etap, staryDziala] of punkty) {
    it(`${opis}: status mówi prawdę, blokada trzyma, drugi deploy odmawia, recover wraca do działającej wersji`, () => {
      const k = instalacja();
      const obrazA = kontener(k, 'oms').obraz;
      const b = paczka(k, 'B');
      const r = akt(k, ['deploy', b.plik, b.sha], { TEST_ZABIJ_PRZY: fragment });
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(path.join(k.baza, 'zabito'))).toBe(true);
      const stan = czytaj(k, 'update-state/blokada/stan');
      expect(stan).toMatch(new RegExp(`^etap=${etap}$`, 'm'));
      const op = /^operacja=(.+)$/m.exec(stan)[1];
      // Restart maszyny: kontenery zatrzymane przez aktualizację nie wstają same (restart: unless-stopped).
      expect(kontener(k, 'oms').dziala && kontener(k, 'oms').obraz === obrazA).toBe(staryDziala);
      const s = akt(k, ['status']).stdout;
      expect(s).toContain('blokada: TAK');
      expect(s).toContain('proces aktualizatora nie działa');
      expect(s).toContain(`dalej: recover ${op}`);
      if (!staryDziala) expect(s).toMatch(/kontener oms: exited|OMS ZATRZYMANY|kandydat wystartował/);
      const drugi = akt(k, ['deploy', b.plik, b.sha]);
      expect(drugi.status).toBe(1);
      expect(drugi.stderr).toContain(`ODMOWA_TRWA_OPERACJA ${op}`);
      const rec = akt(k, ['recover', op]);
      expect(rec.status, rec.wyjscie).toBe(0);
      expect(kontener(k, 'oms')).toEqual({ obraz: obrazA, dziala: true });
      expect(kontener(k, 'oms-kopia')).toEqual({ obraz: obrazA, dziala: true });
      expect(czytaj(k, 'update-state/biezace').trim()).toBe(wyd(COMMIT.A));
      expect(istnieje(k, 'update-state/blokada')).toBe(false);
      expect(zamowienia(k)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
      // Po powrocie ta sama paczka przechodzi od nowa (rozpakowane wydanie użyte ponownie po kontroli odcisków).
      const ponownie = akt(k, ['deploy', b.plik, b.sha]);
      expect(ponownie.status, ponownie.wyjscie).toBe(0);
      expect(ponownie.stdout).toContain('NEEDS_ACCEPT');
    });
  }

  it('błąd przed zatrzymaniem (build) zdejmuje blokadę bez przerwy w pracy; błąd kopii operacji przywraca stare wydanie', () => {
    const k = instalacja();
    const obrazA = kontener(k, 'oms').obraz;
    const b = paczka(k, 'B', { znaczniki: ['TEST_BUILD_BLAD'] });
    const r = akt(k, ['deploy', b.plik, b.sha]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PRZERWANE na etapie rozpakowane');
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    expect(stanDockera(k).wywolania.some(w => w.startsWith('stop'))).toBe(false);
    expect(kontener(k, 'oms')).toEqual({ obraz: obrazA, dziala: true });
    const k2 = instalacja();
    const b2 = paczka(k2, 'B');
    const r2 = akt(k2, ['deploy', b2.plik, b2.sha], { TEST_KOPIA_BLAD: '1' });
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('KOPIA_OPERACJI_NIEUDANA');
    expect(r2.stderr).toContain('WYCOFANE na etapie zatrzymane');
    expect(istnieje(k2, 'update-state/blokada')).toBe(false);
    expect(kontener(k2, 'oms')).toEqual({ obraz: kontener(k2, 'oms-kopia').obraz, dziala: true });
    expect(rewizja(k2, 'oms')).toBe(COMMIT.A);
  });
});

describe('aktualizator V0: preflight odmawia przed jakąkolwiek zmianą', () => {
  const przypadki = [
    ['zły odcisk', (k) => { const p = paczka(k, 'B'); return [p.plik, 'f'.repeat(64)]; }, 'PACZKA_USZKODZONA_LUB_PODMIENIONA'],
    ['ścieżka z ..', (k) => { const p = paczka(k, 'B', { dodatkowe: new Map([[`${wyd(COMMIT.B)}/../wyjscie.txt`, Buffer.from('x')]]) }); return [p.plik, p.sha]; }, 'PACZKA_NIEBEZPIECZNA_SCIEZKA'],
    ['drugi katalog w paczce', (k) => { const p = paczka(k, 'B', { dodatkowe: new Map([['zzz/plik', Buffer.from('x')]]) }); return [p.plik, p.sha]; }, 'PACZKA_WIELE_KATALOGOW'],
    ['dowiązanie symboliczne', (k) => {
      const p = paczka(k, 'B');
      // Wpis typu „2” (symlink) wskazujący poza wydanie, dopisany do zgodnego archiwum ustar.
      const tar = gunzipSync(fs.readFileSync(p.plik));
      const h = Buffer.alloc(512, 0); h.write(`${p.top}/zly`, 0); h.write('0000777\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
      h.write('00000000000\0', 124); h.write('14740000000\0', 136); h.fill(0x20, 148, 156); h.write('2', 156); h.write('/etc/passwd', 157); h.write('ustar\0', 257); h.write('00', 263);
      let s = 0; for (const x of h) s += x; h.write(s.toString(8).padStart(6, '0') + '\0 ', 148);
      const bajty = gzipSync(Buffer.concat([tar.subarray(0, tar.length - 1024), h, Buffer.alloc(1024, 0)]));
      fs.writeFileSync(p.plik, bajty); return [p.plik, sha(bajty)];
    }, 'PACZKA_NIEDOZWOLONY_TYP_WPISU'],
    ['wydanie.json bez commita', (k) => { const p = paczka(k, 'B', { wydanieJson: '{}' }); return [p.plik, p.sha]; }, 'PACZKA_ZLY_WYDANIE_JSON'],
    ['katalog niezgodny z commitem', (k) => { const p = paczka(k, 'B', { wydanieJson: JSON.stringify({ commit: COMMIT.C, tree: 'e'.repeat(40) }) }); return [p.plik, p.sha]; }, 'PACZKA_KATALOG_NIEZGODNY_Z_COMMITEM'],
    ['ta sama wersja', (k) => { const p = paczka(k, 'A'); return [p.plik, p.sha]; }, 'WERSJA_DOCELOWA_TAKA_SAMA_JAK_BIEZACA'],
    ['istniejące inne wydanie', (k) => { const p = paczka(k, 'B'); fs.mkdirSync(plik(k, `releases/${p.top}`)); fs.writeFileSync(plik(k, `releases/${p.top}/wydanie.json`), 'cudze'); return [p.plik, p.sha]; }, 'WYDANIE_ISTNIEJE_I_JEST_INNE'],
    ['aktualizator spoza paczki', (k) => { const p = paczka(k, 'B', { aktualizator: Buffer.from('#!/bin/sh\necho inny\n') }); return [p.plik, p.sha]; }, 'AKTUALIZATOR_INNY_NIZ_W_PACZCE'],
    ['za mało miejsca dla Dockera', (k) => { const p = paczka(k, 'B'); return [p.plik, p.sha, { OMS_AKT_MIN_DOCKER_MB: '999999999' }]; }, 'BRAK_MIEJSCA_DOCKER'],
    ['za mało miejsca na kopię i wydanie', (k) => { const p = paczka(k, 'B'); return [p.plik, p.sha, { OMS_AKT_REZERWA_MB: '999999999' }]; }, 'BRAK_MIEJSCA_OMS'],
    ['kontener działa na innym wydaniu niż wskaźnik', (k) => { const p = paczka(k, 'B'); fs.mkdirSync(plik(k, 'update-state')); fs.writeFileSync(plik(k, 'update-state/biezace'), `${wyd(COMMIT.D)}\n`); fs.mkdirSync(plik(k, `releases/${wyd(COMMIT.D)}`)); fs.writeFileSync(plik(k, `releases/${wyd(COMMIT.D)}/wydanie.json`), JSON.stringify({ commit: COMMIT.D })); return [p.plik, p.sha]; }, 'BAZA_KONTENER_Z_INNEGO_WYDANIA'],
  ];
  for (const [opis, przygotuj, kod] of przypadki) {
    it(opis, () => {
      const k = instalacja();
      const [plikPaczki, odcisk, env = {}] = przygotuj(k);
      const przedDocker = JSON.stringify(stanDockera(k).kontenery);
      const wywolanPrzed = stanDockera(k).wywolania.length;
      const przedWydania = fs.readdirSync(plik(k, 'releases')).sort();
      const r = akt(k, ['deploy', plikPaczki, odcisk], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(kod);
      expect(istnieje(k, 'update-state/blokada')).toBe(false);
      expect(istnieje(k, 'backups/operacje')).toBe(false);
      expect(fs.readdirSync(plik(k, 'releases')).sort()).toEqual(przedWydania);
      expect(JSON.stringify(stanDockera(k).kontenery)).toBe(przedDocker);
      expect(stanDockera(k).wywolania.slice(wywolanPrzed).some(w => /compose .* build|^stop|^run|^tag/.test(w))).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(k.oms), 'wyjscie.txt'))).toBe(false);
    });
  }

  it('$ w oms.env: ostrzeżenie z nazwą zmiennej, bez wartości (apostrofy nie ostrzegają)', () => {
    const k = instalacja();
    fs.writeFileSync(plik(k, 'config/oms.env'), "OMS_PASS=ab$cd-tajne\nINFAKT_API_KEY='x$y-tajne'\nSMTP_PASS=\"q$w-tajne\"\n");
    const r = akt(k, ['status']);
    expect(r.wyjscie).toContain('UWAGA_DOLAR_W_KONFIGURACJI');
    expect(r.wyjscie).toMatch(/: OMS_PASS —/);
    expect(r.wyjscie).toMatch(/: SMTP_PASS —/);
    expect(r.wyjscie).not.toMatch(/: INFAKT_API_KEY —/);
    expect(r.wyjscie).not.toContain('tajne');
  });
});

describe('aktualizator V0: obsługa bez wskaźnika i po awarii zapisu', () => {
  it('świeża instalacja po compose down: compose up -d wraca na jedyne wydanie (bez wskaźnika i kontenerów)', () => {
    const k = instalacja();
    const s = stanDockera(k); s.kontenery = {}; fs.writeFileSync(path.join(k.baza, 'docker-stan.json'), JSON.stringify(s));
    const r = akt(k, ['compose', 'up', '-d', 'oms', 'kopia']);
    expect(r.status, r.wyjscie).toBe(0);
    expect(rewizja(k, 'oms')).toBe(COMMIT.A);
    // Dwa wydania bez wskaźnika: odmowa z podpowiedzią zamiast zgadywania.
    fs.mkdirSync(plik(k, `releases/${wyd(COMMIT.B)}`));
    const s2 = stanDockera(k); s2.kontenery = {}; fs.writeFileSync(path.join(k.baza, 'docker-stan.json'), JSON.stringify(s2));
    const r2 = akt(k, ['compose', 'up', '-d', 'oms', 'kopia']);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('BRAK_WSKAZNIKA_I_KONTENERA');
  });

  it('pusty plik stanu blokady (utrata zasilania tuż po zapisie) = blokada bez stanu: status mówi, recover nieznana zdejmuje', () => {
    const k = instalacja();
    fs.mkdirSync(plik(k, 'update-state/blokada'), { recursive: true });
    fs.writeFileSync(plik(k, 'update-state/blokada/stan'), '');
    expect(akt(k, ['status']).stdout).toContain('blokada: BEZ STANU');
    const r = akt(k, ['recover', 'nieznana']);
    expect(r.status, r.wyjscie).toBe(0);
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
  });
});

describe('aktualizator V0: retencja', () => {
  it('po kolejnych akceptacjach zostają bieżące i 2 poprzednie wydania oraz 2 kopie operacji; obraz najstarszego usunięty', () => {
    const k = instalacja();
    const obrazA = kontener(k, 'oms').obraz;
    for (const n of ['B', 'C', 'D']) {
      const p = paczka(k, n);
      zainstalujAktualizatorZ(k, p);
      const r = akt(k, ['deploy', p.plik, p.sha]);
      expect(r.status, r.wyjscie).toBe(0);
      expect(akt(k, ['accept', operacja(r)]).status).toBe(0);
    }
    expect(fs.readdirSync(plik(k, 'releases')).filter(n => n.startsWith('oms-')).sort()).toEqual([wyd(COMMIT.B), wyd(COMMIT.C), wyd(COMMIT.D)].sort());
    expect(fs.readdirSync(plik(k, 'backups/operacje'))).toHaveLength(2);
    // Operacja z odłożoną bazą kandydata (po --przywroc-baze) nie znika w retencji — to jedyny ślad zapisów z okna odbioru.
    const stara = path.join(plik(k, 'backups/operacje'), '20260101-000000-aaaa');
    fs.mkdirSync(path.join(stara, 'po-kandydacie-20260101-000100'), { recursive: true });
    const e = paczka(k, 'A', { commit: 'e'.repeat(39) + '5' });
    zainstalujAktualizatorZ(k, e);
    const r = akt(k, ['deploy', e.plik, e.sha]);
    expect(akt(k, ['accept', operacja(r)]).stdout).toContain('RETENCJA zostawiam 20260101-000000-aaaa');
    expect(fs.existsSync(stara)).toBe(true);
    expect(stanDockera(k).tagi[`oms:${COMMIT.A}`]).toBeUndefined();
    expect(stanDockera(k).tagi[`oms:${COMMIT.C}`]).toBeDefined();
    expect(stanDockera(k).wywolania.some(w => w.startsWith('builder prune -f --filter until=168h'))).toBe(true);
    expect(obrazA).toBeTruthy();
  });
});

// --- Poświadczenia integracji szyfrowane w bazie -----------------------------------------------------

const wszystkiePliki = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? wszystkiePliki(path.join(d, e.name)) : [path.join(d, e.name)]));
const zBazy = (k, sql) => { const d = new DatabaseSync(plik(k, 'data/oms.sqlite'), { readOnly: true }); try { return d.prepare(sql).get(); } finally { d.close(); } };
const sekretBazy = k => zBazy(k, "SELECT sekrety_json AS w FROM konfiguracja_integracji WHERE integracja = 'infakt'").w;
const formatBazy = k => zBazy(k, "SELECT wartosc AS w FROM ustawienia WHERE klucz = 'sekrety.format'")?.w ?? null;
const kluczZPliku = k => /^OMS_KLUCZ_SEKRETOW=(.+)$/m.exec(czytaj(k, 'config/klucz.env'))?.[1];
const idK = klucz => idKlucza(bajtyKlucza(klucz));
const wywolania = k => stanDockera(k).wywolania;
const idx = (k, fragment, od = 0) => wywolania(k).findIndex((w, i) => i >= od && w.includes(fragment));
const startOms = c => `${wyd(c)}/deploy/klient/compose.yaml up -d --no-build --no-deps --force-recreate oms`;
function zapiszKlucz(k, klucz = nowyKlucz()) {
  fs.writeFileSync(plik(k, 'config/klucz.env'), `OMS_KLUCZ_SEKRETOW=${klucz}\n`, { mode: 0o600 });
  return klucz;
}
/** Baza w formacie 1: poświadczenie zaszyfrowane kluczem `klucz`. */
function zaszyfrujBaze(k, klucz) {
  const d = new DatabaseSync(plik(k, 'data/oms.sqlite'));
  try {
    d.prepare("UPDATE konfiguracja_integracji SET sekrety_json = ? WHERE integracja = 'infakt'").run(utworzSejf(bajtyKlucza(klucz)).szyfruj(SEKRET_INFAKT, MIEJSCE_INFAKT));
    d.prepare("INSERT OR REPLACE INTO ustawienia VALUES ('sekrety.format', '1', '2026-11-17')").run();
  } finally { d.close(); }
}
function ustawFormat(k, format) {
  const d = new DatabaseSync(plik(k, 'data/oms.sqlite'));
  try { d.prepare("INSERT OR REPLACE INTO ustawienia VALUES ('sekrety.format', ?, '2026-11-17')").run(String(format)); } finally { d.close(); }
}
/** Instalacja sprzed szyfrowania (A) po deploy wydania B, które przy starcie zaszyfrowało bazę; czeka na odbiór. */
function poDeployuSzyfrujacym() {
  const k = instalacja();
  const obrazA = kontener(k, 'oms').obraz;
  const b = paczkaZSekretami(k, 'B');
  const r = akt(k, ['deploy', b.plik, b.sha]);
  expect(r.status, r.wyjscie).toBe(0);
  return { k, r, op: operacja(r), obrazA, obrazB: kontener(k, 'oms').obraz };
}

describe('deploy wydania z poświadczeniami szyfrowanymi w bazie', () => {
  it('klucz zapewniony obrazem kandydata PRZED zatrzymaniem OMS-u; plik 600; komunikat z plikiem i id; kandydat szyfruje bazę', () => {
    const { k, r, obrazB } = poDeployuSzyfrujacym();
    const klucz = kluczZPliku(k);
    expect(bajtyKlucza(klucz)).not.toBeNull();
    expect(r.stdout).toContain(`KLUCZ_POSWIADCZEN ${k.oms}/config/klucz.env id ${idK(klucz)}`);
    expect(r.stdout).toContain('menedżerze haseł');
    expect(r.wyjscie).not.toContain(klucz);
    if (process.platform !== 'win32') expect(fs.statSync(plik(k, 'config/klucz.env')).mode & 0o777).toBe(0o600);
    const iKlucz = idx(k, 'sekrety.mjs klucz-zapewnij --plik /opt/oms/config/klucz.env');
    expect(iKlucz).toBeGreaterThan(-1);
    expect(wywolania(k)[iKlucz]).toContain(obrazB);
    expect(iKlucz).toBeLessThan(idx(k, 'stop oms-kopia oms'));
    expect(sekretBazy(k)).toMatch(new RegExp(`^oms1\\.${idK(klucz)}\\.`));
    expect(formatBazy(k)).toBe('1');
    expect(czytaj(k, 'update-state/blokada/stan')).toMatch(new RegExp(`^klucz_id=${idK(klucz)}$`, 'm'));
  });

  it('kopia operacji: bez klucza i bez wartości z oms.env i kopia.env (cała przeszukana), tylko nazwy; recover nie przywraca konfiguracji', () => {
    const k = instalacja();
    fs.writeFileSync(plik(k, 'config/kopia.env'), 'OMS_KOPIA_ZEWNETRZNA=/opt/oms/kopia-zewnetrzna\r\nKOPIA_KONTROLA=kopia-env-wartosc-kontrolna\n');
    const b = paczkaZSekretami(k, 'B');
    const r = akt(k, ['deploy', b.plik, b.sha]);
    expect(r.status, r.wyjscie).toBe(0);
    const op = operacja(r);
    const klucz = kluczZPliku(k);
    const pliki = wszystkiePliki(plik(k, `backups/operacje/${op}`));
    for (const n of ['klucz.env', 'oms.env', 'kopia.env']) expect(pliki.some(p => path.basename(p) === n), n).toBe(false);
    for (const p of pliki) {
      const t = fs.readFileSync(p).toString('latin1');
      for (const zakazane of ['tajne-haslo-serwisu', 'kopia-env-wartosc-kontrolna', klucz]) expect(t.includes(zakazane), `${p}: ${zakazane === klucz ? 'klucz' : zakazane}`).toBe(false);
    }
    expect(czytaj(k, `backups/operacje/${op}/config/nazwy-zmiennych.txt`)).toBe('oms.env OMS_TRYB\noms.env OMS_PASS\nkopia.env OMS_KOPIA_ZEWNETRZNA\nkopia.env KOPIA_KONTROLA\n');
    // Poprawka konfiguracji z okna odbioru przeżywa powrót z kopią operacji.
    fs.appendFileSync(plik(k, 'config/oms.env'), 'POPRAWKA_Z_OKNA=1\n');
    const trescKlucza = czytaj(k, 'config/klucz.env');
    const rec = akt(k, ['recover', op, '--przywroc-baze']);
    expect(rec.status, rec.wyjscie).toBe(0);
    expect(czytaj(k, 'config/oms.env')).toContain('POPRAWKA_Z_OKNA=1');
    expect(czytaj(k, 'config/klucz.env')).toBe(trescKlucza);
  });

  it('istniejący zgodny klucz: sprawdz obrazem kandydata przed zatrzymaniem, plik klucza bez zmian', () => {
    const k = instalacja();
    const klucz = zapiszKlucz(k);
    zaszyfrujBaze(k, klucz);
    const b = paczkaZSekretami(k, 'B');
    const r = akt(k, ['deploy', b.plik, b.sha]);
    expect(r.status, r.wyjscie).toBe(0);
    expect(czytaj(k, 'config/klucz.env')).toBe(`OMS_KLUCZ_SEKRETOW=${klucz}\n`);
    expect(r.stdout).toContain(`id ${idK(klucz)}`);
    const iSprawdz = idx(k, 'sekrety.mjs sprawdz --baza /opt/oms/data/oms.sqlite');
    expect(iSprawdz).toBeGreaterThan(idx(k, 'sekrety.mjs klucz-zapewnij'));
    expect(iSprawdz).toBeLessThan(idx(k, 'stop oms-kopia oms'));
    expect(sekretBazy(k)).toMatch(new RegExp(`^oms1\\.${idK(klucz)}\\.`));
  });

  const odmowy = [
    ['brak pliku klucza przy szyfrogramach w bazie', () => {}, 'Brak pliku klucza'],
    ['klucz niezgodny z bazą', k => { zapiszKlucz(k); }, 'KLUCZ_NIEZGODNY'],
    ['pusty plik klucza (ucięty po awarii)', k => fs.writeFileSync(plik(k, 'config/klucz.env'), ''), 'pusty albo ucięty'],
  ];
  for (const [opis, przygotuj, kod] of odmowy) {
    it(`odmowa przed zatrzymaniem — ${opis}: stare wydanie pracuje, blokada zdjęta, plik klucza bez zmian`, () => {
      const k = instalacja();
      const obrazA = kontener(k, 'oms').obraz;
      zaszyfrujBaze(k, nowyKlucz());
      przygotuj(k);
      const przed = istnieje(k, 'config/klucz.env') ? czytaj(k, 'config/klucz.env') : null;
      const b = paczkaZSekretami(k, 'B');
      const r = akt(k, ['deploy', b.plik, b.sha]);
      expect(r.status, r.wyjscie).toBe(1);
      expect(r.wyjscie).toContain(kod);
      expect(r.stderr).toContain('PRZERWANE na etapie zbudowane');
      expect(wywolania(k).some(w => w.startsWith('stop'))).toBe(false);
      expect(kontener(k, 'oms')).toEqual({ obraz: obrazA, dziala: true });
      expect(istnieje(k, 'update-state/blokada')).toBe(false);
      expect(istnieje(k, 'config/klucz.env') ? czytaj(k, 'config/klucz.env') : null).toBe(przed);
    });
  }
});

describe('recover — decyzja po stanie bazy', () => {
  it('konwersja zakończona: po zatrzymaniu kandydata odszyfrowanie obrazem kandydata, dopiero potem start starego wydania', () => {
    const { k, op, obrazA, obrazB } = poDeployuSzyfrujacym();
    expect(formatBazy(k)).toBe('1');
    const od = wywolania(k).length;
    const rec = akt(k, ['recover', op]);
    expect(rec.status, rec.wyjscie).toBe(0);
    expect(rec.stdout).toContain('ODSZYFROWANE wartości: 1');
    expect(sekretBazy(k)).toBe(SEKRET_INFAKT);
    expect(formatBazy(k)).toBeNull();
    const iStop = idx(k, 'stop oms-kopia oms', od);
    const iOdsz = idx(k, 'sekrety.mjs odszyfruj --baza /opt/oms/data/oms.sqlite', od);
    const iStart = idx(k, startOms(COMMIT.A), od);
    expect(iStop).toBeGreaterThan(-1);
    expect(iOdsz).toBeGreaterThan(iStop);
    expect(iStart).toBeGreaterThan(iOdsz);
    expect(wywolania(k)[iOdsz]).toContain(obrazB);
    expect(kontener(k, 'oms')).toEqual({ obraz: obrazA, dziala: true });
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
  });

  it('kandydat nie wystartował (przerwanie przy jego starcie): odszyfruj bez zmian, baza nietknięta, stare wydanie wraca', () => {
    const k = instalacja();
    const obrazA = kontener(k, 'oms').obraz;
    const b = paczkaZSekretami(k, 'B');
    const r = akt(k, ['deploy', b.plik, b.sha], { TEST_ZABIJ_PRZY: startOms(COMMIT.B) });
    expect(r.status).not.toBe(0);
    const stan = czytaj(k, 'update-state/blokada/stan');
    expect(stan).toMatch(/^etap=uruchomione$/m);
    expect(sekretBazy(k)).toBe(SEKRET_INFAKT);
    const rec = akt(k, ['recover', /^operacja=(.+)$/m.exec(stan)[1]]);
    expect(rec.status, rec.wyjscie).toBe(0);
    expect(rec.stdout).toContain('ODSZYFROWANE wartości: 0');
    expect(sekretBazy(k)).toBe(SEKRET_INFAKT);
    expect(formatBazy(k)).toBeNull();
    expect(kontener(k, 'oms')).toEqual({ obraz: obrazA, dziala: true });
  });

  it('odszyfrowanie zakończone i przerwanie przed startem starego obrazu: powtórne recover kończy bez ponownej zmiany', () => {
    const { k, op, obrazA } = poDeployuSzyfrujacym();
    const r1 = akt(k, ['recover', op], { TEST_ZABIJ_PRZY: startOms(COMMIT.A) });
    expect(r1.status).not.toBe(0);
    expect(sekretBazy(k)).toBe(SEKRET_INFAKT);
    expect(czytaj(k, 'update-state/blokada/stan')).toMatch(/^etap=przywracanie$/m);
    const r2 = akt(k, ['recover', op]);
    expect(r2.status, r2.wyjscie).toBe(0);
    expect(r2.stdout).toContain('ODSZYFROWANE wartości: 0');
    expect(sekretBazy(k)).toBe(SEKRET_INFAKT);
    expect(kontener(k, 'oms')).toEqual({ obraz: obrazA, dziala: true });
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
  });

  it('odszyfrowanie nieudane (brak klucza): blokada zostaje, stary obraz nie startuje, podpowiedź --przywroc-baze; po wstawieniu klucza powtórne recover kończy', () => {
    const { k, op, obrazA } = poDeployuSzyfrujacym();
    const tresc = czytaj(k, 'config/klucz.env');
    fs.rmSync(plik(k, 'config/klucz.env'));
    const od = wywolania(k).length;
    const r1 = akt(k, ['recover', op]);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain('ODSZYFROWANIE_NIEUDANE');
    expect(r1.stderr).toContain(`recover ${op} --przywroc-baze`);
    expect(r1.stderr).toMatch(/znikną/);
    expect(idx(k, startOms(COMMIT.A), od)).toBe(-1);
    expect(kontener(k, 'oms').obraz === obrazA && kontener(k, 'oms').dziala).toBe(false);
    expect(czytaj(k, 'update-state/blokada/stan')).toMatch(/^etap=przywracanie$/m);
    expect(sekretBazy(k)).toMatch(/^oms1\./);
    fs.writeFileSync(plik(k, 'config/klucz.env'), tresc, { mode: 0o600 });
    const r2 = akt(k, ['recover', op]);
    expect(r2.status, r2.wyjscie).toBe(0);
    expect(sekretBazy(k)).toBe(SEKRET_INFAKT);
    expect(kontener(k, 'oms')).toEqual({ obraz: obrazA, dziala: true });
  });

  it('powrót z kopią operacji (--przywroc-baze): konwerter nie jest uruchamiany, baza z kopii w formacie 0', () => {
    const { k, op, obrazA } = poDeployuSzyfrujacym();
    const od = wywolania(k).length;
    const rec = akt(k, ['recover', op, '--przywroc-baze']);
    expect(rec.status, rec.wyjscie).toBe(0);
    expect(wywolania(k).slice(od).some(w => w.includes('sekrety.mjs'))).toBe(false);
    expect(sekretBazy(k)).toBe(SEKRET_INFAKT);
    expect(formatBazy(k)).toBeNull();
    expect(kontener(k, 'oms')).toEqual({ obraz: obrazA, dziala: true });
  });

  it('brak pasującego konwertera (wydanie bazowe zna format 1, baza w formacie 2): odmowa przed zatrzymaniem; --przywroc-baze wraca', () => {
    const k = instalacja({ formatA: 1 });
    const obrazA = kontener(k, 'oms').obraz;
    const c = paczkaZSekretami(k, 'C', { format: 2, znaczniki: ['TEST_ZEPSUTY'] });
    const r = akt(k, ['deploy', c.plik, c.sha]);
    expect(r.status).toBe(1);
    const stan = czytaj(k, 'update-state/blokada/stan');
    expect(stan).toMatch(/^etap=uruchomione$/m);
    const op = /^operacja=(.+)$/m.exec(stan)[1];
    ustawFormat(k, 2); // kandydat zdążył zapisać bazę w swoim formacie
    const od = wywolania(k).length;
    const r1 = akt(k, ['recover', op]);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain('FORMAT_BEZ_KONWERTERA');
    expect(r1.stderr).toContain('--przywroc-baze');
    expect(wywolania(k).slice(od).some(w => w.startsWith('stop'))).toBe(false);
    expect(czytaj(k, 'update-state/blokada/stan')).toMatch(/^etap=uruchomione$/m);
    const r2 = akt(k, ['recover', op, '--przywroc-baze']);
    expect(r2.status, r2.wyjscie).toBe(0);
    expect(formatBazy(k)).toBeNull();
    expect(kontener(k, 'oms')).toEqual({ obraz: obrazA, dziala: true });
  });
});

describe('aktualizuj.sh sekrety — narzędzie poświadczeń', () => {
  function poAkceptacji() {
    const s = poDeployuSzyfrujacym();
    const a = akt(s.k, ['accept', s.op]);
    expect(a.status, a.wyjscie).toBe(0);
    return s;
  }

  it('zapis przy pracującym OMS-ie = odmowa bez zmian i bez blokady; odczyt (stan, sprawdz) bez blokady i bez zatrzymania', () => {
    const { k } = poAkceptacji();
    const klucz = kluczZPliku(k);
    const od = wywolania(k).length;
    for (const polecenie of [['odszyfruj'], ['sprzataj'], ['porzuc', '--potwierdz-wszystkie']]) {
      const z = akt(k, ['sekrety', ...polecenie]);
      expect(z.status, polecenie.join(' ')).toBe(1);
      expect(z.stderr).toContain('SEKRETY_OMS_DZIALA');
      expect(istnieje(k, 'update-state/blokada')).toBe(false);
    }
    expect(formatBazy(k)).toBe('1');
    const s = akt(k, ['sekrety', 'stan']);
    expect(s.status, s.wyjscie).toBe(0);
    expect(s.stdout).toContain(`wymagane id kluczy: ${idK(klucz)}`);
    const p = akt(k, ['sekrety', 'sprawdz']);
    expect(p.status, p.wyjscie).toBe(0);
    expect(p.stdout).toContain('KLUCZ_ZGODNY');
    expect(`${s.wyjscie}${p.wyjscie}`).not.toContain(klucz);
    expect(wywolania(k).slice(od).some(w => w.startsWith('stop'))).toBe(false);
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    expect(kontener(k, 'oms').dziala).toBe(true);
    // Ścieżkę pliku klucza ustala aktualizator, nie wołający.
    expect(akt(k, ['sekrety', 'klucz-zapewnij', '--plik', '/tmp/inny.env']).stderr).toContain('SEKRETY_PLIK_KLUCZA_STALY');
  });

  it('narzędzie dostępne po nieudanej aktualizacji mimo starego wskaźnika (obraz kandydata ze stanu operacji)', () => {
    const k = instalacja();
    const s0 = akt(k, ['sekrety', 'stan']);
    expect(s0.status).toBe(1);
    expect(s0.stderr).toContain('NARZEDZIE_SEKRETOW_NIEDOSTEPNE');
    const b = paczkaZSekretami(k, 'B', { znaczniki: ['TEST_ZEPSUTY'] });
    expect(akt(k, ['deploy', b.plik, b.sha]).status).toBe(1);
    expect(czytaj(k, 'update-state/biezace').trim()).toBe(wyd(COMMIT.A));
    const obrazB = /^cel_obraz=(.+)$/m.exec(czytaj(k, 'update-state/blokada/stan'))[1];
    const od = wywolania(k).length;
    const s = akt(k, ['sekrety', 'stan']);
    expect(s.status, s.wyjscie).toBe(0);
    expect(s.stdout).toContain('konfiguracja_integracji.sekrety_json: jawne 1');
    expect(wywolania(k)[idx(k, 'sekrety.mjs stan', od)]).toContain(obrazB);
  });

  it('porzuc --nowy-klucz po utracie klucza: przy zatrzymanym OMS-ie nowy plik klucza, poświadczenia porzucone, blokada zdjęta', () => {
    const { k } = poAkceptacji();
    const stary = kluczZPliku(k);
    fs.rmSync(plik(k, 'config/klucz.env'));
    expect(akt(k, ['compose', 'stop', 'oms', 'kopia']).status).toBe(0);
    const r = akt(k, ['sekrety', 'porzuc', '--nowy-klucz', '--potwierdz-wszystkie']);
    expect(r.status, r.wyjscie).toBe(0);
    const nowy = kluczZPliku(k);
    expect(bajtyKlucza(nowy)).not.toBeNull();
    expect(nowy).not.toBe(stary);
    expect(r.stdout).toContain(`KLUCZ_UTWORZONY id ${idK(nowy)}`);
    expect(r.stdout).toContain('PORZUCONE: integracja:infakt');
    expect(r.stdout).toContain('compose up -d');
    expect(r.wyjscie).not.toContain(nowy);
    if (process.platform !== 'win32') expect(fs.statSync(plik(k, 'config/klucz.env')).mode & 0o777).toBe(0o600);
    expect(sekretBazy(k)).toBe('{}');
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
    expect(akt(k, ['sekrety', 'sprawdz']).stdout).toContain('KLUCZ_ZGODNY');
  });

  it('przerwana operacja narzędzia (kill -9): blokada zostaje, deploy odmawia, ponowienie kończy i zdejmuje blokadę', () => {
    const { k } = poAkceptacji();
    expect(akt(k, ['compose', 'stop', 'oms', 'kopia']).status).toBe(0);
    const r1 = akt(k, ['sekrety', 'odszyfruj'], { TEST_ZABIJ_PRZY: 'sekrety.mjs odszyfruj' });
    expect(r1.status).not.toBe(0);
    const stan = czytaj(k, 'update-state/blokada/stan');
    expect(stan).toMatch(/^typ=sekrety$/m);
    expect(formatBazy(k)).toBe('1');
    const s = akt(k, ['status']).stdout;
    expect(s).toContain('blokada: TAK');
    expect(s).toContain('dalej: ponów `sekrety');
    const c = paczka(k, 'C');
    expect(akt(k, ['deploy', c.plik, c.sha]).stderr).toContain('ODMOWA_TRWA_OPERACJA');
    const r2 = akt(k, ['sekrety', 'odszyfruj']);
    expect(r2.status, r2.wyjscie).toBe(0);
    expect(r2.stdout).toContain('ODSZYFROWANE wartości: 1');
    expect(formatBazy(k)).toBeNull();
    expect(istnieje(k, 'update-state/blokada')).toBe(false);
  });
});

describe('przejście próba → praca a klucz poświadczeń', () => {
  const zPrzejsciem = () => instalacja({ dodatkoweA: new Map([[`${wyd(COMMIT.A)}/scripts/produkcja-pierwszy-start.mjs`, Buffer.from('// atrapa\n')]]) });

  it('klucz.env zostaje na miejscu (nie trafia do archiwum); accept usuwa z archiwum kopię produkcja.env, próba zostaje', () => {
    const k = zPrzejsciem();
    const klucz = zapiszKlucz(k);
    expect(akt(k, ['produkcja']).status).toBe(0);
    const r = akt(k, ['produkcja']);
    expect(r.status, r.wyjscie).toBe(0);
    const op = operacja(r);
    const arch = plik(k, `proba-archiwum/${op}`);
    expect(czytaj(k, 'config/klucz.env')).toBe(`OMS_KLUCZ_SEKRETOW=${klucz}\n`);
    expect(wszystkiePliki(arch).some(p => path.basename(p) === 'klucz.env')).toBe(false);
    expect(wszystkiePliki(arch).some(p => fs.readFileSync(p).toString('latin1').includes(klucz))).toBe(false);
    expect(fs.existsSync(path.join(arch, 'config/produkcja.env'))).toBe(true);
    const a = akt(k, ['accept', op]);
    expect(a.status, a.wyjscie).toBe(0);
    expect(fs.existsSync(path.join(arch, 'config/produkcja.env'))).toBe(false);
    expect(fs.readFileSync(path.join(arch, 'config/oms.env'), 'utf8')).toMatch(/^OMS_TRYB=proba$/m);
    expect(czytaj(k, 'config/klucz.env')).toBe(`OMS_KLUCZ_SEKRETOW=${klucz}\n`);
  });

  it('powrót do próby (recover) nie rusza klucz.env', () => {
    const k = zPrzejsciem();
    const klucz = zapiszKlucz(k);
    expect(akt(k, ['produkcja']).status).toBe(0);
    const op = operacja(akt(k, ['produkcja']));
    const rec = akt(k, ['recover', op]);
    expect(rec.status, rec.wyjscie).toBe(0);
    expect(czytaj(k, 'config/klucz.env')).toBe(`OMS_KLUCZ_SEKRETOW=${klucz}\n`);
    expect(wszystkiePliki(plik(k, `proba-archiwum/${op}`)).some(p => path.basename(p) === 'klucz.env')).toBe(false);
  });
});
