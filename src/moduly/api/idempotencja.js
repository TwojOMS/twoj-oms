import { blad } from './odpowiedzi.js';

const NAJDLUZSZY_KLUCZ = 200;

const wyslij = (reply, status, cialo) =>
  reply.code(status).type('application/json; charset=utf-8').send(cialo);

/**
 * Zapis `/api/v1` odporny na powtórkę po zerwanym połączeniu (plan PRZ-153, E5.1; Review Focus pkt 3).
 *
 * Bez nagłówka `Idempotency-Key` → `wykonaj()` bez śladu. Z nagłówkiem → JEDNA transakcja (`BEGIN IMMEDIATE`):
 * wpis `(klucz_id, klucz_zadania)` jest → ta sama trasa: zapisany status i to samo ciało, inna trasa: 422;
 * nie ma → `wykonaj()` i `INSERT` wyniku (zwykły INSERT: drugi wpis z tym samym kluczem łamie klucz główny tabeli).
 * Zapamiętany jest każdy wynik < 500 poza 404 i 409, także 400 i 422. Odpowiedzi 404 i 409 zależą od chwilowego stanu danych.
 * Wynik 404, 409, ≥ 500 i wyjątek → ROLLBACK (razem z tym, co zapisało
 * `wykonaj`), nic nie zostaje i powtórka wykonuje się od nowa; wyjątek idzie dalej do obsługi błędów pluginu.
 *
 * `wykonaj` jest synchroniczne (`node:sqlite`) i działa wewnątrz tej transakcji — nie otwiera własnej `BEGIN`
 * (wzór: `if (db.isTransaction) return praca()`). Ciało jest serializowane tutaj raz, więc pierwsza odpowiedź
 * i powtórka mają te same bajty.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} req żądanie z `req.kluczApi` przypiętym przez strażnika
 * @param {any} reply
 * @param {string} trasa np. `'POST /produkty'`
 * @param {() => { status: number, cialo: unknown }} wykonaj
 * @param {{ teraz?: () => Date }} [opcje]
 */
export function zIdempotencja(db, req, reply, trasa, wykonaj, { teraz = () => new Date() } = {}) {
  const naglowek = req.headers['idempotency-key'];
  if (naglowek === undefined) {
    const { status, cialo } = wykonaj();
    return wyslij(reply, status, JSON.stringify(cialo));
  }
  if (typeof naglowek !== 'string' || naglowek.length < 1 || naglowek.length > NAJDLUZSZY_KLUCZ) {
    return blad(reply, 400, 'idempotencja', `Nagłówek Idempotency-Key musi mieć od 1 do ${NAJDLUZSZY_KLUCZ} znaków.`);
  }
  const kluczId = req.kluczApi?.id;
  if (kluczId == null) return blad(reply, 401, 'klucz', 'Brak, zły albo odwołany klucz API.');

  const wlasna = !db.isTransaction;
  if (wlasna) db.exec('BEGIN IMMEDIATE');
  let wynik;
  try {
    const zapisany = db.prepare('SELECT trasa, status, cialo FROM api_idempotencja WHERE klucz_id = ? AND klucz_zadania = ?')
      .get(kluczId, naglowek);
    if (zapisany) {
      wynik = zapisany.trasa === trasa
        ? { status: Number(zapisany.status), cialo: String(zapisany.cialo) }
        : { inna: true };
    } else {
      const { status, cialo } = wykonaj();
      wynik = { status, cialo: cialo === undefined ? '' : JSON.stringify(cialo) };
      if (status === 404 || status === 409 || status >= 500) {
        if (wlasna) db.exec('ROLLBACK');
        return wyslij(reply, wynik.status, wynik.cialo);
      }
      db.prepare('INSERT INTO api_idempotencja (klucz_id, klucz_zadania, trasa, status, cialo, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(kluczId, naglowek, trasa, status, wynik.cialo, teraz().toISOString());
    }
    if (wlasna) db.exec('COMMIT');
  } catch (err) {
    if (wlasna && db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  if (wynik.inna) {
    return blad(reply, 422, 'idempotencja', 'Ten Idempotency-Key był już użyty na innym adresie; użyj nowego klucza.');
  }
  return wyslij(reply, wynik.status, wynik.cialo);
}

/** Sprzątanie zegarem modułu `api`: usuwa wyniki zapisane przed `starszeNiz` (ISO). */
export function wyczyscIdempotencje(db, { starszeNiz }) {
  db.prepare('DELETE FROM api_idempotencja WHERE at < ?').run(starszeNiz);
}
