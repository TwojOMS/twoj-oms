// PRZ-069: e-mail konta (osobna tabela, plan O2) i konto zaproszone (bez hasła, wartownik zamiast scrypt).
// Status „zaproszone” wyliczany z faktów: hash_hasla nie jest zapisem scrypt (spec §4.2).
import { WARTOWNIK_ZAPROSZENIA } from './linki-hasla.js';
import { zalozKonto } from '../../core/bezpieczenstwo/konta.js';
import { zahaszuj } from '../../domena/hasla.js';
import { przypiszRoleBezTransakcji, rolaPoKluczu, wTransakcji, malymi } from './role.js';

export class BladKonta extends Error { constructor(kod, komunikat) { super(komunikat); this.kod = kod; } }
export const czyZaproszone = (hashHasla) => !String(hashHasla ?? '').startsWith('scrypt$');
const FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KOMUNIKAT_EMAIL_ZAJETY = 'Ten adres e-mail ma już inne konto.';

/**
 * Recenzja D8 r1, P3-6: kontrola w kodzie i INSERT to dwa kroki — drugi proces na tej samej bazie może
 * zająć e-mail albo login pomiędzy nimi. UNIQUE z bazy zamieniamy na tę samą odmowę co kontrola w kodzie
 * (400), zamiast surowego błędu SQLite w odpowiedzi 500.
 */
function zUnikalnoscia(fn) {
  try { return fn(); } catch (e) {
    const tekst = String(e?.message ?? '');
    if (e?.errcode === 2067 || /UNIQUE constraint failed/.test(tekst)) {
      if (tekst.includes('konta_email')) throw new BladKonta('email-zajety', KOMUNIKAT_EMAIL_ZAJETY);
      if (tekst.includes('konta.login')) throw new BladKonta('login-zajety', 'Login jest już zajęty przez inne konto.');
    }
    throw e;
  }
}

export function emailKonta(db, kontoId) {
  return db.prepare('SELECT email FROM konta_email WHERE konto_id = ?').get(kontoId)?.email ?? null;
}

/** Sprawdza format i unikalność bez zapisu (do walidacji przed założeniem konta). */
export function sprawdzEmail(db, kontoId, email) {
  const czysty = String(email ?? '').trim();
  if (!FORMAT.test(czysty) || czysty.length > 254) throw new BladKonta('email-format', 'Niepoprawny adres e-mail.');
  const zajety = db.prepare('SELECT konto_id, email FROM konta_email').all()
    .some((w) => w.konto_id !== kontoId && malymi(w.email) === malymi(czysty));
  if (zajety) throw new BladKonta('email-zajety', KOMUNIKAT_EMAIL_ZAJETY);
  return czysty;
}

export function ustawEmail(db, kontoId, email, teraz) {
  return zUnikalnoscia(() => wTransakcji(db, () => {
    const czysty = sprawdzEmail(db, kontoId, email);
    db.prepare(`INSERT INTO konta_email (konto_id, email, zmieniono_at) VALUES (?, ?, ?)
      ON CONFLICT(konto_id) DO UPDATE SET email = excluded.email, zmieniono_at = excluded.zmieniono_at`)
      .run(kontoId, czysty, teraz().toISOString());
  }));
}

/**
 * Konto z hasłem (stara ścieżka `/nowe` z `haslo`): INSERT z ekranami roli Z BAZY i przypisanie roli w JEDNEJ
 * transakcji — awaria pomiędzy nie zostawia konta z presetem z kodu (recenzja D8 r1).
 * Recenzja D8 r1 PRZ-068, P3-8: scrypt PRZED `BEGIN IMMEDIATE` — w transakcji tylko gotowy zapis.
 */
export function zalozKontoZHaslem(db, { login, imie, haslo, rola }) {
  const hashHasla = zahaszuj(haslo);
  return zUnikalnoscia(() => wTransakcji(db, () => {
    const r = rolaPoKluczu(db, rola);
    if (!r) throw new BladKonta('rola', 'Nieznana rola.');
    const nowe = zalozKonto(db, { login, imie, hashHasla, rola: r.klucz, admin: r.admin, ekrany: [...r.ekrany] });
    przypiszRoleBezTransakcji(db, nowe, r.klucz);
    return nowe;
  }));
}

export function zalozKontoZaproszone(db, { login, imie, rola, email = null, teraz }) {
  const r = rolaPoKluczu(db, rola);
  if (!r) throw new BladKonta('rola', 'Nieznana rola.');
  return zUnikalnoscia(() => wTransakcji(db, () => {
    const info = db.prepare('INSERT INTO konta (login, imie, hash_hasla, rola, czynne, admin, utworzone_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(String(login), String(imie), WARTOWNIK_ZAPROSZENIA, r.klucz, r.admin ? 1 : 0, teraz().toISOString());
    const nowe = Number(info.lastInsertRowid);
    przypiszRoleBezTransakcji(db, nowe, r.klucz);
    if (email) {
      db.prepare('INSERT INTO konta_email (konto_id, email, zmieniono_at) VALUES (?, ?, ?)')
        .run(nowe, sprawdzEmail(db, nowe, email), teraz().toISOString());
    }
    return nowe;
  }));
}
