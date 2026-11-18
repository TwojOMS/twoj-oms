#!/usr/bin/env node
// Narzędzie poświadczeń w bazie OMS — działa samodzielnie (bez migracji, bez serwera HTTP), także gdy OMS nie wstaje.
// Klucz z OMS_KLUCZ_SEKRETOW (u klienta: `aktualizuj.sh sekrety …` podaje go z /opt/oms/config/klucz.env).
// Nigdy nie wypisuje wartości poświadczeń ani klucza — tylko liczby, nazwy wierszy i id kluczy.
//
//   stan [--baza <plik>]                      odczyt: klasy wartości, wymagane id kluczy (działa bez klucza), format, sprzątanie
//   sprawdz --baza <plik>                     odczyt: integralność, format, odszyfrowanie wszystkiego → KLUCZ_ZGODNY / KLUCZ_NIEZGODNY
//   klucz-zapewnij --plik <p> [--baza <b>]    plik klucza: istniejący — walidacja; brak — nowy (odmowa, gdy baza ma szyfrogramy)
//   odszyfruj [--baza <plik>]                 zapis: format 1 → 0 (powrót na starsze wydanie), idempotentne
//   porzuc [--potwierdz <nazwa>… | --potwierdz-wszystkie]   podgląd nieczytelnych poświadczeń / usunięcie wskazanych
//   porzuc --nowy-klucz --plik <p> (--potwierdz <nazwa>… | --potwierdz-wszystkie)   jedyna droga po utracie klucza
//   sprzataj [--baza <plik>]                  zapis: przepakowanie pliku bazy po konwersji (VACUUM + checkpoint)
//
// Kody wyjścia: 0 — sukces / klucz zgodny; 1 — odmowa / klucz niezgodny / błąd danych; 2 — złe użycie.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  bajtyKlucza,
  idKlucza,
  nowyKlucz,
  sejfZEnv,
  utworzSejf,
  ZMIENNA_KLUCZA,
  FORMAT_SEKRETOW,
} from '../src/core/bezpieczenstwo/sejf-sekretow.js';
import {
  przegladSekretow,
  odszyfrujDoFormatu0,
  sprzatnijPlikBazy,
} from '../src/core/bezpieczenstwo/konwersja-sekretow.js';
import { nowySekret } from '../src/core/bezpieczenstwo/sesja.js';

class Odmowa extends Error {}
class Uzycie extends Error {}

function argumenty(argv) {
  const o = { _: [], potwierdz: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baza' || a === '--plik') {
      if (!argv[i + 1]) throw new Uzycie(`${a} wymaga wartości`);
      o[a.slice(2)] = argv[++i];
    } else if (a === '--potwierdz') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.potwierdz.push(argv[++i]);
      if (!o.potwierdz.length) throw new Uzycie('--potwierdz wymaga nazw (z podglądu `porzuc`)');
    } else if (a === '--potwierdz-wszystkie') o.wszystkie = true;
    else if (a === '--nowy-klucz') o.nowyKlucz = true;
    else if (a.startsWith('--')) throw new Uzycie(`nieznana opcja ${a}`);
    else o._.push(a);
  }
  return o;
}

const sciezkaBazy = (o, env) => o.baza || env.OMS_DB_PATH || '/data-oms/oms.sqlite';

function otworz(plik, { odczyt }) {
  if (!fs.existsSync(plik)) throw new Odmowa(`Brak pliku bazy: ${plik}`);
  const db = new DatabaseSync(plik, odczyt ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

const opisMiejsca = (m) => `${m.tabela}.${m.kolumna}`;

function wypiszStan(p, wypisz, sejf) {
  wypisz(
    `format: ${p.format === null ? `brak znacznika (baza sprzed szyfrowania albo po odszyfrowaniu)` : p.format} (to wydanie zna format ${FORMAT_SEKRETOW})`,
  );
  wypisz(`sprzątanie pliku: ${p.sprzatanie ? `CZEKA (${p.sprzatanie})` : 'nie czeka'}`);
  for (const m of p.miejsca) {
    const klucze = Object.entries(m.poKluczach)
      .map(([id, n]) => `pod kluczem ${id}: ${n}`)
      .join(', ');
    const odczyt = sejf
      ? `, czytelne bieżącym: ${m.biezacy}, poprzednim: ${m.poprzedni}, nieczytelne: ${m.nieczytelny}`
      : '';
    wypisz(
      `${opisMiejsca(m)}: jawne ${m.jawny}, puste ${m.pusty}, uszkodzone ${m.uszkodzony}, nieznana wersja ${m['nieznana-wersja']}${klucze ? `, ${klucze}` : ''}${odczyt}`,
    );
  }
  wypisz(`wymagane id kluczy: ${p.wymaganeId.length ? p.wymaganeId.join(', ') : 'żadne'}`);
  if (sejf)
    wypisz(
      `klucz w konfiguracji: id ${sejf.idKlucza}${sejf.idPoprzedniego ? `, poprzedni: ${sejf.idPoprzedniego}` : ''}`,
    );
}

function stan(o, env, wypisz) {
  const db = otworz(sciezkaBazy(o, env), { odczyt: true });
  try {
    // `stan` działa także przy złym kluczu w env — wtedy jak bez klucza (klasy i wymagane id z samej bazy).
    let sejf = null;
    if (env[ZMIENNA_KLUCZA]) {
      try {
        sejf = sejfZEnv(env);
      } catch (e) {
        wypisz(`klucz w konfiguracji: nieczytelny (${e.message}) — stan bez odszyfrowania`);
      }
    }
    wypiszStan(przegladSekretow(db, sejf), wypisz, sejf);
    return 0;
  } finally {
    db.close();
  }
}

function sprawdz(o, env, wypisz) {
  if (!o.baza) throw new Uzycie('sprawdz wymaga --baza <plik>');
  const sejf = sejfZEnv(env);
  const db = otworz(o.baza, { odczyt: true });
  try {
    const integralnosc = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    wypisz(`integralność: ${integralnosc}`);
    const p = przegladSekretow(db, sejf);
    wypiszStan(p, wypisz, sejf);
    if (integralnosc !== 'ok') {
      wypisz('BAZA_USZKODZONA');
      return 1;
    }
    if (p.format !== null && (Number.isNaN(p.format) || p.format > FORMAT_SEKRETOW)) {
      wypisz(`FORMAT_NIEOBSLUGIWANY: ${p.format}`);
      return 1;
    }
    const inny = p.problemy.filter((x) => x.kod === 'INNY_KLUCZ');
    if (inny.length) {
      wypisz(
        `KLUCZ_NIEZGODNY: kopia wymaga id ${[...new Set(inny.map((x) => x.idKlucza))].join(', ')}, podano id ${sejf.idKlucza}${sejf.idPoprzedniego ? ` (poprzedni ${sejf.idPoprzedniego})` : ''}`,
      );
      return 1;
    }
    if (p.problemy.length) {
      wypisz(
        `POSWIADCZENIA_USZKODZONE: ${p.problemy.map((x) => `${x.tabela}.${x.kolumna} wiersz ${JSON.stringify(x.wiersz)}`).join('; ')}`,
      );
      return 1;
    }
    if (p.format !== null && p.miejsca.some((m) => m.jawny > 0)) {
      wypisz('JAWNE_W_FORMACIE_1: baza w formacie 1 ma niezaszyfrowane poświadczenia — OMS odmówi startu');
      return 1;
    }
    wypisz('KLUCZ_ZGODNY');
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Klucz z pliku klucz.env albo null, gdy plik jest pusty, ucięty albo zły. Ściśle: dokładnie jedna linia
 * `OMS_KLUCZ_SEKRETOW=<klucz>` bez cudzysłowów — compose (`env_file`) i `docker run --env-file` czytają cudzysłowy
 * i powtórzenia różnie, więc plik, który każdy z nich zrozumiałby inaczej, jest odrzucany zamiast zgadywany.
 */
export function kluczZPliku(plik) {
  const tekst = fs.readFileSync(plik, 'utf8');
  if (tekst.includes('\r')) return null;
  const linie = tekst
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^OMS_KLUCZ_SEKRETOW\s*=/.test(l));
  if (linie.length !== 1 || !linie[0].startsWith(`${ZMIENNA_KLUCZA}=`)) return null;
  const wartosc = linie[0].slice(ZMIENNA_KLUCZA.length + 1);
  if (/["'\s]/.test(wartosc)) return null;
  return bajtyKlucza(wartosc);
}

/** Trwały zapis nowego pliku klucza: plik tymczasowy o losowej nazwie, fsync, dowiązanie bez nadpisania, fsync katalogu. */
export function zapiszNowyKlucz(plik) {
  const klucz = nowyKlucz();
  const katalog = path.dirname(path.resolve(plik));
  fs.mkdirSync(katalog, { recursive: true });
  // Losowa nazwa: w kontenerze node ma zawsze PID 1, więc plik osierocony po awarii (pełny dysk, zabity proces)
  // miałby tę samą nazwę przy każdej próbie i blokował zapis na stałe.
  const tmp = path.join(katalog, `.${path.basename(plik)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(
        fd,
        `# Klucz poświadczeń Twój OMS — zapisz go w menedżerze haseł. Bez niego kopia bazy nie odda podłączonych integracji.\n${ZMIENNA_KLUCZA}=${klucz}\n`,
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(tmp, plik); // EEXIST, gdy plik już jest — nigdy nie nadpisujemy klucza
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.chmodSync(plik, 0o600);
  if (process.platform !== 'win32') {
    const dfd = fs.openSync(katalog, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  }
  return idKlucza(bajtyKlucza(klucz));
}

function bazaMaSzyfrogramy(plik) {
  if (!plik || !fs.existsSync(plik)) return false;
  const db = otworz(plik, { odczyt: true });
  try {
    return przegladSekretow(db, null).wymaganeId;
  } finally {
    db.close();
  }
}

function kluczZapewnij(o, env, wypisz) {
  if (!o.plik) throw new Uzycie('klucz-zapewnij wymaga --plik <ścieżka>');
  if (fs.existsSync(o.plik)) {
    const b = kluczZPliku(o.plik);
    if (!b)
      throw new Odmowa(
        `Plik klucza ${o.plik} istnieje, ale nie ma poprawnej linii ${ZMIENNA_KLUCZA}= (pusty albo ucięty). Nie nadpisuję go: wstaw klucz z menedżera haseł albo — gdy go nie ma — zobacz „utrata klucza” w docs/instalacja-docker.md.`,
      );
    wypisz(`KLUCZ_ISTNIEJE id ${idKlucza(b)}`);
    return 0;
  }
  const wymagane = bazaMaSzyfrogramy(o.baza);
  if (wymagane && wymagane.length) {
    throw new Odmowa(
      `Brak pliku klucza ${o.plik}, a baza ma poświadczenia zaszyfrowane kluczem o id ${wymagane.join(', ')}. Nie tworzę nowego klucza — wstaw do tego pliku klucz z menedżera haseł (linia ${ZMIENNA_KLUCZA}=…). Gdy klucz przepadł: \`sekrety porzuc --nowy-klucz\` (docs/instalacja-docker.md, rozdział „Klucz poświadczeń”).`,
    );
  }
  try {
    wypisz(`KLUCZ_UTWORZONY id ${zapiszNowyKlucz(o.plik)}`);
  } catch (e) {
    // Plik klucza powstał równolegle — walidujemy go (bez rekurencji: drugi EEXIST bez pliku byłby czymś innym).
    if (e?.code !== 'EEXIST' || !fs.existsSync(o.plik)) throw e;
    const b = kluczZPliku(o.plik);
    if (!b)
      throw new Odmowa(`Plik klucza ${o.plik} powstał równolegle, ale nie ma poprawnej linii ${ZMIENNA_KLUCZA}=.`);
    wypisz(`KLUCZ_ISTNIEJE id ${idKlucza(b)}`);
  }
  return 0;
}

function odszyfruj(o, env, wypisz) {
  const plik = sciezkaBazy(o, env);
  const db = otworz(plik, { odczyt: false });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get()) {
      wypisz('ODSZYFROWANE (baza bez tabel — nic do zrobienia)');
      return 0;
    }
    const p = przegladSekretow(db, null);
    // Bez szyfrogramów klucz niepotrzebny — idempotentny sukces także bez klucza.
    const sejf = p.wymaganeId.length || p.format !== null ? sejfZEnv(env) : null;
    const { zmieniono } = sejf ? odszyfrujDoFormatu0(db, sejf) : { zmieniono: 0 };
    wypisz(`ODSZYFROWANE wartości: ${zmieniono}`);
    return 0;
  } finally {
    db.close();
  }
}

/** Nazwy poświadczeń do porzucenia: `integracja:<nazwa>`, `kanal:<klucz>`, `ksef`, `sesja`. */
function nieczytelne(p, zSejfem = true) {
  const nazwy = new Set();
  for (const m of p.miejsca) {
    for (const w of m.wiersze) {
      const zle =
        w.klucz === 'nieczytelny' ||
        (!zSejfem && w.klasa === 'szyfrogram') ||
        w.klasa === 'uszkodzony' ||
        w.klasa === 'nieznana-wersja' ||
        (w.klasa === 'jawny' && p.format !== null);
      if (!zle) continue;
      nazwy.add(
        m.tabela === 'konfiguracja_integracji'
          ? `integracja:${w.id}`
          : m.tabela === 'tokeny_kanalu'
            ? `kanal:${w.id}`
            : m.tabela === 'tokeny_ksef'
              ? 'ksef'
              : 'sesja',
      );
    }
  }
  return [...nazwy].sort();
}

function porzucWBazie(db, sejf, nazwy) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const n of nazwy) {
      if (n.startsWith('integracja:'))
        db.prepare("UPDATE konfiguracja_integracji SET sekrety_json = '{}' WHERE integracja = ?").run(n.slice(11));
      else if (n.startsWith('kanal:')) db.prepare('DELETE FROM tokeny_kanalu WHERE kanal = ?').run(n.slice(6));
      else if (n === 'ksef') {
        db.prepare('DELETE FROM tokeny_ksef').run();
        db.prepare("DELETE FROM ustawienia WHERE klucz = 'ksef.sesja.odcisk'").run();
      } else if (n === 'sesja') {
        db.prepare(
          `INSERT INTO sekret_sesji (id, sekret, zmieniony_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET sekret = excluded.sekret, zmieniony_at = excluded.zmieniony_at`,
        ).run(
          sejf.szyfruj(nowySekret(), { tabela: 'sekret_sesji', kolumna: 'sekret', id: '1' }),
          new Date().toISOString(),
        );
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

function porzuc(o, env, wypisz) {
  const plik = sciezkaBazy(o, env);
  if (o.nowyKlucz) {
    if (!o.plik) throw new Uzycie('porzuc --nowy-klucz wymaga --plik <ścieżka klucz.env>');
    if (fs.existsSync(o.plik))
      throw new Odmowa(
        `Plik klucza ${o.plik} istnieje — \`--nowy-klucz\` jest tylko dla utraconego klucza. Gdy klucz jest dobry, nie porzucaj niczego; gdy to zły plik, przenieś go najpierw w bezpieczne miejsce.`,
      );
    if (!o.wszystkie && !o.potwierdz.length)
      throw new Uzycie(
        'porzuc --nowy-klucz wymaga --potwierdz <nazwa>… albo --potwierdz-wszystkie (podgląd: `porzuc` bez opcji)',
      );
  }
  const db = otworz(plik, { odczyt: !o.wszystkie && !o.potwierdz.length });
  try {
    // Klucz w env — nieczytelne nim; bez klucza (podgląd po utracie, --nowy-klucz) — każdy szyfrogram jest nieczytelny.
    const sejfEnv = !o.nowyKlucz && env[ZMIENNA_KLUCZA] ? sejfZEnv(env) : null;
    const p = przegladSekretow(db, sejfEnv);
    const doPorzucenia = nieczytelne(p, Boolean(sejfEnv));
    if (!o.wszystkie && !o.potwierdz.length) {
      const opis = sejfEnv ? `klucz id ${sejfEnv.idKlucza}` : 'bez klucza — każde zaszyfrowane jest nieczytelne';
      wypisz(
        doPorzucenia.length
          ? `Nieczytelne poświadczenia (${opis}): ${doPorzucenia.join(', ')}`
          : 'Wszystkie poświadczenia czytelne — nic do porzucenia.',
      );
      if (doPorzucenia.length)
        wypisz(
          'Usunięcie: `sekrety porzuc --potwierdz <nazwa>…` albo `--potwierdz-wszystkie` (po utracie klucza z `--nowy-klucz`). Usuwa tylko poświadczenia — ustawienia i powiązania zostają; integracje trzeba podłączyć ponownie.',
        );
      return 0;
    }
    if (!o.nowyKlucz && !sejfEnv) sejfZEnv(env); // zapis bez klucza i bez --nowy-klucz — odmowa z opisem
    const wybrane = o.wszystkie ? doPorzucenia : o.potwierdz;
    const obce = wybrane.filter((n) => !doPorzucenia.includes(n));
    // Nazwy sprawdzone PRZED zapisem nowego klucza — zła nazwa nie zostawia nowego pliku klucza.
    if (obce.length)
      throw new Odmowa(`Te poświadczenia są czytelne albo ich nie ma — nie porzucam: ${obce.join(', ')}`);
    let sejf = sejfEnv;
    if (o.nowyKlucz) {
      // Najpierw trwale nowy klucz, potem jedna transakcja w bazie. Przerwane pomiędzy — ponowienie zwykłym `porzuc`.
      const id = zapiszNowyKlucz(o.plik);
      wypisz(`KLUCZ_UTWORZONY id ${id} — zapisz zawartość ${o.plik} w menedżerze haseł`);
      sejf = utworzSejf(kluczZPliku(o.plik));
    }
    // Przy nowym kluczu sekret sesji zawsze nowy — stary jest nieczytelny nowym kluczem.
    const zSesja =
      o.nowyKlucz && !wybrane.includes('sesja') && doPorzucenia.includes('sesja') ? [...wybrane, 'sesja'] : wybrane;
    porzucWBazie(db, sejf, zSesja);
    wypisz(`PORZUCONE: ${zSesja.length ? zSesja.join(', ') : 'nic'}`);
    const zostaje = doPorzucenia.filter((n) => !zSesja.includes(n));
    if (zostaje.length)
      wypisz(`UWAGA: nadal nieczytelne — OMS nie wystartuje, dopóki ich nie porzucisz: ${zostaje.join(', ')}`);
    return 0;
  } finally {
    db.close();
  }
}

function sprzataj(o, env, wypisz) {
  const db = otworz(sciezkaBazy(o, env), { odczyt: false });
  try {
    const w = sprzatnijPlikBazy(db, { log: wypisz });
    wypisz(w.stan === 'zrobione' ? 'SPRZATNIETE' : w.stan === 'nic' ? 'NIC_DO_SPRZATANIA' : `ODLOZONE: ${w.powod}`);
    return w.stan === 'odlozone' ? 1 : 0;
  } finally {
    db.close();
  }
}

const POLECENIA = { stan, sprawdz, 'klucz-zapewnij': kluczZapewnij, odszyfruj, porzuc, sprzataj };

export function uruchom(argv, env = process.env, wypisz = (t) => console.log(t)) {
  try {
    const o = argumenty(argv);
    const polecenie = POLECENIA[o._[0]];
    if (!polecenie || o._.length > 1) throw new Uzycie(`polecenia: ${Object.keys(POLECENIA).join(', ')}`);
    return polecenie(o, env, wypisz);
  } catch (e) {
    if (e instanceof Uzycie) {
      wypisz(`Użycie: ${e.message}`);
      return 2;
    }
    if (e instanceof Odmowa || e?.name === 'BladKonfiguracji' || e?.name === 'BladSekretow') {
      wypisz(`ODMOWA: ${e.message}`);
      return 1;
    }
    if (['EACCES', 'EPERM', 'EROFS'].includes(e?.code)) {
      wypisz(
        `ODMOWA: brak dostępu do ${e.path ?? 'pliku'} (${e.code}) — pliki w /opt/oms/config i /opt/oms/data należą do użytkownika 10001 (chown 10001:10001, chmod 600 dla klucz.env).`,
      );
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = uruchom(process.argv.slice(2));
}
