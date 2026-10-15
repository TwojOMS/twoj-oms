// REJESTR WIADOMOŚCI WYSŁANYCH DO KLIENTA (22.08.2026).
//
// ⚠️ JEDYNA WARSTWA ZAPYTAŃ tej tabeli — usługi i trasy nie piszą SQL-a same. Uzasadnienie
// samej tabeli (dlaczego rejestr, a nie kolumna per temat) stoi przy niej w schema.sql.
//
// ⚠️ TEN MODUŁ NICZEGO NIE ROZSTRZYGA. Nie wie, czy wolno wysłać, nie zna nazw tematów
// i nie sprawdza duplikatów — powtórna wysyłka jest tu DOZWOLONA z założenia (klient prosi
// o kolejny egzemplarz, przypomnienie idzie drugi raz). Decyzja należy do człowieka przy
// karcie, a ostrzeżenie o powtórce — do widoku.

export function zapiszWiadomosc(db, { zamowienieId, temat_id, adresat, temat, zalacznik = null, kto = null, at }) {
  db.prepare(
    'INSERT INTO wiadomosci (zamowienie_id, temat_id, adresat, temat, zalacznik, wyslana_at, kto) VALUES (?,?,?,?,?,?,?)',
  ).run(zamowienieId, temat_id, adresat, temat, zalacznik, at, kto);
}

/** Wszystkie wiadomości zamówienia, od najstarszej — tak samo jak log karty. */
export function wiadomosciZamowienia(db, zamowienieId) {
  return db.prepare('SELECT * FROM wiadomosci WHERE zamowienie_id = ? ORDER BY id').all(zamowienieId);
}

/**
 * Ostatnia wiadomość danego tematu albo `undefined`.
 *
 * ⚠️ NAJNOWSZA, nie pierwsza: wiersz tematu odpowiada na pytanie „kiedy poszło OSTATNIO",
 * bo od tego zależy, czy operator wysyła przypomnienie po raz drugi tego samego dnia.
 * Sortowanie po `id`, nie po `wyslana_at` — znacznik czasu bywa podany z zewnątrz (testy,
 * import), a `id` rośnie zawsze.
 */
export function ostatniaWiadomosc(db, zamowienieId, temat_id) {
  return db.prepare(
    'SELECT * FROM wiadomosci WHERE zamowienie_id = ? AND temat_id = ? ORDER BY id DESC LIMIT 1',
  ).get(zamowienieId, temat_id);
}
