// Zapytania zakladki CELE (spec 2026-09-13).
//
// ⚠️ TA WARSTWA NIE ZNA ANI MIERNIKOW, ANI OKRESOW. Dostaje gotowy zakres `{od, do}`
// wyliczony przez domain/cele-okres.js i sumuje po nim zdarzenia. Gdyby liczyla okresy
// sama, konwencja tygodnia stalaby w dwoch miejscach i rozjechalaby sie przy pierwszej
// zmianie — dokladnie tak, jak rozjechaly sie kiedys lista ekranow i pasek ikon.

const teraz = () => new Date().toISOString();

export function zalozCel(db, { nazwa, kontoId, rytm, celIle, miernik, odDnia, doDnia }) {
  const t = teraz();
  const info = db.prepare(
    'INSERT INTO cele (nazwa, konto_id, rytm, cel_ile, miernik, od_dnia, do_dnia,'
    + ' czynny, utworzony_at, zmieniony_at) VALUES (?,?,?,?,?,?,?,1,?,?)',
  ).run(String(nazwa), kontoId ?? null, String(rytm), celIle ?? null,
    String(miernik), odDnia ?? null, doDnia ?? null, t, t);
  return Number(info.lastInsertRowid);
}

export function zapiszCel(db, id, { nazwa, kontoId, rytm, celIle, miernik, odDnia, doDnia }) {
  db.prepare(
    'UPDATE cele SET nazwa = ?, konto_id = ?, rytm = ?, cel_ile = ?, miernik = ?,'
    + ' od_dnia = ?, do_dnia = ?, zmieniony_at = ? WHERE id = ?',
  ).run(String(nazwa), kontoId ?? null, String(rytm), celIle ?? null,
    String(miernik), odDnia ?? null, doDnia ?? null, teraz(), Number(id));
}

/** Wygaszenie/przywrocenie. ⚠️ Celu NIE KASUJEMY — zdarzenia maja przezyc. */
export function ustawCzynny(db, id, czynny) {
  db.prepare('UPDATE cele SET czynny = ?, zmieniony_at = ? WHERE id = ?')
    .run(czynny ? 1 : 0, teraz(), Number(id));
}

export function listaCelow(db, { tylkoCzynne = false } = {}) {
  const warunek = tylkoCzynne ? ' WHERE czynny = 1' : '';
  // Wygaszone na koncu, potem po nazwie — lista ma byc stabilna miedzy odswiezeniami,
  // bo inaczej przycisk „+1" wedruje pod kursorem po kazdym wygaszeniu.
  return db.prepare(`SELECT * FROM cele${warunek} ORDER BY czynny DESC, nazwa ASC, id ASC`).all();
}

export function celPoId(db, id) {
  return db.prepare('SELECT * FROM cele WHERE id = ?').get(Number(id)) ?? null;
}

export function dopiszZdarzenie(db, { celId, dzien, ile = 1, kontoId = null, notatka = null }) {
  const info = db.prepare(
    'INSERT INTO cele_zdarzenia (cel_id, dzien, ile, konto_id, notatka, zapisane_at)'
    + ' VALUES (?,?,?,?,?,?)',
  ).run(Number(celId), String(dzien), Number(ile), kontoId ?? null, notatka ?? null, teraz());
  return Number(info.lastInsertRowid);
}

/**
 * Suma zdarzen celu w zakresie dni + dzien OSTATNIEGO wpisu.
 *
 * `ostatniDzien` jest `zrodloAt` miernika recznego: kafel pokazuje z niego „ostatni wpis
 * 12.09" albo „ostatni wpis: nigdy". To jedyny sygnal, jaki da sie nalozyc na licznik
 * reczny — bo licznik reczny mierzy KLIKANIE, nie prace.
 *
 * ⚠️ `od`/`do` moga byc `null` (cel jednorazowy bez dat) i wtedy zakres jest NIEOGRANICZONY
 * z tej strony. `dzien >= NULL` w SQLite daje NULL, czyli falsz — bez warunku `? IS NULL`
 * cel bez terminu sumowalby ZERO zdarzen i wygladal na nietkniety.
 */
export function sumaZdarzen(db, celId, { od = null, do: doDnia = null } = {}) {
  const w = db.prepare(
    'SELECT COALESCE(SUM(ile), 0) AS ile, MAX(dzien) AS ostatni FROM cele_zdarzenia'
    + ' WHERE cel_id = ? AND (? IS NULL OR dzien >= ?) AND (? IS NULL OR dzien <= ?)',
  ).get(Number(celId), od, od, doDnia, doDnia);
  return { ile: Number(w.ile), ostatniDzien: w.ostatni ?? null };
}

/** Historia celu, najstarsze pierwsze. `imie_konta` NULL = konto serwisowe albo czuwacz. */
export function zdarzeniaCelu(db, celId, limit = 200) {
  return db.prepare(
    'SELECT z.*, k.imie AS imie_konta FROM cele_zdarzenia z'
    + ' LEFT JOIN konta k ON k.id = z.konto_id'
    + ' WHERE z.cel_id = ? ORDER BY z.dzien ASC, z.id ASC LIMIT ?',
  ).all(Number(celId), Number(limit));
}

/**
 * Zdejmuje OSTATNIE zdarzenie celu w zakresie — czyjekolwiek, spojnie z regula
 * „kazdy klika na cudzym".
 *
 * ⚠️ ZAKRES JEST OGRANICZENIEM, NIE OZDOBA. Cofniecie ma naprawiac omylkowy klik sprzed
 * chwili, a nie przepisywac zamkniety tydzien. Bez warunku na dni „cofnij" wcisniete
 * w pustym tygodniu zjadaloby historie wstecz — i nikt by tego nie zauwazyl.
 *
 * @returns {boolean} czy cokolwiek zdjeto
 */
export function cofnijOstatnie(db, celId, { od = null, do: doDnia = null } = {}) {
  const w = db.prepare(
    'SELECT id FROM cele_zdarzenia WHERE cel_id = ?'
    + ' AND (? IS NULL OR dzien >= ?) AND (? IS NULL OR dzien <= ?)'
    // `id DESC` po `dzien DESC`: dwa wpisy tego samego dnia rozstrzyga kolejnosc zapisu.
    + ' ORDER BY dzien DESC, id DESC LIMIT 1',
  ).get(Number(celId), od, od, doDnia, doDnia);
  if (!w) return false;
  db.prepare('DELETE FROM cele_zdarzenia WHERE id = ?').run(w.id);
  return true;
}
