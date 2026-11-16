// Zapytania o konta, uprawnienia i dziennik logowań.
//
// ⚠️ TA WARSTWA NIE ZNA RÓL — zna wyłącznie ptaszki. Rola jest presetem rozstrzyganym
// w domena/ekrany.js i etykietą zapisaną w kolumnie `rola`. Gdyby zapytania czytały role,
// zmiana składu roli przestawiałaby uprawnienia ISTNIEJĄCYM kontom, w których ktoś
// świadomie poprawił ptaszki.

import { zahaszuj } from '../../domena/hasla.js';
import { ekranyRoli } from '../../domena/ekrany.js';

const teraz = () => new Date().toISOString();

// `hashHasla` — gotowy zapis scrypt policzony PRZED transakcją wołającego, żeby scrypt
// (dziesiątki ms) nie trzymał blokady zapisu bazy (BEGIN IMMEDIATE). Bez niego hasło jest haszowane tutaj.
export function zalozKonto(db, { login, imie, haslo, rola, admin = false, ekrany = null, hashHasla = null }) {
  const info = db.prepare(
    'INSERT INTO konta (login, imie, hash_hasla, rola, czynne, admin, utworzone_at) VALUES (?,?,?,?,1,?,?)',
  ).run(String(login), String(imie), hashHasla ?? zahaszuj(haslo), String(rola), admin ? 1 : 0, teraz());
  const id = Number(info.lastInsertRowid);
  ustawUprawnienia(db, id, ekrany ?? ekranyRoli(rola));
  return id;
}

export function ustawUprawnienia(db, kontoId, ekrany) {
  // PODMIANA, nie doklejanie: ekran kont oddaje KOMPLET zaznaczonych ptaszkow, wiec odjecie
  // ptaszka musi znaczyc odjecie uprawnienia. Doklejanie dawaloby formularz, w ktorym da sie
  // tylko dodawac — i nikt by tego nie zauwazyl do pierwszego odejscia pracownika.
  db.prepare('DELETE FROM uprawnienia WHERE konto_id = ?').run(kontoId);
  const wstaw = db.prepare('INSERT INTO uprawnienia (konto_id, ekran) VALUES (?,?)');
  for (const ekran of ekrany) wstaw.run(kontoId, String(ekran));
}

export function kontoPoLoginie(db, login) {
  const w = db.prepare('SELECT * FROM konta WHERE login = ?').get(String(login ?? ''));
  if (!w) return null;
  const ekrany = db.prepare('SELECT ekran FROM uprawnienia WHERE konto_id = ?').all(w.id);
  return {
    id: w.id,
    login: w.login,
    imie: w.imie,
    rola: w.rola,
    czynne: w.czynne === 1,
    admin: w.admin === 1,
    wersja_hasla: w.wersja_hasla,
    uprawnienia: new Set(ekrany.map((e) => e.ekran)),
  };
}

export function ustawCzynne(db, kontoId, czynne) {
  db.prepare('UPDATE konta SET czynne = ? WHERE id = ?').run(czynne ? 1 : 0, kontoId);
}

export function ustawAdmina(db, kontoId, admin) {
  db.prepare('UPDATE konta SET admin = ? WHERE id = ?').run(admin ? 1 : 0, kontoId);
}

export function zmienHaslo(db, kontoId, haslo) {
  ustawHashHasla(db, kontoId, zahaszuj(haslo));
}

/** To samo co zmienHaslo, ale z gotowym zapisem scrypt — do użycia wewnątrz transakcji. */
export function ustawHashHasla(db, kontoId, hashHasla) {
  db.prepare('UPDATE konta SET hash_hasla = ?, wersja_hasla = wersja_hasla + 1 WHERE id = ?').run(hashHasla, kontoId);
}

/**
 * ⚠️ TO JEST PRZELACZNIK DEGRADACJI KONTA Z `.env` (strażnik). Dopóki oddaje
 * `false`, hasło z pliku jest pełnym adminem — bo inaczej pierwszy start na pustej bazie
 * (także u kupującego „Twój OMS") kończyłby się ekranem logowania, do którego nikt nie ma
 * klucza. Od pierwszego CZYNNEGO admina oddaje `true` i brama się zamyka.
 */
// Konto „zaproszone” (bez zapisu scrypt) nie zamyka bramy degradacji — zaproszony
// administrator, którego link zginął, nie może odciąć właściciela od panelu.
export function czyIstniejeCzynnyAdmin(db) {
  const w = db.prepare("SELECT 1 FROM konta WHERE admin = 1 AND czynne = 1 AND hash_hasla LIKE 'scrypt$%' LIMIT 1").get();
  return Boolean(w);
}

export function listaKont(db) {
  return db.prepare(`
    SELECT k.id, k.login, k.imie, k.rola, k.czynne, k.admin,
           (SELECT MAX(at) FROM logowania l WHERE l.login = k.login AND l.wynik = 'udane')
             AS ostatnie_logowanie,
           CASE WHEN k.hash_hasla LIKE 'scrypt$%' THEN 0 ELSE 1 END AS zaproszone
    FROM konta k ORDER BY k.imie COLLATE NOCASE
  `).all().map((w) => ({ ...w, czynne: w.czynne === 1, admin: w.admin === 1, zaproszone: w.zaproszone === 1 }));
}

export function uprawnieniaKonta(db, kontoId) {
  return new Set(
    db.prepare('SELECT ekran FROM uprawnienia WHERE konto_id = ?').all(kontoId).map((e) => e.ekran),
  );
}

// ⚠️⚠️ `login` w dzienniku pochodzi wprost z `req.body.uzytkownik` w logowanie.js, bez żadnego
// ograniczenia długości. Pukanie loginem 100 kB do zapalonej kary dawało setki wierszy na
// sekundę, po 100 kB każdy — dziesiątki megabajtów w samej tej kolumnie. Przycinanie siedzi
// TUTAJ, w jednym miejscu dla WSZYSTKICH wywołań w logowanie.js (udane/nieudane/zablokowane),
// a nie w trasie — nowe miejsce piszące do dziennika dostaje limit za darmo, zamiast musieć
// o nim pamiętać.
export const MAKS_DLUGOSC_LOGINU_W_DZIENNIKU = 64;

export function dopiszLogowanie(db, { login, usluga, ip = null, wynik }) {
  const przyciety = String(login ?? '').slice(0, MAKS_DLUGOSC_LOGINU_W_DZIENNIKU);
  db.prepare('INSERT INTO logowania (at, login, usluga, ip, wynik) VALUES (?,?,?,?,?)')
    .run(teraz(), przyciety, String(usluga), ip, String(wynik));
}

export function ostatnieLogowania(db, limit = 50) {
  return db.prepare('SELECT at, login, usluga, ip, wynik FROM logowania ORDER BY id DESC LIMIT ?')
    .all(Number(limit));
}
