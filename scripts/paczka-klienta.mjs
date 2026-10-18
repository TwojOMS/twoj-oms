// Paczka wydania dla klienta (PRZ-058): tar.gz z plikami WPROST z commita (git show, bez kopii
// roboczej, więc bez CRLF i bez niezacommitowanych zmian), plus:
//   wydanie.json       — pełny commit i tree (diagnostyka, przyszły aktualizator),
//   deploy/klient/.env — OMS_REVISION dla compose (tag obrazu i etykieta revision).
// Użycie: node scripts/paczka-klienta.mjs --commit <pełny SHA> --wyjscie <nowy katalog bezwzględny>
// tar.gz, bo czysty Debian ma tar, a nie ma unzip.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOKLADNE = new Set([
  'package.json', 'package-lock.json',
  'scripts/instalacja-wspolne.mjs', 'scripts/instalacja-przygotuj.mjs', 'scripts/instalacja-proba.mjs',
  'scripts/instalacja-demo.mjs', 'scripts/instalacja-otworz.mjs', 'scripts/instalacja-kontener.mjs',
  'scripts/backup-db.mjs', 'scripts/backup-rotation.mjs',
  'scripts/produkcja-pierwszy-start.mjs', 'scripts/inicjalizuj-granice-bez-historii.mjs',
  'docs/instalacja-klienta.md', 'docs/instalacja-docker.md', 'docs/aktualizacje-klienta.md', 'docs/aktualizacja-klienta-v0.md',
]);
const PREFIKSY = ['src/', 'deploy/klient/'];
// Dokumenty kurierów (docs/kurier-dpd.md, docs/kurier-inpost.md…): instrukcja instalacji odsyła do nich z ekranu Integracji.
const WZORCE = [/^docs\/kurier-[a-z0-9-]+\.md$/];

/** Lista plików paczki z listy plików commita: dokładne nazwy, wzorce dokumentów kurierów + całe src/ i deploy/klient/. */
export function plikiPaczki(plikiCommita) {
  return plikiCommita
    .filter(p => DOKLADNE.has(p) || PREFIKSY.some(prefiks => p.startsWith(prefiks)) || WZORCE.some(w => w.test(p)))
    .filter(p => !/(^|\/)\.env$/.test(p))
    .sort();
}

function opcje(argv) {
  const wynik = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--commit', '--wyjscie'].includes(argv[i]) || !argv[i + 1] || Object.hasOwn(wynik, argv[i])) throw Error('PACZKA_UZYCIE');
    wynik[argv[i]] = argv[i + 1];
  }
  if (!/^[0-9a-f]{40}$/.test(wynik['--commit'] ?? '')) throw Error('PACZKA_PELNY_COMMIT');
  if (!path.isAbsolute(wynik['--wyjscie'] ?? '')) throw Error('PACZKA_WYJSCIE_BEZWZGLEDNE');
  return { commit: wynik['--commit'], wyjscie: path.resolve(wynik['--wyjscie']) };
}

const git = (args, encoding = 'utf8', input) => execFileSync('git', args, { cwd: ROOT, encoding, input, maxBuffer: 256 * 1024 * 1024 });
const sha256 = bufor => createHash('sha256').update(bufor).digest('hex');

// Własny zapis ustar zamiast tar.exe: bsdtar na Windowsie zapisuje tryby 0666/0777, a root na
// Linuksie rozpakowuje je wiernie — kod w /opt/oms/releases byłby zapisywalny dla każdego.
function naglowekUstar(nazwa, { rozmiar = 0, katalog = false, czas }) {
  let prefiks = '';
  let krotka = nazwa;
  if (Buffer.byteLength(nazwa) > 100) {
    const ciecie = nazwa.lastIndexOf('/', 155);
    prefiks = nazwa.slice(0, ciecie); krotka = nazwa.slice(ciecie + 1);
    if (ciecie < 0 || Buffer.byteLength(prefiks) > 155 || Buffer.byteLength(krotka) > 100) throw Error('PACZKA_ZA_DLUGA_SCIEZKA');
  }
  const h = Buffer.alloc(512, 0);
  const pole = (tekst, od, dl) => h.write(tekst, od, dl, 'utf8');
  const osem = (liczba, dl) => liczba.toString(8).padStart(dl - 1, '0');
  pole(krotka, 0, 100);
  pole(osem(katalog ? 0o755 : 0o644, 8), 100, 8);
  pole(osem(0, 8), 108, 8); pole(osem(0, 8), 116, 8);
  pole(osem(rozmiar, 12), 124, 12);
  pole(osem(czas, 12), 136, 12);
  h.fill(0x20, 148, 156);
  pole(katalog ? '5' : '0', 156, 1);
  pole('ustar\0', 257, 6); pole('00', 263, 2);
  pole('root', 265, 32); pole('root', 297, 32);
  pole(prefiks, 345, 155);
  let suma = 0; for (const b of h) suma += b;
  pole(suma.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** Archiwum tar (ustar, właściciel root, tryby 0644/0755) z mapy ścieżka → bajty. */
export function tarUstar(pliki, czas = Math.floor(Date.now() / 1000)) {
  const katalogi = new Set();
  for (const nazwa of pliki.keys()) {
    const czesci = nazwa.split('/');
    for (let i = 1; i < czesci.length; i++) katalogi.add(czesci.slice(0, i).join('/') + '/');
  }
  const bloki = [];
  for (const k of [...katalogi].sort()) bloki.push(naglowekUstar(k, { katalog: true, czas }));
  for (const [nazwa, bajty] of [...pliki].sort(([a], [b]) => (a < b ? -1 : 1))) {
    bloki.push(naglowekUstar(nazwa, { rozmiar: bajty.length, czas }), bajty);
    const reszta = bajty.length % 512;
    if (reszta) bloki.push(Buffer.alloc(512 - reszta, 0));
  }
  bloki.push(Buffer.alloc(1024, 0));
  return Buffer.concat(bloki);
}

/** Bajty plików z commita jednym wywołaniem `git cat-file --batch` (setki `git show` trwały ~30 s). */
export function bajtyZCommita(commit, pliki, wykonaj = git) {
  const wynik = wykonaj(['cat-file', '--batch'], null, pliki.map(p => `${commit}:${p}\n`).join(''));
  const mapa = new Map();
  let pozycja = 0;
  for (const plik of pliki) {
    const koniecNaglowka = wynik.indexOf(10, pozycja);
    const naglowek = wynik.subarray(pozycja, koniecNaglowka).toString('utf8').split(' ');
    if (naglowek[1] !== 'blob') throw Error('PACZKA_NIEZWYKLY_PLIK');
    const rozmiar = Number(naglowek[2]);
    mapa.set(plik, wynik.subarray(koniecNaglowka + 1, koniecNaglowka + 1 + rozmiar));
    pozycja = koniecNaglowka + 1 + rozmiar + 1;
  }
  return mapa;
}

function main() {
  const { commit, wyjscie } = opcje(process.argv.slice(2));
  if (fs.existsSync(wyjscie)) throw Error('PACZKA_WYJSCIE_ISTNIEJE');
  if (git(['cat-file', '-t', commit]).trim() !== 'commit') throw Error('PACZKA_PELNY_COMMIT');
  const tree = git(['rev-parse', `${commit}^{tree}`]).trim();
  const wiersze = git(['ls-tree', '-rz', '--full-tree', commit]).split('\0').filter(Boolean).map(w => {
    const [meta, plik] = w.split('\t'); const [tryb, typ] = meta.split(' ');
    return { tryb, typ, plik };
  });
  const pliki = plikiPaczki(wiersze.map(w => w.plik));
  for (const plik of pliki) {
    const w = wiersze.find(x => x.plik === plik);
    if (w.typ !== 'blob' || !['100644', '100755'].includes(w.tryb)) throw Error('PACZKA_NIEZWYKLY_PLIK');
  }
  for (const wymagany of ['package.json', 'package-lock.json', 'src/oms.js', 'deploy/klient/compose.yaml', 'deploy/klient/Dockerfile']) {
    if (!pliki.includes(wymagany)) throw Error('PACZKA_BRAK_PLIKU');
  }
  const nazwa = `oms-${commit.slice(0, 12)}`;
  const zawartosc = bajtyZCommita(commit, pliki);
  const odciski = pliki.map(plik => ({ plik, sha256: sha256(zawartosc.get(plik)), bajty: zawartosc.get(plik).length }));
  const wydanie = { commit, tree, rodzaj: 'klient-docker', node: '24', utworzono: new Date().toISOString(), plikow: pliki.length, podpisane: false };
  const wpisyArchiwum = new Map(pliki.map(plik => [`${nazwa}/${plik}`, zawartosc.get(plik)]));
  wpisyArchiwum.set(`${nazwa}/wydanie.json`, Buffer.from(JSON.stringify(wydanie, null, 2) + '\n'));
  wpisyArchiwum.set(`${nazwa}/deploy/klient/.env`, Buffer.from(
    `# Wersja tej paczki dla docker compose. Nie wpisuj tu haseł — konfiguracja OMS jest w /opt/oms/config/oms.env\nOMS_REVISION=${commit}\n`));
  fs.mkdirSync(wyjscie, { recursive: true });
  const archiwum = path.join(wyjscie, `${nazwa}.tar.gz`);
  fs.writeFileSync(archiwum, gzipSync(tarUstar(wpisyArchiwum), { level: 9 }), { flag: 'wx' });
  // Kontrola niezależnym czytnikiem: systemowy tar musi zobaczyć dokładnie te pliki.
  const tar = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar';
  const wpisy = execFileSync(tar, ['-tzf', archiwum], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split(/\r?\n/).filter(p => p && !p.endsWith('/'));
  if (JSON.stringify(wpisy.sort()) !== JSON.stringify([...wpisyArchiwum.keys()].sort())) throw Error('PACZKA_NIEZGODNA_ZAWARTOSC');
  const suma = sha256(fs.readFileSync(archiwum));
  fs.writeFileSync(`${archiwum}.sha256`, `${suma}  ${nazwa}.tar.gz\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(wyjscie, `${nazwa}.manifest.json`), JSON.stringify({ ...wydanie, archiwum: `${nazwa}.tar.gz`, sha256: suma, pliki: odciski }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'paczka-gotowa', archiwum, sha256: suma, commit, tree, plikow: wpisy.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) {
    console.error(e instanceof Error && /^PACZKA_/.test(e.message) ? e.message : `PACZKA_ODMOWA ${e instanceof Error ? e.message : ''}`);
    process.exitCode = 1;
  }
}
