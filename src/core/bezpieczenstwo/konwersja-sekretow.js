// Stan poświadczeń w bazie: przegląd czterech miejsc, kontrola przed otwarciem bazy, konwersja przy starcie
// i sprzątanie pliku po niej. Jedna klasyfikacja (sejf-sekretow.js `klasyfikuj`) dla wszystkich.
//
// Kiedy wolno przyjąć tekst jawny (tabela rozstrzygnięć):
//   brak znacznika `sekrety.format` (stara baza)  → konwersja: jawny → szyfrogram; uszkodzony / nieznana wersja → odmowa
//   format 1, szyfrogramy pod kluczem bieżącym    → nic do zrobienia
//   format 1, szyfrogramy pod kluczem poprzednim  → przeszyfrowanie na bieżący
//   format 1 i niepusta wartość jawna             → odmowa (błąd zapisu, nie stara baza — nie naprawiamy po cichu)
//   format wyższy niż obsługiwany                 → odmowa („baza z nowszego wydania”)
//
// To nie jest migracja (migracja dostaje samo `db`, bez klucza): schemat się nie zmienia, zmienia się format danych.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BladKonfiguracji } from '../blad-konfiguracji.ts';
import { nowySekret } from './sesja.js';
import {
  BladSekretow, FORMAT_SEKRETOW, KLUCZ_FORMATU, KLUCZ_SPRZATANIA, ZMIENNA_KLUCZA, idKluczaZapisu, klasyfikuj,
} from './sejf-sekretow.js';

/** Cztery miejsca z poświadczeniami. `id` — kolumna klucza głównego (przypięcie szyfrogramu do wiersza). */
export const MIEJSCA_SEKRETOW = Object.freeze([
  { tabela: 'konfiguracja_integracji', kolumna: 'sekrety_json', id: 'integracja', json: true },
  { tabela: 'tokeny_kanalu', kolumna: 'access_token', id: 'kanal' },
  { tabela: 'tokeny_kanalu', kolumna: 'refresh_token', id: 'kanal' },
  { tabela: 'tokeny_ksef', kolumna: 'access_token', id: 'id' },
  { tabela: 'tokeny_ksef', kolumna: 'refresh_token', id: 'id' },
  { tabela: 'sekret_sesji', kolumna: 'sekret', id: 'id' },
]);

const maTabele = (db, nazwa) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nazwa));
const maKolumne = (db, tabela, kolumna) => db.prepare(`PRAGMA table_info(${tabela})`).all().some((k) => k.name === kolumna);
const ustawienie = (db, klucz) => (maTabele(db, 'ustawienia') ? db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(klucz)?.wartosc ?? null : null);

/** Format zapisany w bazie: null = brak znacznika (stara baza albo po `odszyfruj`), liczba, albo NaN dla wartości nieczytelnej. */
export function formatBazy(db) {
  const w = ustawienie(db, KLUCZ_FORMATU);
  if (w === null) return null;
  return /^\d+$/.test(String(w)) ? Number(w) : NaN;
}

/** Powód sprzątania pliku (`jawne` | `poprzedni-klucz`) albo null. */
export function sprzatanieCzeka(db) {
  return ustawienie(db, KLUCZ_SPRZATANIA);
}

/**
 * Przegląd czterech miejsc. Z sejfem — uwierzytelnione odszyfrowanie każdego szyfrogramu; bez sejfu — tylko klasy
 * i wymagane id kluczy (działa na pliku kopii bez klucza).
 */
export function przegladSekretow(db, sejf = null) {
  const miejsca = [];
  const wymaganeId = new Set();
  const problemy = [];
  for (const m of MIEJSCA_SEKRETOW) {
    const wynik = { tabela: m.tabela, kolumna: m.kolumna, pusty: 0, jawny: 0, uszkodzony: 0, 'nieznana-wersja': 0,
      szyfrogram: 0, poKluczach: {}, biezacy: 0, poprzedni: 0, nieczytelny: 0, wiersze: [] };
    miejsca.push(wynik);
    if (!maTabele(db, m.tabela) || !maKolumne(db, m.tabela, m.kolumna)) continue;
    for (const r of db.prepare(`SELECT ${m.id} AS id, ${m.kolumna} AS w FROM ${m.tabela}`).all()) {
      const klasa = klasyfikuj(r.w, { json: m.json });
      wynik[klasa]++;
      const wiersz = { id: String(r.id), kluczGlowny: r.id, klasa, klucz: null };
      wynik.wiersze.push(wiersz);
      if (klasa === 'uszkodzony' || klasa === 'nieznana-wersja') {
        problemy.push({ kod: klasa === 'uszkodzony' ? 'USZKODZONY' : 'NIEZNANA_WERSJA', tabela: m.tabela, kolumna: m.kolumna, wiersz: String(r.id) });
      }
      if (klasa !== 'szyfrogram') continue;
      const id = idKluczaZapisu(r.w);
      wymaganeId.add(id);
      wynik.poKluczach[id] = (wynik.poKluczach[id] ?? 0) + 1;
      if (!sejf) continue;
      try {
        const { poprzedni } = sejf.odszyfrujSzczegolowo(r.w, { tabela: m.tabela, kolumna: m.kolumna, id: r.id });
        wiersz.klucz = poprzedni ? 'poprzedni' : 'biezacy';
        wynik[wiersz.klucz]++;
      } catch (e) {
        if (!(e instanceof BladSekretow)) throw e;
        wynik.nieczytelny++;
        wiersz.klucz = 'nieczytelny';
        problemy.push({ kod: e.kod, tabela: m.tabela, kolumna: m.kolumna, wiersz: String(r.id), idKlucza: id });
      }
    }
  }
  return { format: formatBazy(db), sprzatanie: sprzatanieCzeka(db), miejsca, wymaganeId: [...wymaganeId].sort(), problemy };
}

const bladStartu = (opis) => new BladKonfiguracji(ZMIENNA_KLUCZA, opis,
  'na klucz zapisany przy instalacji (plik klucz.env, kopia w menedżerze haseł). Stan bazy pokaże `sekrety.mjs stan`; opis: docs/instalacja-docker.md, rozdział „Klucz poświadczeń”.');

/** Rozstrzygnięcie z tabeli na górze pliku. Odmowa = BladKonfiguracji (z id kluczy, nigdy z wartościami). */
export function ocenPrzeglad(przeglad, sejf) {
  const { format, problemy, miejsca } = przeglad;
  if (Number.isNaN(format)) throw bladStartu(`Znacznik formatu poświadczeń w bazie (${KLUCZ_FORMATU}) jest nieczytelny.`);
  if (format !== null && format > FORMAT_SEKRETOW) {
    throw bladStartu(`Baza z nowszego wydania: format poświadczeń ${format}, to wydanie zna format ${FORMAT_SEKRETOW}. Uruchom wydanie, które zapisało tę bazę.`);
  }
  const p = problemy[0];
  if (p) {
    const gdzie = `${p.tabela}.${p.kolumna}, wiersz ${JSON.stringify(p.wiersz)}`;
    if (p.kod === 'INNY_KLUCZ') {
      throw bladStartu(`Baza jest zaszyfrowana kluczem o id ${przeglad.wymaganeId.join(', ')}, w konfiguracji jest klucz o id ${sejf.idKlucza}${sejf.idPoprzedniego ? ` (poprzedni: ${sejf.idPoprzedniego})` : ''} — wstaw klucz zapisany przy instalacji (${gdzie}).`);
    }
    if (p.kod === 'NIEZNANA_WERSJA') throw bladStartu(`Poświadczenie w ${gdzie} ma nieznaną wersję formatu — baza z nowszego wydania.`);
    throw bladStartu(`Poświadczenie w ${gdzie} jest uszkodzone albo zaszyfrowane innym kluczem o tym samym id — nie da się go odczytać.`);
  }
  if (format !== null && format >= 1) {
    const jawne = miejsca.filter((m) => m.jawny > 0);
    if (jawne.length) {
      throw bladStartu(`Baza w formacie ${format} ma niezaszyfrowane poświadczenia (${jawne.map((m) => `${m.tabela}.${m.kolumna}: ${m.jawny}`).join(', ')}) — to błąd zapisu, nie stara baza; OMS nie zaszyfruje ich po cichu.`);
    }
  }
}

/**
 * Kontrola przed otwarciem bazy do pracy: połączenie tylko do odczytu, przegląd, rozstrzygnięcie. Odmowa następuje,
 * zanim wykona się jakakolwiek migracja, uzupełnienie danych, reset albo zapis poświadczeń.
 */
export function kontrolaPrzedOtwarciem(sciezka, sejf) {
  if (!sciezka || sciezka === ':memory:' || !fs.existsSync(sciezka)) return null;
  const db = new DatabaseSync(sciezka, { readOnly: true });
  try {
    const przeglad = przegladSekretow(db, sejf);
    ocenPrzeglad(przeglad, sejf);
    return przeglad;
  } finally { db.close(); }
}

const zapiszUstawienie = (db, klucz, wartosc, teraz) => db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
  ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`).run(klucz, String(wartosc), teraz().toISOString());

/** Czy przegląd wymaga jakiegokolwiek zapisu. */
function doZrobienia(przeglad) {
  if (przeglad.format !== FORMAT_SEKRETOW) return true;
  return przeglad.miejsca.some((m) => m.poprzedni > 0 || ((przeglad.format === null || przeglad.format === 0) && m.jawny > 0));
}

/**
 * Konwersja przy starcie: jedna transakcja BEGIN IMMEDIATE. Jawne (tylko bez znacznika) → szyfrogram, sekret sesji
 * jawny → NOWY losowy (wszyscy logują się od nowa); pod kluczem poprzednim → przeszyfrowanie. Gdy cokolwiek zmieniono —
 * znacznik sprzątania pliku. Drugi start nie wykonuje żadnego zapisu.
 */
export function konwertujSekrety(db, sejf, { log = () => {}, teraz = () => new Date() } = {}) {
  if (!maTabele(db, 'ustawienia')) return { zmieniono: 0 };
  const wstepny = przegladSekretow(db, sejf);
  ocenPrzeglad(wstepny, sejf);
  if (!doZrobienia(wstepny)) return { zmieniono: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const przeglad = przegladSekretow(db, sejf);
    ocenPrzeglad(przeglad, sejf);
    // Znacznik „0” (nigdy niezapisywany przez program, ale możliwy ręcznie) znaczy to samo co brak znacznika.
    const bezZnacznika = przeglad.format === null || przeglad.format === 0;
    const liczby = {};
    let jawne = 0, poprzednie = 0;
    for (const [i, m] of przeglad.miejsca.entries()) {
      if (!m.wiersze.length) continue;
      const kolumnaId = MIEJSCA_SEKRETOW[i].id;
      const wpisz = db.prepare(`UPDATE ${m.tabela} SET ${m.kolumna} = ? WHERE ${kolumnaId} = ?`);
      const czytaj = db.prepare(`SELECT ${m.kolumna} AS w FROM ${m.tabela} WHERE ${kolumnaId} = ?`);
      for (const w of m.wiersze) {
        const miejsce = { tabela: m.tabela, kolumna: m.kolumna, id: w.id };
        if (w.klasa === 'jawny' && bezZnacznika) {
          // Sekret sesji jawny nie jest szyfrowany, tylko wymieniany: stary mógł już wyciec razem z kopią bazy.
          const jawny = m.tabela === 'sekret_sesji' ? nowySekret() : czytaj.get(w.kluczGlowny).w;
          wpisz.run(sejf.szyfruj(jawny, miejsce), w.kluczGlowny);
          jawne++;
        } else if (w.klucz === 'poprzedni') {
          wpisz.run(sejf.szyfruj(sejf.odszyfruj(czytaj.get(w.kluczGlowny).w, miejsce), miejsce), w.kluczGlowny);
          poprzednie++;
        } else continue;
        liczby[`${m.tabela}.${m.kolumna}`] = (liczby[`${m.tabela}.${m.kolumna}`] ?? 0) + 1;
      }
    }
    if (jawne + poprzednie > 0) zapiszUstawienie(db, KLUCZ_SPRZATANIA, jawne ? 'jawne' : 'poprzedni-klucz', teraz);
    if (przeglad.format !== FORMAT_SEKRETOW) zapiszUstawienie(db, KLUCZ_FORMATU, FORMAT_SEKRETOW, teraz);
    db.exec('COMMIT');
    if (jawne + poprzednie > 0) {
      log(`poświadczenia: zaszyfrowano kluczem ${sejf.idKlucza} — ${Object.entries(liczby).map(([k, n]) => `${k}: ${n}`).join(', ')}`
        + `${jawne && liczby['sekret_sesji.sekret'] ? ' (sekret sesji wymieniony — wszyscy logują się od nowa)' : ''}`);
    }
    return { zmieniono: jawne + poprzednie, jawne, poprzednie, liczby };
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

/** Ścieżka pliku głównej bazy uchwytu albo null (baza w pamięci). */
export function plikBazy(db) {
  const p = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main')?.file;
  return p ? p : null;
}

export const UWAGA_SPRZATANIA = 'Sprzątanie pliku bazy po zaszyfrowaniu poświadczeń nie jest zakończone — stare wartości mogą jeszcze leżeć w wolnych miejscach pliku bazy. OMS ponowi je przy następnym starcie; od razu: `aktualizuj.sh sekrety sprzataj` (opis: docs/instalacja-docker.md, rozdział „Klucz poświadczeń”).';

/**
 * Sprzątanie pliku po konwersji: VACUUM poza transakcją, potem `wal_checkpoint(TRUNCATE)` z odczytem wyniku (busy = 0);
 * dopiero wtedy znacznik znika. Brak miejsca, błąd albo zajęty WAL — znacznik zostaje, ostrzeżenie, start trwa dalej.
 * Nigdy nie rzuca.
 */
export function sprzatnijPlikBazy(db, { log = () => {}, wolneMiejsce = wolneMiejsceDysku } = {}) {
  const powod = sprzatanieCzeka(db);
  if (!powod) return { stan: 'nic' };
  try {
    if (db.isTransaction) return { stan: 'odlozone', powod: 'otwarta transakcja' };
    const plik = plikBazy(db);
    if (plik) {
      const rozmiar = [plik, `${plik}-wal`].reduce((s, p) => s + (fs.existsSync(p) ? fs.statSync(p).size : 0), 0);
      const wolne = wolneMiejsce(path.dirname(plik));
      if (wolne !== null && wolne < 2 * rozmiar) {
        log(`Ostrzeżenie: sprzątanie pliku bazy po zaszyfrowaniu poświadczeń odłożone — wolne ${wolne} B, potrzeba do ${2 * rozmiar} B.`);
        return { stan: 'odlozone', powod: 'brak miejsca' };
      }
    }
    db.exec('VACUUM');
    const cp = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (cp && Number(cp.busy) !== 0) {
      log('Ostrzeżenie: sprzątanie pliku bazy po zaszyfrowaniu poświadczeń odłożone — dziennik WAL zajęty przez inne połączenie.');
      return { stan: 'odlozone', powod: 'WAL zajęty' };
    }
    db.prepare('DELETE FROM ustawienia WHERE klucz = ?').run(KLUCZ_SPRZATANIA);
    log(`poświadczenia: plik bazy przepakowany po konwersji (${powod})`);
    return { stan: 'zrobione' };
  } catch (e) {
    log(`Ostrzeżenie: sprzątanie pliku bazy po zaszyfrowaniu poświadczeń nie powiodło się (${e?.code ?? e?.name ?? 'błąd'}) — ponowienie przy następnym starcie.`);
    return { stan: 'odlozone', powod: 'błąd' };
  }
}

export function wolneMiejsceDysku(katalog) {
  try { const s = fs.statfsSync(katalog); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

/**
 * Przejście formatu 1 → 0 (powrót na starsze wydanie): jedna transakcja, idempotentne. Baza bez znacznika i bez
 * szyfrogramów = sukces bez zmian; uszkodzony szyfrogram = odmowa bez częściowego zapisu.
 */
export function odszyfrujDoFormatu0(db, sejf, { teraz = () => new Date() } = {}) {
  const wstepny = przegladSekretow(db, sejf);
  const szyfrogramy = wstepny.miejsca.reduce((s, m) => s + m.szyfrogram, 0);
  if (wstepny.format === null && szyfrogramy === 0) return { zmieniono: 0 };
  if (wstepny.problemy.length) {
    const p = wstepny.problemy[0];
    throw new BladSekretow(p.kod, `Odszyfrowanie przerwane przed zapisem: ${p.tabela}.${p.kolumna}, wiersz ${JSON.stringify(p.wiersz)} (${p.kod}).`, { tabela: p.tabela, wiersz: p.wiersz });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    let n = 0;
    for (const m of MIEJSCA_SEKRETOW) {
      if (!maTabele(db, m.tabela) || !maKolumne(db, m.tabela, m.kolumna)) continue;
      const wpisz = db.prepare(`UPDATE ${m.tabela} SET ${m.kolumna} = ? WHERE ${m.id} = ?`);
      for (const r of db.prepare(`SELECT ${m.id} AS id, ${m.kolumna} AS w FROM ${m.tabela}`).all()) {
        if (klasyfikuj(r.w, { json: m.json }) !== 'szyfrogram') continue;
        wpisz.run(sejf.odszyfruj(r.w, { tabela: m.tabela, kolumna: m.kolumna, id: r.id }), r.id);
        n++;
      }
    }
    if (maTabele(db, 'ustawienia')) {
      db.prepare('DELETE FROM ustawienia WHERE klucz = ?').run(KLUCZ_FORMATU);
      // Tekst jawny wraca do pliku z założenia — stary program go potrzebuje; znacznik sprzątania nie ma tu sensu.
      db.prepare('DELETE FROM ustawienia WHERE klucz = ?').run(KLUCZ_SPRZATANIA);
    }
    db.exec('COMMIT');
    void teraz;
    return { zmieniono: n };
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}
