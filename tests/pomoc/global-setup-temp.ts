import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const keys = ['TMPDIR', 'TEMP', 'TMP'] as const;

const zaleznePdf = /pdftotext|pdftoppm|PDFTOTEXT|POPPLER/;
const pomijanie = /\.skip\b|\.skipIf\(/;

// Testy PDF wykrywają poppler same i bez niego po cichu się pomijają; jedna linia na starcie mówi, ile ich jest.
function ostrzezPrzyBrakuPdftotext() {
  if (!spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).error) return;
  let liczba = 0;
  for (const wpis of readdirSync('tests', { recursive: true, encoding: 'utf8' })) {
    if (!/\.test\.(js|ts)$/.test(wpis)) continue;
    const tresc = readFileSync(join('tests', wpis), 'utf8');
    if (zaleznePdf.test(tresc) && pomijanie.test(tresc)) liczba += 1;
  }
  console.warn(`[vitest] Brak pdftotext (poppler): ${liczba} plików testów PDF pominie testy odczytu tekstu. Doinstaluj poppler-utils.`);
}

export default function setup() {
  ostrzezPrzyBrakuPdftotext();
  // tmpdir() czyta bieżące env: zagnieżdżony Vitest dostaje własny podkatalog.
  const parent = realpathSync(tmpdir());
  const previous = keys.map(key => [key, process.env[key]] as const);
  const runDirectory = resolve(mkdtempSync(join(parent, 'twoj-oms-vitest-')));
  const restore = () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const cleanup = () => {
    if (dirname(runDirectory).toLowerCase() !== parent.toLowerCase()
      || !basename(runDirectory).startsWith('twoj-oms-vitest-')
      || realpathSync(parent).toLowerCase() !== parent.toLowerCase()
      || lstatSync(runDirectory).isSymbolicLink()
      || realpathSync(runDirectory).toLowerCase() !== runDirectory.toLowerCase()) {
      throw Error('Odmowa cleanup: katalog TEMP nie jest własnym zwykłym katalogiem przebiegu');
    }
    // Node ponawia EBUSY/ENOTEMPTY (także EPERM) ograniczoną liczbę razy.
    // Nie maskujemy trwałej odmowy ani nie usuwamy innych katalogów TEMP.
    rmSync(runDirectory, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  };
  try {
    // Diagnostyka; skrypt mutacji używa PID do cleanup wyłącznie własnej pozostałości.
    // Normalny teardown ma własną niezmienną ścieżkę i nie polega na markerze.
    writeFileSync(join(runDirectory, '.twoj-oms-temp-owner.json'), JSON.stringify({ pid: process.pid, parent, runDirectory }));
    for (const key of keys) process.env[key] = runDirectory;
  } catch (error) {
    try { cleanup(); } finally { restore(); }
    throw error;
  }
  // Teardown wymaga normalnego zamknięcia Vitest; SIGKILL/utrata zasilania go pomija.
  return () => {
    try { cleanup(); } finally { restore(); }
  };
}
