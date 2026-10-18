import type { ModulOms } from '../../core/kontrakty.ts';
import { otworzBaze, wykonajMigracje } from '../../core/baza.ts';
import { oznaczKluczeZamrozenia, rozdajNoweUprawnienia } from '../../core/uprawnienia.ts';
import { ROLE, ekranyRoli } from '../../domena/ekrany.js';
import { modulRdzen } from '../../moduly/rdzen/modul.ts';
import { uzupelnijZdjeciaPozycji } from './uzupelnienia-kanalow.js';
import { uzupelnijDaneZamowien } from './uzupelnienia-zamowien.js';
import { przygotujKoszty } from './przygotowanie-kosztow.js';
import { sledzZmianyListy } from './sledzenie-listy.js';

export const MIGRACJA_PTASZEK_STATYSTYKI = 'ptaszek-statystyki-2026-09-13';

/** Uzgadnia frozen marker z D5; istniejący marker nigdy nie przywraca odebranych praw. */
export function dosypPtaszekStatystyk(db: Parameters<typeof oznaczKluczeZamrozenia>[0], teraz = () => new Date()): void {
  const stary = db.prepare('SELECT 1 FROM migracje_jednorazowe WHERE nazwa = ?').get(MIGRACJA_PTASZEK_STATYSTYKI);
  const d5 = db.prepare('SELECT 1 FROM uprawnienia_rozdane WHERE klucz = ?').get('statystyki');
  if (stary) {
    if (!d5) oznaczKluczeZamrozenia(db, ['statystyki'], teraz);
    return;
  }
  if (!d5) {
    // Ten sam dystrybutor co bootstrap; wyłącznie statystyki, preset jest źródłem ról.
    rozdajNoweUprawnienia(db, [{
      ...(modulRdzen as unknown as ModulOms),
      uprawnienia: [{
        klucz: 'statystyki', etykieta: 'Statystyki',
        role: Object.keys(ROLE).filter(rola => ekranyRoli(rola).includes('statystyki')),
      }],
    }], teraz);
  }
  // Awaria tutaj pozostawia D5: ponowienie zapisze marker bez ponownego rozdania.
  db.prepare('INSERT OR IGNORE INTO migracje_jednorazowe (nazwa, wykonana_at) VALUES (?, ?)')
    .run(MIGRACJA_PTASZEK_STATYSTYKI, teraz().toISOString());
}

export const MIGRACJA_PTASZEK_CELE = 'ptaszek-cele-2026-09-13';

/** Uzgadnia frozen marker z D5; istniejący marker nigdy nie przywraca odebranych praw. */
export function dosypPtaszekCeli(db: Parameters<typeof oznaczKluczeZamrozenia>[0], teraz = () => new Date()): void {
  const stary = db.prepare('SELECT 1 FROM migracje_jednorazowe WHERE nazwa = ?').get(MIGRACJA_PTASZEK_CELE);
  const d5 = db.prepare('SELECT 1 FROM uprawnienia_rozdane WHERE klucz = ?').get('cele');
  if (stary) {
    if (!d5) oznaczKluczeZamrozenia(db, ['cele'], teraz);
    return;
  }
  if (!d5) {
    // Ten sam dystrybutor co bootstrap; wyłącznie cele, preset jest źródłem ról.
    rozdajNoweUprawnienia(db, [{
      ...(modulRdzen as unknown as ModulOms),
      uprawnienia: [{
        klucz: 'cele', etykieta: 'Cele',
        role: Object.keys(ROLE).filter(rola => ekranyRoli(rola).includes('cele')),
      }],
    }], teraz);
  }
  // Awaria tutaj pozostawia D5: ponowienie zapisze marker bez ponownego rozdania.
  db.prepare('INSERT OR IGNORE INTO migracje_jednorazowe (nazwa, wykonana_at) VALUES (?, ?)')
    .run(MIGRACJA_PTASZEK_CELE, teraz().toISOString());
}

/** Fabryka produkcyjna; schemat pochodzi z migracji modułów, bez firmowych seedów. */
export function openOmsDb(path = ':memory:', {
  moduly = [modulRdzen as unknown as ModulOms], teraz = () => new Date(), log,
}: { moduly?: readonly ModulOms[]; teraz?: () => Date; log?: (linia: string) => void } = {}) {
  const db = otworzBaze(path);
  try {
    wykonajMigracje(db, moduly, teraz);
    // PRZ-051: przed uzupełnieniami niżej — one też zmieniają zamówienia.
    sledzZmianyListy(db);
    if (moduly.some(modul => modul.nazwa === 'rdzen')) { dosypPtaszekStatystyk(db, teraz); dosypPtaszekCeli(db, teraz); }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kategorie_kosztow'").get()) przygotujKoszty(db);
    // Operacyjny singleton ze starego schema.sql; baseline przechowuje tylko DDL.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stan_importu'").get()) {
      db.prepare('INSERT OR IGNORE INTO stan_importu (id) VALUES (1)').run();
      uzupelnijZdjeciaPozycji(db);
      uzupelnijDaneZamowien(db, { teraz, log });
    }
    return db;
  }
  catch (error) { db.close(); throw error; }
}
