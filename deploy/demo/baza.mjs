// Baza demo publicznego: założenie od zera i — od PRZ-083 — następna baza przygotowana W TLE na najbliższy reset.
// Do PRZ-083 reset kasował bazę i kończył proces: restart kontenera + bezpiecznik 17,5 s, generator 23,8 s, start 4,7 s —
// 46 s przerwy (pomiar 15.10, reset 07:00). Teraz generator chodzi w procesie potomnym (nastepna.mjs) do katalogu
// `nastepna/` obok bazy, a o pełnej godzinie cykl (cykl.mjs) zamyka aplikację, woła podmienNaNastepna i składa ją od nowa.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const pliki = (baza) => [baza, `${baza}-wal`, `${baza}-shm`];

// PRZ-083: zespół zmyślonej firmy na ekranie „Użytkownicy i uprawnienia” w podglądzie demo.
export const ZESPOL_DEMO = [
  ['anna', 'Anna Wiśniewska', 'sprzedaz'],
  ['marek', 'Marek Zieliński', 'produkcja'],
];

/** Katalog następnej bazy — na tym samym wolumenie co bieżąca, żeby podmiana była zwykłym rename. */
export function katalogNastepnej(baza) {
  return path.join(path.dirname(baza), 'nastepna');
}

export function usunNastepna(baza) {
  fs.rmSync(katalogNastepnej(baza), { recursive: true, force: true });
}

/**
 * Świeże demo w pustym miejscu: generator (scripts/demo-dane.mjs) na `dzis`, administrator (hash z montowanego
 * konto.json; `haslo` tylko w testach) i gość z OMS_DEMO_LOGIN/OMS_DEMO_HASLO z rolą Sprzedaż.
 */
export async function zalozBazeDemo({ baza, dzis, env, kontoAdmina }) {
  for (const p of pliki(baza).slice(1)) fs.rmSync(p, { force: true });
  for (const k of [env.OMS_PROFORMY_KATALOG, env.OMS_ETYKIETY_KATALOG]) if (k) fs.mkdirSync(k, { recursive: true });
  const { utworzBazeDemo } = await import('../../scripts/demo-dane.mjs');
  const { zalozKonto } = await import('../../src/core/bezpieczenstwo/konta.js');
  const { ekranyRoli } = await import('../../src/domena/ekrany.js');
  const wynik = await utworzBazeDemo({ baza, dzis, env });
  const db = new DatabaseSync(baza);
  try {
    const haslo = kontoAdmina.hash ? { hashHasla: kontoAdmina.hash } : { haslo: kontoAdmina.haslo };
    zalozKonto(db, { login: kontoAdmina.login, imie: kontoAdmina.imie, rola: 'administrator', admin: true, ...haslo });
    // PRZ-083: gość ma też ptaszek Ustawień — ogląda je w podglądzie (src/core/bezpieczenstwo/podglad-demo.js:
    // zapis pod /ustawienia od gościa = 403). Finanse dalej poza jego rolą.
    zalozKonto(db, { login: env.OMS_DEMO_LOGIN, imie: 'Gość demo', haslo: env.OMS_DEMO_HASLO, rola: 'sprzedaz',
      ekrany: [...ekranyRoli('sprzedaz'), 'ustawienia'] });
    // Zmyślony zespół „Pracowni Półcień” na ekranie Kont — bez hasła do odgadnięcia (losowe, nigdzie niezapisane).
    for (const [login, imie, rola] of ZESPOL_DEMO) {
      zalozKonto(db, { login, imie, rola, haslo: randomBytes(24).toString('base64url') });
    }
  } finally { db.close(); }
  return wynik;
}

/**
 * Następna baza na dzień `dzis` w katalogNastepnej(baza). Bieżącej nie dotyka — gość klika na niej aż do podmiany.
 * Proformy generator wystawia prawdziwą usługą, która zapisuje w bazie BEZWZGLĘDNĄ ścieżkę PDF-a; tu pliki leżą
 * w nastepna/proformy, a ścieżki od razu wskazują katalog docelowy — tam trafią przy podmianie.
 */
export async function przygotujNastepna({ baza, dzis, env, kontoAdmina }) {
  const kat = katalogNastepnej(baza);
  fs.rmSync(kat, { recursive: true, force: true });
  fs.mkdirSync(kat, { recursive: true });
  const envNastepnej = { ...env, OMS_PROFORMY_KATALOG: path.join(kat, 'proformy'), OMS_ETYKIETY_KATALOG: path.join(kat, 'etykiety') };
  const wynik = await zalozBazeDemo({ baza: path.join(kat, 'oms.sqlite'), dzis, env: envNastepnej, kontoAdmina });
  const db = new DatabaseSync(path.join(kat, 'oms.sqlite'));
  try {
    const zmien = db.prepare('UPDATE proformy SET plik_sciezka = ? WHERE id = ?');
    for (const p of db.prepare('SELECT id, plik_sciezka FROM proformy WHERE plik_sciezka IS NOT NULL').all()) {
      zmien.run(path.join(env.OMS_PROFORMY_KATALOG, path.basename(p.plik_sciezka)), p.id);
    }
    // Bez WAL-a w katalogu: podmiana przenosi jeden plik.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  // Znacznik na końcu: jego brak = przygotowanie przerwane w połowie, podmiana odmówi.
  // pid: dowód dla testu, że generator chodził w procesie potomnym, nie w procesie panelu.
  fs.writeFileSync(path.join(kat, 'gotowa.json'), JSON.stringify({ dzis, pid: process.pid, wynik }));
  return wynik;
}

/**
 * Podmiana bieżącej bazy na następną — wyłącznie przy ZAMKNIĘTEJ aplikacji (cykl.mjs). Odmowa, gdy następnej nie ma
 * albo jest z innego dnia: wtedy bieżąca zostaje bajt w bajt, a cykl idzie starym torem (skasuj i wyjdź).
 */
export function podmienNaNastepna({ baza, dzis, env }) {
  const kat = katalogNastepnej(baza);
  let gotowa;
  try { gotowa = JSON.parse(fs.readFileSync(path.join(kat, 'gotowa.json'), 'utf8')); }
  catch { throw new Error('demo: brak gotowej następnej bazy'); }
  if (gotowa.dzis !== dzis) throw new Error(`demo: następna baza na dzień ${gotowa.dzis}, reset na ${dzis}`);
  for (const p of pliki(baza)) fs.rmSync(p, { force: true });
  fs.renameSync(path.join(kat, 'oms.sqlite'), baza);
  for (const [zrodlo, cel] of [['proformy', env.OMS_PROFORMY_KATALOG], ['etykiety', env.OMS_ETYKIETY_KATALOG]]) {
    if (!cel) continue;
    // Stare pliki idą razem ze starą bazą — do PRZ-083 proformy gości zbierały się tu z godziny na godzinę.
    fs.rmSync(cel, { recursive: true, force: true });
    if (fs.existsSync(path.join(kat, zrodlo))) fs.renameSync(path.join(kat, zrodlo), cel);
    else fs.mkdirSync(cel, { recursive: true });
  }
  fs.rmSync(kat, { recursive: true, force: true });
}

/**
 * Generator w procesie potomnym (nastepna.mjs): utworzBazeDemo jest synchroniczny i w procesie panelu zamroziłby
 * go na czas generowania (na NAS-ie 19–24 s). Wynik: true = gotowa.json zapisany.
 */
export function przygotujWTle({ dzis, env, signal }) {
  const skrypt = path.join(path.dirname(fileURLToPath(import.meta.url)), 'nastepna.mjs');
  return new Promise((resolve) => {
    // `signal`: SIGTERM kontenera przerywa generator — inaczej proces czekałby na dziecko, a Docker zabiłby go po 10 s.
    const dziecko = spawn(process.execPath, [skrypt], { env: { ...env, DEMO_DZIS: dzis }, stdio: 'inherit', ...(signal ? { signal } : {}) });
    dziecko.on('error', () => resolve(false));
    dziecko.on('exit', (kod) => resolve(kod === 0));
  });
}
