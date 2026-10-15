// Lustro watkow Centrum wiadomosci + dowody wysylki. Ten modul NIE zna Allegro i NIE zna
// regul autorespondera — sam zapis i odczyt. Decyzje siedza w domain/ i services/.

import { tekstZAllegro } from '../../domena/tekst-allegro.js';

// ⚠️ ODCZYT DO EKRANU ROZWIJA ENCJE HTML z tekstu Allegro („&Oacute;" → „Ó") — powod i pomiar
// w domena/tekst-allegro.js. Lustro zostaje surowe. Rozwijamy WYLACZNIE to, co przyszlo
// z Allegro (`ostatnia_tresc` w `listaWatkow`, `tresc` w `wiadomosciWatku`):
// - NIE w `watek()` — poller czyta stamtad `ostatnia_tresc` i zapisuje ja z powrotem, wiec
//   rozwiniety tekst wrocilby do lustra i przy nastepnym odczycie rozwijal sie drugi raz;
// - NIGDY w dowodach z `allegro_odpowiedzi` — te wpisal czlowiek w panelu i „&oacute;"
//   napisane tam z palca ma zostac tekstem.
const czytelnyWatek = (w) => ({ ...w, ostatnia_tresc: tekstZAllegro(w.ostatnia_tresc) });

export function zapiszWatek(db, w) {
  db.prepare(`
    INSERT INTO allegro_watki
      (kanal, thread_id, interlocutor_login, last_message_date_time, typ, przeczytany,
       ostatnia_od_kupujacego, ostatnia_tresc, pobrany_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kanal, thread_id) DO UPDATE SET
      interlocutor_login = excluded.interlocutor_login,
      last_message_date_time = excluded.last_message_date_time,
      typ = excluded.typ,
      przeczytany = excluded.przeczytany,
      ostatnia_od_kupujacego = excluded.ostatnia_od_kupujacego,
      ostatnia_tresc = excluded.ostatnia_tresc,
      pobrany_at = excluded.pobrany_at
  `).run(
    w.kanal, w.threadId, w.interlocutorLogin ?? null, w.lastMessageDateTime ?? null,
    w.typ ?? null, w.przeczytany ? 1 : 0, w.ostatniaOdKupujacego ? 1 : 0,
    w.ostatniaTresc ?? null, w.pobranyAt ?? new Date().toISOString(),
  );
}

// ⚠️⚠️ `zamkniete_do` JEDZIE RAZEM Z WIERSZEM, a nie osobnym wywolaniem — i to jest cala
// sztuczka tej funkcji. Czytelnikow watkow jest TRZECH: kolejka /wiadomosci, czuwacz formulki
// i tabelka ostrzezen na stronie glownej. Zlaczenie tutaj daje reczne „Zalatwione" wszystkim
// trzem naraz, bez zmiany w zadnym z nich — a trzy osobne odpytania to trzy okazje, zeby
// ktores zapomnialo i watek zamkniety recznie dalej wolal o pomoc w jednym miejscu.
//
// ⚠️ `w.*`, nigdy `*` — zlaczenie z `SELECT *` wciagneloby tez `z.kanal` i `z.thread_id`
// i nadpisaloby kolumny lustra wartosciami z drugiej tabeli.
const KOLUMNY_WATKU = 'w.*, z.zamkniete_do AS zamkniete_do';
const ZLACZENIE = `FROM allegro_watki w
  LEFT JOIN allegro_zamkniecia z ON z.kanal = w.kanal AND z.thread_id = w.thread_id`;

export function listaWatkow(db) {
  return db.prepare(
    `SELECT ${KOLUMNY_WATKU} ${ZLACZENIE} ORDER BY w.last_message_date_time DESC, w.thread_id DESC`,
  ).all().map(czytelnyWatek);
}

export function watek(db, kanal, threadId) {
  return db.prepare(`SELECT ${KOLUMNY_WATKU} ${ZLACZENIE} WHERE w.kanal = ? AND w.thread_id = ?`)
    .get(kanal, threadId);
}

/**
 * Reczne „Zalatwione" przy watku.
 *
 * ⚠️ ZAPISUJEMY DATE OSTATNIEJ WIADOMOSCI, nie sam znacznik. Dzieki temu nowa wiadomosc
 * kupujacego otwiera watek z powrotem SAMA (domain/czyj-ruch-watku.js) — przelacznik bez
 * daty uciszalby go na zawsze, a nowe pytanie przepadaloby po cichu.
 *
 * ⚠️ NADPISUJE: po nowej wiadomosci wolno zamknac watek jeszcze raz.
 */
export function zamknijWatek(db, kanal, threadId, zamknieteDo, teraz) {
  db.prepare(`
    INSERT INTO allegro_zamkniecia (kanal, thread_id, zamkniete_do, zamkniete_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(kanal, thread_id) DO UPDATE SET
      zamkniete_do = excluded.zamkniete_do,
      zamkniete_at = excluded.zamkniete_at
  `).run(kanal, threadId, zamknieteDo, teraz ?? new Date().toISOString());
}

/**
 * Dowod wysylki. ⚠️ Wolany PRZED strzalem do Allegro. Przy duplikacie formulki rzuca
 * (indeks czesciowy `allegro_formulka_raz`) — i to jest poprawne zachowanie, nie usterka:
 * wolajacy ma sie wtedy wycofac, a nie wysylac.
 */
export function zapiszDowod(db, { kanal, threadId, rodzaj, tresc }, teraz = new Date().toISOString()) {
  const w = db.prepare(`
    INSERT INTO allegro_odpowiedzi (kanal, thread_id, rodzaj, tresc, zapisany_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(kanal, threadId, rodzaj, tresc, teraz);
  return { id: Number(w.lastInsertRowid) };
}

export function oznaczWyslane(db, id, teraz = new Date().toISOString()) {
  db.prepare('UPDATE allegro_odpowiedzi SET wyslany_at = ?, blad = NULL WHERE id = ?').run(teraz, id);
}

// ⚠️ BLAD NIE KASUJE WPISU. Skasowanie zwolniloby indeks i przy nastepnym przebiegu
// formulka poszlaby drugi raz — a nie wiemy, czy pierwsza nie dotarla.
export function oznaczBlad(db, id, komunikat) {
  db.prepare('UPDATE allegro_odpowiedzi SET blad = ? WHERE id = ?').run(String(komunikat), id);
}

export function dowody(db, kanal, threadId) {
  return db.prepare(
    'SELECT * FROM allegro_odpowiedzi WHERE kanal = ? AND thread_id = ? ORDER BY id',
  ).all(kanal, threadId);
}

/**
 * Wiadomosci watku, chronologicznie. Upsert po (kanal, thread_id, message_id) — poller
 * przechodzi po tych samych wiadomosciach przy kazdej zmianie watku i nie moze ich dublowac.
 */
export function zapiszWiadomosci(db, kanal, threadId, wiadomosci = []) {
  const wpis = db.prepare(`
    INSERT INTO allegro_wiadomosci (kanal, thread_id, message_id, od_kupujacego, tresc, utworzona_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(kanal, thread_id, message_id) DO UPDATE SET
      od_kupujacego = excluded.od_kupujacego, tresc = excluded.tresc,
      utworzona_at = excluded.utworzona_at
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const m of wiadomosci) {
      wpis.run(kanal, threadId, m.id, m.author?.isInterlocutor ? 1 : 0, m.text ?? null, m.createdAt ?? null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function wiadomosciWatku(db, kanal, threadId) {
  return db.prepare(`
    SELECT * FROM allegro_wiadomosci WHERE kanal = ? AND thread_id = ?
    ORDER BY utworzona_at, rowid
  `).all(kanal, threadId).map((m) => ({ ...m, tresc: tekstZAllegro(m.tresc) }));
}

/** Ile formulek FAKTYCZNIE wyszlo od `odIso` — bezpiecznik ilosciowy czuwacza. */
export function licznikFormulek(db, odIso) {
  const r = db.prepare(`
    SELECT COUNT(*) AS ile FROM allegro_odpowiedzi
    WHERE rodzaj = 'formulka' AND wyslany_at IS NOT NULL AND wyslany_at >= ?
  `).get(odIso);
  return Number(r.ile);
}
