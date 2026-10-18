// PRZ-059: aktualizator V0 instalacji klienta (deploy/klient/aktualizuj.sh). Testy całych sekwencji
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
import { fileURLToPath } from 'node:url';
import { tarUstar } from '../../scripts/paczka-klienta.mjs';

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

/** Instalacja jak po PRZ-058: wydanie A rozpakowane, obraz zbudowany, oms + kopia działają; bez wskaźnika. */
function instalacja() {
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
  db.close();
  fs.writeFileSync(path.join(oms, 'data/etykiety/e1.pdf'), 'etykieta');
  fs.writeFileSync(path.join(oms, 'data/proformy/p1.pdf'), 'proforma');
  fs.writeFileSync(path.join(oms, 'config/oms.env'), 'OMS_TRYB=proba\nOMS_PASS=tajne-haslo-serwisu\n');
  const a = paczka(k, 'A');
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
    // Kopia operacji: baza spójna (te same zamówienia), lista migracji, konfiguracja i pliki, odciski.
    const opdir = `backups/operacje/${op}`;
    expect(zamowienia(k, `${opdir}/oms.sqlite`)).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003']);
    expect(JSON.parse(czytaj(k, `${opdir}/migracje.json`))).toEqual([{ modul: 'rdzen', numer: 1, nazwa: 'baseline' }]);
    expect(czytaj(k, `${opdir}/config/oms.env`)).toBe(czytaj(k, 'config/oms.env'));
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
  it('PRZ-093: komunikat użycia recover podaje obie opcje (oba miejsca: brak operacji i nieznana opcja)', () => {
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
