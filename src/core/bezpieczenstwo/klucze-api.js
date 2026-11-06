import { ZAKRESY_API, nowyKlucz, czyZakresyPoprawne } from '../../domena/klucze-api.js';

export function zalozKluczApi(db, { nazwa, zakresy, kontoId, wygasaAt = null, teraz }) {
  if (typeof nazwa !== 'string' || !nazwa.trim()) throw new Error('Nazwa klucza nie może być pusta.');
  if (!czyZakresyPoprawne(zakresy)) throw new Error('Niepoprawne zakresy klucza API.');
  const { klucz, prefiks, skrot } = nowyKlucz();
  const wynik = db.prepare(`INSERT INTO klucze_api
    (nazwa, prefiks, skrot, zakresy, utworzyl_konto_id, utworzony_at, wygasa_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(nazwa.trim(), prefiks, skrot,
    JSON.stringify(ZAKRESY_API.filter(zakres => zakresy.includes(zakres))), kontoId ?? null, teraz, wygasaAt);
  return { id: Number(wynik.lastInsertRowid), klucz, prefiks };
}

export function kluczPoSkrocie(db, skrot) {
  const wiersz = db.prepare('SELECT * FROM klucze_api WHERE skrot = ?').get(skrot);
  return wiersz ? { ...wiersz, zakresy: JSON.parse(wiersz.zakresy) } : null;
}

export function odwolajKluczApi(db, id, teraz) {
  return db.prepare('UPDATE klucze_api SET odwolany_at = ? WHERE id = ? AND odwolany_at IS NULL')
    .run(teraz, id).changes > 0;
}

export function listaKluczyApi(db) {
  return db.prepare(`SELECT k.id, k.nazwa, k.prefiks, k.zakresy, k.utworzyl_konto_id,
    k.utworzony_at, k.wygasa_at, k.odwolany_at, k.ostatnio_uzyty_at, k.ostatnie_ip,
    konta.login AS utworzyl_login, konta.czynne AS utworzyl_czynne
    FROM klucze_api k LEFT JOIN konta ON konta.id = k.utworzyl_konto_id
    ORDER BY k.id`).all().map(wiersz => ({ ...wiersz, zakresy: JSON.parse(wiersz.zakresy) }));
}

export function usunKluczApi(db, id, teraz) {
  db.exec('BEGIN IMMEDIATE');
  try {
    odwolajKluczApi(db, id, teraz);
    const usuniety = db.prepare('DELETE FROM klucze_api WHERE id = ?').run(id).changes > 0;
    db.exec('COMMIT');
    return usuniety;
  } catch (blad) {
    db.exec('ROLLBACK');
    throw blad;
  }
}

export function odnotujUzycie(db, id, { teraz, ip }) {
  db.prepare('UPDATE klucze_api SET ostatnio_uzyty_at = ?, ostatnie_ip = ? WHERE id = ?')
    .run(teraz, ip ?? null, id);
}

export function dopiszDoDziennikaApi(db, { kluczId, prefiks, at, metoda, sciezka, status, ip }) {
  db.prepare(`INSERT INTO klucze_api_dziennik (klucz_id, prefiks, at, metoda, sciezka, status, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(kluczId ?? null, prefiks ?? null, at, metoda, sciezka, status, ip ?? null);
}

export function wyczyscDziennikApi(db, { starszeNiz }) {
  db.prepare('DELETE FROM klucze_api_dziennik WHERE at < ?').run(starszeNiz);
}
