// Kopie OMS u klienta (PRZ-059). WYŁĄCZNIE moduły wbudowane Node — aktualizator uruchamia ten plik
// także w STARYM obrazie (z katalogu nowego wydania), gdzie nie ma reszty skryptów.
//
//   node kopia.mjs petla                       kontener oms-kopia: cykl od razu, potem co godzinę
//   node kopia.mjs cykl [--teraz ISO]          jeden cykl według reguł niżej
//   node kopia.mjs teraz                       wymuszona kopia lokalna i zewnętrzna
//   node kopia.mjs operacja <baza> <katalog>   kopia operacji aktualizatora (OMS zatrzymany)
//   node kopia.mjs migracje <baza>             lista zastosowanych migracji (JSON)
//
// Cykl:
// 1. Baza → <OMS_KOPIE_KATALOG>/oms-RRRR-MM-DD.sqlite (VACUUM INTO do pliku tymczasowego,
//    integrity_check, dopiero potem zmiana nazwy). Kopia, gdy jej nie ma, gdy najnowsza ma 26 h,
//    albo gdy jest nowy dzień UTC i minęła 03:00 UTC. Serwer wyłączany na noc dostaje kopię
//    po włączeniu — pętla PRZ-058 robiła ją tylko, gdy maszyna działała o 03:15.
// 2. Etykiety i proformy → pliki-RRRR-MM-DD.tgz raz na 7 dni, zostają OMS_KOPIE_ARCHIWA_ZACHOWAJ (2).
//    PRZ-058 wyłączyło archiwum, bo stara pętla nie rotowała archiwów i zapełniała dysk.
// 3. Gdy ustawiono OMS_KOPIA_ZEWNETRZNA (katalog zamontowanego nośnika): najnowsza kopia bazy
//    (odcisk SHA-256 porównany po skopiowaniu) i lustro etykiet/proform (pliki tylko dopisywane).
//    Bez pliku .oms-cel-kopii w tym katalogu nic się nie zapisuje — niepodłączony pendrive
//    zostawia pusty katalog na TYM SAMYM dysku i kopia „poza dyskiem” leżałaby obok bazy.
//    Brak miejsca (z rezerwą OMS_KOPIA_REZERWA_MB) = odmowa przed zapisem.
// Alarm o wieku kopii (48 h) liczy /health OMS-u i diagnostyka.sh — z dat plików, nie z tego procesu.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export const ZNACZNIK_NOSNIKA = '.oms-cel-kopii';
const WZORZEC_BAZY = /^oms-(\d{4}-\d{2}-\d{2})\.sqlite$/;
const WZORZEC_ARCHIWUM = /^pliki-(\d{4}-\d{2}-\d{2})\.tgz$/;
const GODZINA_MS = 3600_000;

const liczba = (wartosc, domyslna, min = 1) => {
  if (wartosc === undefined || wartosc === '') return domyslna;
  const n = Number(wartosc);
  if (!Number.isInteger(n) || n < min) throw Error(`KOPIA_ZLA_LICZBA ${wartosc}`);
  return n;
};

export function ustawienia(env = process.env) {
  const baza = env.OMS_DB_PATH || '/opt/oms/data/oms.sqlite';
  const dane = path.dirname(baza);
  return {
    baza,
    kopie: env.OMS_KOPIE_KATALOG || '/opt/oms/backups',
    zachowaj: liczba(env.OMS_KOPIE_ZACHOWAJ, 14),
    archiwaZachowaj: liczba(env.OMS_KOPIE_ARCHIWA_ZACHOWAJ, 2),
    pliki: [env.OMS_ETYKIETY_KATALOG || path.join(dane, 'etykiety'), env.OMS_PROFORMY_KATALOG || path.join(dane, 'proformy')],
    zewnetrzna: (env.OMS_KOPIA_ZEWNETRZNA || '').trim(),
    zewnetrznaZachowaj: liczba(env.OMS_KOPIA_ZEWNETRZNA_ZACHOWAJ, 30),
    rezerwaB: liczba(env.OMS_KOPIA_REZERWA_MB, 200, 0) * 1024 * 1024,
    odstepMs: liczba(env.OMS_KOPIA_ODSTEP_S, 3600) * 1000,
    // Urządzenie (st_dev) katalogu: nośnik na tym samym dysku co baza = kopia „poza dyskiem” na tym samym dysku.
    urzadzenie: p => fs.statSync(p).dev,
  };
}

const dzienUtc = d => d.toISOString().slice(0, 10);
const sha256Pliku = plik => createHash('sha256').update(fs.readFileSync(plik)).digest('hex');

/** Pliki pasujące do wzorca, od najstarszego (data w nazwie, potem czas modyfikacji). */
function nasze(katalog, wzorzec) {
  let nazwy;
  try { nazwy = fs.readdirSync(katalog); } catch { return []; }
  return nazwy.filter(n => wzorzec.test(n))
    .map(n => ({ nazwa: n, dzien: wzorzec.exec(n)[1], mtimeMs: fs.statSync(path.join(katalog, n)).mtimeMs }))
    .sort((a, b) => (a.dzien === b.dzien ? a.mtimeMs - b.mtimeMs : a.dzien < b.dzien ? -1 : 1));
}

function rotuj(katalog, wzorzec, zachowaj) {
  const lista = nasze(katalog, wzorzec);
  const doKasacji = lista.slice(0, Math.max(0, lista.length - zachowaj));
  for (const p of doKasacji) fs.rmSync(path.join(katalog, p.nazwa));
  return doKasacji.map(p => p.nazwa);
}

/** Spójna kopia (VACUUM INTO) przez plik tymczasowy; integralność sprawdzana przed nadaniem nazwy. */
export function kopiaBazy(baza, cel) {
  if (!fs.existsSync(baza)) throw Error(`KOPIA_BRAK_BAZY ${baza}`);
  const tmp = path.join(path.dirname(cel), `.tmp-${process.pid}-${path.basename(cel)}`);
  fs.rmSync(tmp, { force: true });
  const db = new DatabaseSync(baza);
  try {
    db.exec('PRAGMA busy_timeout=20000');
    db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
  } finally { db.close(); }
  try {
    const opis = sprawdzBaze(tmp);
    fs.renameSync(tmp, cel);
    return opis;
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

export function sprawdzBaze(plik) {
  const db = new DatabaseSync(plik, { readOnly: true });
  try {
    const integralnosc = db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integralnosc !== 'ok') throw Error(`KOPIA_USZKODZONA ${integralnosc}`);
    const tabela = n => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n));
    const ile = n => (tabela(n) ? db.prepare(`SELECT count(*) AS n FROM "${n}"`).get().n : null);
    return { integralnosc, bajty: fs.statSync(plik).size, zamowien: ile('zamowienia'), kont: ile('konta'), migracji: ile('migracje') };
  } finally { db.close(); }
}

export function migracje(baza) {
  const db = new DatabaseSync(baza, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migracje'").get()) return [];
    return db.prepare('SELECT modul, numer, nazwa FROM migracje ORDER BY modul, numer').all().map(w => ({ ...w }));
  } finally { db.close(); }
}

function plikiDrzewa(korzen, wzgledna = '') {
  let wpisy;
  try { wpisy = fs.readdirSync(path.join(korzen, wzgledna), { withFileTypes: true }); } catch { return []; }
  return wpisy.flatMap(e => {
    const w = path.join(wzgledna, e.name);
    if (e.isDirectory()) return plikiDrzewa(korzen, w);
    return e.isFile() ? [w] : [];
  });
}

function wolneB(katalog) {
  const s = fs.statfsSync(katalog);
  return Number(s.bavail) * Number(s.bsize);
}

function archiwumPlikow(u, teraz) {
  const istniejace = u.pliki.filter(k => fs.existsSync(k));
  if (!istniejace.length || !istniejace.some(k => plikiDrzewa(k).length)) return null;
  const lista = nasze(u.kopie, WZORZEC_ARCHIWUM);
  const ostatnie = lista.at(-1);
  if (ostatnie && teraz.getTime() - ostatnie.mtimeMs < 7 * 24 * GODZINA_MS) return null;
  const nazwa = `pliki-${dzienUtc(teraz)}.tgz`;
  const tmp = path.join(u.kopie, `.tmp-${process.pid}-${nazwa}`);
  // Jedno archiwum na wspólnym katalogu nadrzędnym; nazwy katalogów (etykiety, proformy) zostają w środku.
  const wspolny = path.dirname(istniejace[0]);
  if (istniejace.some(k => path.dirname(k) !== wspolny)) throw Error('KOPIA_PLIKI_W_ROZNYCH_KATALOGACH');
  const rozmiar = istniejace.reduce((s, k) => s + plikiDrzewa(k).reduce((t, w) => t + fs.statSync(path.join(k, w)).size, 0), 0);
  const wolne = wolneB(u.kopie);
  if (wolne - rozmiar < u.rezerwaB) throw Error(`KOPIA_ARCHIWUM_BRAK_MIEJSCA potrzeba do ${Math.ceil(rozmiar / 1048576)} MB + rezerwa ${Math.ceil(u.rezerwaB / 1048576)} MB, wolne ${Math.floor(wolne / 1048576)} MB`);
  // Archiwum na standardowe wyjście: GNU tar bierze „C:” w nazwie pliku za zdalny host.
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try { execFileSync('tar', ['czf', '-', '-C', wspolny, ...istniejace.map(k => path.basename(k))], { stdio: ['ignore', fd, 'pipe'] }); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, path.join(u.kopie, nazwa));
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  return { archiwum: nazwa, skasowane: rotuj(u.kopie, WZORZEC_ARCHIWUM, u.archiwaZachowaj) };
}

/** Kopia na nośnik zewnętrzny: najnowsza kopia bazy + lustro plików. Odmowa przed zapisem. */
export function kopiaZewnetrzna(u, { wymus = false } = {}) {
  const cel = u.zewnetrzna;
  if (!path.isAbsolute(cel)) throw Error('KOPIA_ZEWNETRZNA_SCIEZKA_NIE_BEZWZGLEDNA');
  if (!fs.existsSync(path.join(cel, ZNACZNIK_NOSNIKA))) throw Error(`KOPIA_ZEWNETRZNA_BRAK_NOSNIKA ${cel} (brak ${ZNACZNIK_NOSNIKA})`);
  // Znacznik założony, gdy montowanie się nie udało, leży w pustym katalogu na dysku serwera.
  if (u.urzadzenie(cel) === u.urzadzenie(path.dirname(u.baza))) throw Error(`KOPIA_ZEWNETRZNA_TEN_SAM_DYSK ${cel} — nośnik niezamontowany`);
  const najnowsza = nasze(u.kopie, WZORZEC_BAZY).at(-1);
  if (!najnowsza) throw Error('KOPIA_ZEWNETRZNA_BRAK_KOPII_LOKALNEJ');
  const zrodlo = path.join(u.kopie, najnowsza.nazwa);
  const docelowa = path.join(cel, najnowsza.nazwa);
  const kopiujBaze = wymus || !fs.existsSync(docelowa) || fs.statSync(docelowa).mtimeMs < najnowsza.mtimeMs
    || fs.statSync(docelowa).size !== fs.statSync(zrodlo).size;
  const doLustra = [];
  for (const katalog of u.pliki) {
    for (const w of plikiDrzewa(katalog)) {
      const z = path.join(katalog, w);
      const d = path.join(cel, 'pliki', path.basename(katalog), w);
      const sz = fs.statSync(z);
      if (!fs.existsSync(d) || fs.statSync(d).size !== sz.size) doLustra.push({ z, d, bajty: sz.size, mtime: sz.mtime });
    }
  }
  const potrzeba = (kopiujBaze ? fs.statSync(zrodlo).size : 0) + doLustra.reduce((s, p) => s + p.bajty, 0);
  const wolne = wolneB(cel);
  if (wolne - potrzeba < u.rezerwaB) {
    throw Error(`KOPIA_ZEWNETRZNA_BRAK_MIEJSCA potrzeba ${Math.ceil(potrzeba / 1048576)} MB + rezerwa ${Math.ceil(u.rezerwaB / 1048576)} MB, wolne ${Math.floor(wolne / 1048576)} MB`);
  }
  if (kopiujBaze) {
    const tmp = path.join(cel, `.tmp-${process.pid}-${najnowsza.nazwa}`);
    try {
      fs.copyFileSync(zrodlo, tmp);
      if (sha256Pliku(tmp) !== sha256Pliku(zrodlo)) throw Error('KOPIA_ZEWNETRZNA_ODCISK_NIEZGODNY');
      fs.renameSync(tmp, docelowa);
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  }
  for (const p of doLustra) {
    fs.mkdirSync(path.dirname(p.d), { recursive: true });
    const tmp = `${p.d}.tmp-${process.pid}`;
    fs.copyFileSync(p.z, tmp);
    fs.utimesSync(tmp, p.mtime, p.mtime);
    fs.renameSync(tmp, p.d);
  }
  return { baza: kopiujBaze ? najnowsza.nazwa : null, plikow: doLustra.length, skasowane: rotuj(cel, WZORZEC_BAZY, u.zewnetrznaZachowaj) };
}

export function cykl(u, { teraz = new Date(), wymus = false } = {}) {
  fs.mkdirSync(u.kopie, { recursive: true });
  const wynik = { czas: teraz.toISOString(), baza: null, archiwum: null, zewnetrzna: null, bledy: [] };
  const najnowsza = nasze(u.kopie, WZORZEC_BAZY).at(-1);
  const potrzebna = wymus || !najnowsza || teraz.getTime() - najnowsza.mtimeMs >= 26 * GODZINA_MS
    || (najnowsza.dzien < dzienUtc(teraz) && teraz.getUTCHours() >= 3);
  try {
    if (potrzebna) {
      const nazwa = `oms-${dzienUtc(teraz)}.sqlite`;
      wynik.baza = { plik: nazwa, ...kopiaBazy(u.baza, path.join(u.kopie, nazwa)), skasowane: rotuj(u.kopie, WZORZEC_BAZY, u.zachowaj) };
    }
  } catch (e) { wynik.bledy.push(e instanceof Error ? e.message : String(e)); }
  try { wynik.archiwum = archiwumPlikow(u, teraz); } catch (e) { wynik.bledy.push(e instanceof Error ? e.message : String(e)); }
  if (u.zewnetrzna) {
    try { wynik.zewnetrzna = kopiaZewnetrzna(u, { wymus }); } catch (e) { wynik.bledy.push(e instanceof Error ? e.message : String(e)); }
  } else {
    wynik.zewnetrzna = 'nieustawiona — kopie leżą na tym samym dysku co baza (OMS_KOPIA_ZEWNETRZNA)';
  }
  return wynik;
}

/** Kopia operacji aktualizatora: OMS zatrzymany, katalog nowy, baza + lista migracji. */
export function operacja(baza, katalog) {
  if (!fs.existsSync(katalog) || !fs.statSync(katalog).isDirectory()) throw Error('KOPIA_OPERACJI_BRAK_KATALOGU');
  const cel = path.join(katalog, 'oms.sqlite');
  if (fs.existsSync(cel)) throw Error('KOPIA_OPERACJI_JUZ_ISTNIEJE');
  const opis = kopiaBazy(baza, cel);
  const lista = migracje(cel);
  fs.writeFileSync(path.join(katalog, 'migracje.json'), JSON.stringify(lista) + '\n', { flag: 'wx' });
  return { ok: true, ...opis, plikMigracji: 'migracje.json' };
}

function main(argv) {
  const [tryb, ...reszta] = argv;
  const wypisz = obiekt => console.log(JSON.stringify(obiekt));
  if (tryb === 'operacja' && reszta.length === 2) return wypisz(operacja(reszta[0], reszta[1]));
  if (tryb === 'migracje' && reszta.length === 1) return wypisz(migracje(reszta[0]));
  if (tryb === 'migracje' && reszta.length === 3 && reszta[1] === '--wzgledem') {
    // Różnica listy migracji bazy względem kopii operacji (recover aktualizatora).
    const klucz = m => `${m.modul}/${m.numer} ${m.nazwa}`;
    const teraz = migracje(reszta[0]).map(klucz);
    const wtedy = JSON.parse(fs.readFileSync(reszta[2], 'utf8')).map(klucz);
    return wypisz({ nowe: teraz.filter(m => !wtedy.includes(m)), brakujace: wtedy.filter(m => !teraz.includes(m)) });
  }
  const u = ustawienia();
  if (tryb === 'teraz' && !reszta.length) {
    const w = cykl(u, { wymus: true }); wypisz(w); if (w.bledy.length) process.exitCode = 1; return;
  }
  if (tryb === 'cykl' && (reszta.length === 0 || (reszta.length === 2 && reszta[0] === '--teraz'))) {
    const teraz = reszta.length ? new Date(reszta[1]) : new Date();
    if (Number.isNaN(teraz.getTime())) throw Error('KOPIA_UZYCIE');
    const w = cykl(u, { teraz }); wypisz(w); if (w.bledy.length) process.exitCode = 1; return;
  }
  if (tryb === 'petla' && !reszta.length) {
    // PID 1 w kontenerze nie ma domyślnej obsługi SIGTERM: bez tego `docker stop` czeka 10 s.
    for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => process.exit(0));
    const raz = () => {
      try {
        const w = cykl(u);
        if (w.baza || w.archiwum || w.bledy.length || (w.zewnetrzna && typeof w.zewnetrzna === 'object' && (w.zewnetrzna.baza || w.zewnetrzna.plikow))) wypisz(w);
        for (const b of w.bledy) console.error(`[kopia] BLAD ${b}`);
      } catch (e) { console.error(`[kopia] BLAD ${e instanceof Error ? e.message : e}`); }
    };
    if (!u.zewnetrzna) console.error(`[kopia] UWAGA kopia poza dyskiem nieustawiona — kopie leżą na tym samym dysku co baza`);
    raz();
    setInterval(raz, u.odstepMs);
    return;
  }
  throw Error('KOPIA_UZYCIE');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) {
    console.error(e instanceof Error && /^KOPIA_/.test(e.message) ? e.message : `KOPIA_ODMOWA ${e instanceof Error ? e.message : ''}`);
    process.exitCode = 1;
  }
}
