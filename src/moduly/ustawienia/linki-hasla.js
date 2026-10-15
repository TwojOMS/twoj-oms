// PRZ-069: jednorazowe linki do ustawienia hasła. W bazie wyłącznie SHA-256 tokenu; ważność 48 h.
// Nowy link unieważnia wcześniejsze nieużyte linki konta; użycie linku unieważnia pozostałe.
import { randomBytes, createHash } from 'node:crypto';
import { ustawHashHasla } from '../../core/bezpieczenstwo/konta.js';
import { zahaszuj } from '../../domena/hasla.js';
import { wTransakcji } from './role.js';

export const WAZNOSC_LINKU_MS = 48 * 60 * 60 * 1000;
export const WARTOWNIK_ZAPROSZENIA = 'zaproszenie';
export const skrotTokenu = (token) => createHash('sha256').update(String(token)).digest('hex');
export const poprawnyKsztaltTokenu = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);

/**
 * Wydaje link. `zastapPoprzednie: false` (recenzja D8 r1, P3-2) — wysyłka mailem: poprzedni link zostaje
 * aktywny, dopóki mail nie wyjdzie (`zastapPoprzednieLinki` po sukcesie, `wycofajLink` po błędzie SMTP).
 */
export function wydajLink(db, { kontoId, cel, utworzylKontoId = null, teraz, zastapPoprzednie = true }) {
  if (!['zaproszenie', 'reset'].includes(cel)) throw new Error('Nieznany cel linku');
  const token = randomBytes(32).toString('base64url');
  const chwila = teraz();
  const wygasaAt = new Date(chwila.getTime() + WAZNOSC_LINKU_MS).toISOString();
  const id = wTransakcji(db, () => {
    if (zastapPoprzednie) {
      db.prepare('UPDATE linki_hasla SET uniewaznione_at = ? WHERE konto_id = ? AND uzyte_at IS NULL AND uniewaznione_at IS NULL')
        .run(chwila.toISOString(), kontoId);
    }
    return Number(db.prepare(`INSERT INTO linki_hasla (konto_id, hash_tokenu, cel, utworzone_at, wygasa_at, utworzyl_konto_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(kontoId, skrotTokenu(token), cel, chwila.toISOString(), wygasaAt, utworzylKontoId).lastInsertRowid);
  });
  return { token, wygasaAt, id };
}

/** Po udanej wysyłce: unieważnia wszystkie inne nieużyte linki konta (jedno UPDATE — atomowe). */
export function zastapPoprzednieLinki(db, { kontoId, nowyLinkId, teraz }) {
  db.prepare('UPDATE linki_hasla SET uniewaznione_at = ? WHERE konto_id = ? AND id <> ? AND uzyte_at IS NULL AND uniewaznione_at IS NULL')
    .run(teraz().toISOString(), kontoId, nowyLinkId);
}

/** Po błędzie wysyłki: wycofuje dokładnie ten jeden link (nikt go nie dostał). */
export function wycofajLink(db, linkId, teraz) {
  db.prepare('UPDATE linki_hasla SET uniewaznione_at = ? WHERE id = ? AND uzyte_at IS NULL AND uniewaznione_at IS NULL')
    .run(teraz().toISOString(), linkId);
}

export function aktywnyLink(db, token, teraz) {
  if (!poprawnyKsztaltTokenu(token)) return null;
  const w = db.prepare(`SELECT l.id, l.konto_id, l.cel, k.login, k.imie FROM linki_hasla l JOIN konta k ON k.id = l.konto_id
    WHERE l.hash_tokenu = ? AND l.uzyte_at IS NULL AND l.uniewaznione_at IS NULL AND l.wygasa_at > ? AND k.czynne = 1`)
    .get(skrotTokenu(token), teraz().toISOString());
  return w ? { id: w.id, kontoId: w.konto_id, cel: w.cel, login: w.login, imie: w.imie } : null;
}

export function uzyjLinku(db, { token, haslo, teraz }) {
  // Recenzja D8 r1, P3-8: scrypt PRZED BEGIN IMMEDIATE — blokada zapisu bazy nie trwa tyle co haszowanie.
  const hashHasla = zahaszuj(haslo);
  return wTransakcji(db, () => {
    const link = aktywnyLink(db, token, teraz);
    if (!link) return null;
    const iso = teraz().toISOString();
    ustawHashHasla(db, link.kontoId, hashHasla);
    db.prepare('UPDATE linki_hasla SET uzyte_at = ? WHERE id = ?').run(iso, link.id);
    // Żywe, nie martwe (recenzja D8 r1, P3-5): w oknie wysyłki maila konto ma dwa aktywne linki naraz.
    db.prepare('UPDATE linki_hasla SET uniewaznione_at = ? WHERE konto_id = ? AND id <> ? AND uzyte_at IS NULL AND uniewaznione_at IS NULL')
      .run(iso, link.kontoId, link.id);
    return { login: link.login };
  });
}

export function uniewaznijLinkiKonta(db, kontoId, teraz) {
  db.prepare('UPDATE linki_hasla SET uniewaznione_at = ? WHERE konto_id = ? AND uzyte_at IS NULL AND uniewaznione_at IS NULL')
    .run(teraz().toISOString(), kontoId);
}
