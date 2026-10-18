// PRZ-058: instalacja OMS w Dockerze u klienta — compose, obraz, pierwszy start i paczka wydania.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const KLIENT = path.join(ROOT, 'deploy/klient');
const compose = () => fs.readFileSync(path.join(KLIENT, 'compose.yaml'), 'utf8');
const dockerfile = () => fs.readFileSync(path.join(KLIENT, 'Dockerfile'), 'utf8');
const katalogi = [];
function katalog() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-kontener-')); katalogi.push(p); return p; }
afterEach(() => { for (const p of katalogi.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

// Wycinek jednej usługi z compose.yaml (wcięcie 2 spacje) — bez parsera YAML w zależnościach.
function usluga(nazwa) {
  const linie = compose().split(/\r?\n/);
  const start = linie.indexOf(`  ${nazwa}:`);
  if (start < 0) throw new Error('Brak usługi ' + nazwa);
  const koniec = linie.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  return linie.slice(start, koniec < 0 ? undefined : koniec).join('\n');
}

describe('compose i obraz klienta PRZ-058', () => {
  it('jest neutralny: zero nazw firmy autora, kanałów i adresów sieci domowej', () => {
    for (const tekst of [compose(), dockerfile(), ...['diagnostyka.sh', 'aktualizuj.sh', 'kopia.mjs'].map(p => fs.readFileSync(path.join(KLIENT, p), 'utf8'))]) {
      expect(tekst).not.toMatch(/szkicownia|lumina|zetaklient|drugamarka|trzeciamarka|synology|volume1|192\.168|panel-zamowien/i);
    }
  });

  it('usługi wstają same po restarcie, dane leżą w /opt/oms według planu aktualizatora', () => {
    expect(compose()).toMatch(/^name: oms$/m);
    for (const nazwa of ['oms', 'kopia']) {
      const u = usluga(nazwa);
      expect(u).toContain('restart: unless-stopped');
      expect(u).toContain('- /opt/oms/data:/opt/oms/data');
    }
    expect(usluga('oms')).toContain('container_name: oms\n');
    expect(usluga('kopia')).toContain('container_name: oms-kopia');
    expect(usluga('kopia')).toContain('- /opt/oms/backups:/opt/oms/backups');
    // PRZ-059: kopia klienta (kopia.mjs) zamiast pętli produkcji: archiwum plików z rotacją, nośnik zewnętrzny.
    expect(usluga('kopia')).toContain('OMS_KOPIE_KATALOG: /opt/oms/backups');
    expect(usluga('kopia')).toContain('OMS_DB_PATH: /opt/oms/data/oms.sqlite');
    expect(usluga('kopia')).toContain('OMS_ETYKIETY_KATALOG: /opt/oms/data/etykiety');
    expect(usluga('kopia')).toContain('OMS_PROFORMY_KATALOG: /opt/oms/data/proformy');
    expect(usluga('kopia')).not.toContain('UPLOAD_DIR');
    expect(usluga('kopia')).toContain('path: /opt/oms/config/kopia.env');
    expect(usluga('kopia')).not.toContain('oms.env');
    // Nośnik zewnętrzny: zapis tylko w kontenerze kopii; rslave — pendrive podłączony po starcie też widoczny.
    expect(usluga('kopia')).toMatch(/- type: bind\n {8}source: \/opt\/oms\/kopia-zewnetrzna\n {8}target: \/opt\/oms\/kopia-zewnetrzna\n {8}bind: \{ propagation: rslave, create_host_path: true \}/);
    expect(usluga('oms')).toMatch(/- type: bind\n {8}source: \/opt\/oms\/kopia-zewnetrzna\n {8}target: \/opt\/oms\/kopia-zewnetrzna\n {8}read_only: true\n(.*\n)* {8}bind: \{ propagation: rslave, create_host_path: true \}/);
    // OMS widzi kopie tylko do odczytu i ma włączony nadzór kopii w /health.
    expect(usluga('oms')).toContain('- /opt/oms/backups:/opt/oms/backups:ro');
    expect(usluga('oms')).toContain('OMS_KOPIE_KATALOG: /opt/oms/backups');
    expect(usluga('oms')).toContain('path: /opt/oms/config/kopia.env');
    expect(usluga('oms')).toContain('start_interval: 5s');
    // Przed instalacją kopia nie może wystartować i założyć pustej bazy.
    expect(usluga('kopia')).toMatch(/depends_on:\n {6}oms:\n {8}condition: service_healthy/);
    expect(usluga('kopia')).toContain('command: ["node", "deploy/klient/kopia.mjs", "petla"]');
    // Kopia i instalacja nie potrzebują sieci; instalacja nie wstaje przy `up`.
    expect(usluga('kopia')).toContain('network_mode: none');
    expect(usluga('instalacja')).toContain('network_mode: none');
    expect(usluga('instalacja')).toContain('profiles: [instalacja]');
    expect(usluga('instalacja')).toContain('- /opt/oms/config:/opt/oms/config');
    // Konfiguracja nie jest montowana w działającym OMS — compose czyta ją na hoście.
    expect(usluga('oms')).not.toContain('/opt/oms/config:');
    expect(usluga('oms')).toContain('path: /opt/oms/config/oms.env');
  });

  it('ścieżki danych OMS są przybite do wolumenu, port wystawiony do LAN, proxy bez zaufania', () => {
    const u = usluga('oms');
    for (const linia of ['OMS_DB_PATH: /opt/oms/data/oms.sqlite', 'OMS_PROFORMY_KATALOG: /opt/oms/data/proformy',
      'OMS_ETYKIETY_KATALOG: /opt/oms/data/etykiety', 'OMS_ETYKIETY_DIR: /opt/oms/data/etykiety', 'OMS_PORT: "3001"']) {
      expect(u).toContain(linia);
    }
    // LAN po IPv4; bez adresu Docker publikuje też [::] — globalny IPv6 bez zapory = panel w internecie.
    expect(u).toContain('- "0.0.0.0:${OMS_PORT_LAN:-3001}:3001"');
    expect(u).not.toMatch(/ports:\s*\n\s*- "?127\.0\.0\.1:/);
    expect(compose()).not.toContain('OMS_TRUST_PROXY');
  });

  it('obraz: lokalny build z etykietą revision, bez roota, bez rejestru', () => {
    expect(compose()).toMatch(/image: oms:\$\{OMS_REVISION:-lokalny\}/);
    expect(compose()).toContain('pull_policy: never');
    expect(usluga('oms')).toMatch(/APP_REVISION: \$\{OMS_REVISION:-nieznana\}/);
    const d = dockerfile();
    // PRZ-059: obraz bazowy przypięty skrótem indeksu (amd64 i arm64).
    expect(d).toMatch(/^FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    expect(d).toContain('LABEL org.opencontainers.image.revision=$APP_REVISION');
    expect(d).toMatch(/^USER 10001:10001$/m);
    expect(d).toContain('COPY package.json wydanie.jso[n] ./');
    // Wszystko, czego używa compose i instalacja, jest w obrazie.
    for (const plik of ['scripts/instalacja-kontener.mjs', 'scripts/instalacja-demo.mjs', 'scripts/instalacja-proba.mjs',
      'scripts/instalacja-przygotuj.mjs', 'scripts/instalacja-wspolne.mjs']) {
      expect(d).toContain(plik);
    }
    expect(d).toContain('COPY deploy/klient/kopia.mjs ./deploy/klient/kopia.mjs');
  });
});

describe('pierwszy start w kontenerze (instalacja-kontener.mjs)', () => {
  const skrypt = path.join(ROOT, 'scripts/instalacja-kontener.mjs');
  function uruchom(dane, konfiguracja, port, env = {}) {
    return spawnSync(process.execPath, [skrypt, '--port', String(port)], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, OMS_KATALOG_DANYCH: dane, OMS_KATALOG_KONFIGURACJI: konfiguracja, ...env },
    });
  }

  it('robi próbę i demo istniejącymi skryptami, a konfigurację i konto przenosi do katalogu konfiguracji', () => {
    const baza = katalog();
    const dane = path.join(baza, 'data'); const konfiguracja = path.join(baza, 'config');
    fs.mkdirSync(dane); fs.mkdirSync(konfiguracja);
    const wynik = uruchom(dane, konfiguracja, 39160, { OMS_PASS: 'cudzy-sekret', ALLEGRO_CLIENT_SECRET: 'cudzy-sekret' });
    expect(wynik.status, wynik.stderr).toBe(0);
    expect(wynik.stdout).toContain('instalacja-zakonczona');
    // PRZ-093.03: „co dalej” dla człowieka, JSON nadal ostatnią linią (instrukcja Dockera: „Kończy się wierszem…”).
    expect(JSON.parse(wynik.stdout.trim().split(/\r?\n/).at(-1)).status).toBe('instalacja-zakonczona');
    expect(wynik.stdout).toContain('sudo docker compose up -d');
    expect(wynik.stdout).toContain(':39160/login');
    expect(wynik.stdout).toContain(path.join(konfiguracja, 'administrator-proby.env'));
    // Sekret żyje w jednym miejscu: katalog danych (kopie zapasowe) nie ma pliku env ani hasła admina.
    for (const plik of ['proba.env', 'administrator-proby.env', 'produkcja.env.example']) expect(fs.existsSync(path.join(dane, plik))).toBe(false);
    const env = fs.readFileSync(path.join(konfiguracja, 'oms.env'), 'utf8');
    expect(env).toContain('OMS_TRYB=proba\n');
    expect(env).toContain(`OMS_DB_PATH=${path.join(dane, 'oms.sqlite')}\n`);
    expect(env).toContain('OMS_KANALY=[]\n');
    expect(env).not.toContain('cudzy-sekret');
    const admin = fs.readFileSync(path.join(konfiguracja, 'administrator-proby.env'), 'utf8');
    expect(admin).toMatch(/^login=administrator-proby\nhaslo=\S{20,}\n$/);
    expect(fs.readFileSync(path.join(konfiguracja, 'produkcja.env.example'), 'utf8')).toContain('OMS_SPRZEDAWCA_NIP=\n');
    const haslo = /haslo=(.+)/.exec(admin)[1]; const serwis = /OMS_PASS=(.+)/.exec(env)[1];
    for (const sekret of [haslo, serwis, 'cudzy-sekret']) expect(`${wynik.stdout}${wynik.stderr}`).not.toContain(sekret);
    const db = new DatabaseSync(path.join(dane, 'oms.sqlite'), { readOnly: true });
    try {
      expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
      expect(db.prepare("SELECT count(*) AS n FROM zamowienia WHERE numer LIKE 'DEMO-%'").get().n).toBe(3);
      expect(db.prepare("SELECT login FROM konta WHERE login='administrator-proby'").get()?.login).toBe('administrator-proby');
    } finally { db.close(); }
  }, 120_000);

  it('odmawia, gdy konfiguracja już istnieje — i nie dotyka katalogu danych', () => {
    const baza = katalog();
    const dane = path.join(baza, 'data'); const konfiguracja = path.join(baza, 'config');
    fs.mkdirSync(dane); fs.mkdirSync(konfiguracja);
    fs.writeFileSync(path.join(konfiguracja, 'oms.env'), 'OMS_TRYB=produkcja\n');
    const wynik = uruchom(dane, konfiguracja, 39161);
    expect(wynik.status).toBe(1);
    expect(wynik.stderr).toContain('INSTALACJA_ODMOWA_NADPISANIA');
    expect(fs.readdirSync(dane)).toEqual([]);
    expect(fs.readFileSync(path.join(konfiguracja, 'oms.env'), 'utf8')).toBe('OMS_TRYB=produkcja\n');
  });

  it('odmawia niepustego katalogu danych bez tworzenia konfiguracji', () => {
    const baza = katalog();
    const dane = path.join(baza, 'data'); const konfiguracja = path.join(baza, 'config');
    fs.mkdirSync(dane); fs.mkdirSync(konfiguracja);
    fs.writeFileSync(path.join(dane, 'oms.sqlite'), 'cudza baza');
    const wynik = uruchom(dane, konfiguracja, 39162);
    expect(wynik.status).toBe(1);
    expect(wynik.stderr).toContain('INSTALACJA_ODMOWA_NADPISANIA');
    expect(fs.readdirSync(konfiguracja)).toEqual([]);
    expect(fs.readFileSync(path.join(dane, 'oms.sqlite'), 'utf8')).toBe('cudza baza');
  });

  it('zgłasza brak katalogu zamiast go tworzyć (właściciela ustawia instrukcja)', () => {
    const baza = katalog();
    const wynik = uruchom(path.join(baza, 'brak'), path.join(baza, 'config-brak'), 39163);
    expect(wynik.status).toBe(1);
    expect(wynik.stderr).toContain('INSTALACJA_KONTENER_BRAK_KATALOGU');
    expect(fs.existsSync(path.join(baza, 'brak'))).toBe(false);
  });
});

describe('paczka wydania dla klienta (paczka-klienta.mjs)', () => {
  const skrypt = path.join(ROOT, 'scripts/paczka-klienta.mjs');
  const tar = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar';
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

  it('pakuje dokładnie listę plików z commita, wydanie.json z commit/tree i .env z OMS_REVISION', async () => {
    const { plikiPaczki } = await import('../../scripts/paczka-klienta.mjs');
    const commit = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const wyjscie = path.join(katalog(), 'wynik');
    const r = spawnSync(process.execPath, [skrypt, '--commit', commit, '--wyjscie', wyjscie], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const nazwa = `oms-${commit.slice(0, 12)}`;
    const archiwum = path.join(wyjscie, `${nazwa}.tar.gz`);
    const suma = fs.readFileSync(`${archiwum}.sha256`, 'utf8');
    expect(suma).toBe(`${createHash('sha256').update(fs.readFileSync(archiwum)).digest('hex')}  ${nazwa}.tar.gz\n`);
    // Root rozpakowuje tryby wiernie: żaden wpis nie może być zapisywalny dla grupy ani innych.
    const szczegoly = execFileSync(tar, ['-tvzf', archiwum], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);
    expect(szczegoly.length).toBeGreaterThan(400);
    for (const wpis of szczegoly) expect(wpis).toMatch(/^(-rw-r--r--|drwxr-xr-x)\s.*root.*root/);
    const rozpakowane = path.join(katalog(), 'x');
    fs.mkdirSync(rozpakowane);
    execFileSync(tar, ['-xzf', archiwum, '-C', rozpakowane]);
    const korzen = path.join(rozpakowane, nazwa);
    const lista = (k, p = '') => fs.readdirSync(path.join(k, p), { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? lista(k, path.posix.join(p, e.name)) : [path.posix.join(p, e.name)]);
    const wGicie = git('ls-tree', '-r', '--name-only', '--full-tree', commit).split('\n');
    const oczekiwane = plikiPaczki(wGicie);
    expect(lista(korzen).sort()).toEqual([...oczekiwane, 'wydanie.json', 'deploy/klient/.env'].sort());
    for (const wymagany of ['package.json', 'package-lock.json', 'src/oms.js', 'scripts/instalacja-demo.mjs', 'deploy/klient/aktualizuj.sh', 'deploy/klient/kopia.mjs']) {
      expect(oczekiwane).toContain(wymagany);
    }
    // Porównanie bajtów z obiektami gita (niezależnie od pakowacza): odcisk blobu = sha1("blob N\0" + bajty).
    const bloby = new Map(execFileSync('git', ['ls-tree', '-r', '--full-tree', commit], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean).map(w => { const [meta, plik] = w.split('\t'); return [plik, meta.split(' ')[2]]; }));
    for (const plik of oczekiwane) {
      const bajty = fs.readFileSync(path.join(korzen, plik));
      const odcisk = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bajty.length}\0`), bajty])).digest('hex');
      expect(odcisk, plik).toBe(bloby.get(plik));
    }
    expect(oczekiwane.some(p => /(^|\/)(\.env|node_modules|\.git)(\/|$)|\.sqlite$|^tests\/|^docs\/prz|mutacje/.test(p))).toBe(false);
    const wydanie = JSON.parse(fs.readFileSync(path.join(korzen, 'wydanie.json'), 'utf8'));
    expect(wydanie.commit).toBe(commit);
    expect(wydanie.tree).toBe(tree);
    expect(wydanie.podpisane).toBe(false);
    expect(fs.readFileSync(path.join(korzen, 'deploy/klient/.env'), 'utf8')).toMatch(new RegExp(`^# .*\\nOMS_REVISION=${commit}\\n$`));
  }, 120_000);

  it('odmawia istniejącego katalogu wyjścia i niepełnego commita', () => {
    const istniejacy = katalog();
    const r1 = spawnSync(process.execPath, [skrypt, '--commit', git('rev-parse', 'HEAD'), '--wyjscie', istniejacy], { cwd: ROOT, encoding: 'utf8' });
    expect(r1.status).toBe(1);
    const r2 = spawnSync(process.execPath, [skrypt, '--commit', 'HEAD', '--wyjscie', path.join(istniejacy, 'nowy')], { cwd: ROOT, encoding: 'utf8' });
    expect(r2.status).toBe(1);
    expect(fs.existsSync(path.join(istniejacy, 'nowy'))).toBe(false);
  });
});
