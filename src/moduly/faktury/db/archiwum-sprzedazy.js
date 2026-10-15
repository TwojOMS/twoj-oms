import { zakresMiesiaca } from '../../../domena/lista-faktur.js';
import { bladOperatora } from '../../../domena/bledy.js';

// Dostep do tabel `archiwum_sprzedazy` i `stan_archiwum_sprzedazy` (schema.sql).
// Zrodlem prawdy jest inFakt; tutaj lezy TYLKO „co i gdzie panel zapisal".

export const wierszArchiwum = (db, uuid) => db.prepare(
  'SELECT * FROM archiwum_sprzedazy WHERE uuid = ?',
).get(String(uuid ?? '')) ?? null;

export function wierszeMiesiaca(db, miesiac) {
  const zakres = zakresMiesiaca(miesiac);
  if (!zakres) throw bladOperatora(`„${miesiac ?? ''}" to nie jest miesiąc w formacie RRRR-MM.`);
  return db.prepare(
    'SELECT * FROM archiwum_sprzedazy WHERE invoice_date >= ? AND invoice_date <= ? AND skasowana_at IS NULL'
    + ' ORDER BY invoice_date ASC, numer ASC',
  ).all(zakres.od, zakres.do);
}

export function zapiszWiersz(db, {
  uuid, rodzaj, numer, invoiceDate, saleDate = null, odcisk, sciezkaPdf, zapisanyAt,
}) {
  db.prepare(`
    INSERT INTO archiwum_sprzedazy
      (uuid, rodzaj, numer, invoice_date, sale_date, odcisk, sciezka_pdf, zapisany_at, skasowana_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(uuid) DO UPDATE SET
      rodzaj = excluded.rodzaj, numer = excluded.numer, invoice_date = excluded.invoice_date,
      sale_date = excluded.sale_date, odcisk = excluded.odcisk, sciezka_pdf = excluded.sciezka_pdf,
      zapisany_at = excluded.zapisany_at, skasowana_at = NULL
  `).run(uuid, rodzaj, numer, invoiceDate, saleDate, odcisk, sciezkaPdf, zapisanyAt);
}

export function oznaczSkasowana(db, uuid, { at, sciezkaPdf }) {
  db.prepare('UPDATE archiwum_sprzedazy SET skasowana_at = ?, sciezka_pdf = ? WHERE uuid = ?')
    .run(at, sciezkaPdf, uuid);
}

export const stanArchiwumSprzedazy = (db) => db.prepare(
  'SELECT * FROM stan_archiwum_sprzedazy WHERE id = 1',
).get() ?? null;

// Udany przebieg czysci blad. `podloga_zrobiona_at` ustawia sie RAZ (COALESCE) — to data
// pierwszego pelnego przegladu od stycznia 2026, nie ostatniego.
export function odnotujUdanyPrzebiegArchiwum(db, { chwila, podlogaZrobiona }) {
  db.prepare(`
    INSERT INTO stan_archiwum_sprzedazy (id, podloga_zrobiona_at, ostatnie_udane_at, ostatni_blad, ostatni_blad_at)
    VALUES (1, ?, ?, NULL, NULL)
    ON CONFLICT(id) DO UPDATE SET
      podloga_zrobiona_at = COALESCE(stan_archiwum_sprzedazy.podloga_zrobiona_at, excluded.podloga_zrobiona_at),
      ostatnie_udane_at = excluded.ostatnie_udane_at, ostatni_blad = NULL, ostatni_blad_at = NULL
  `).run(podlogaZrobiona ? chwila : null, chwila);
}

// Blad NIE rusza `ostatnie_udane_at` ani podlogi (wzorzec `zapiszBladPobrania` w db/koszty.js).
export function zapiszBladArchiwum(db, tresc, chwila) {
  db.prepare(`
    INSERT INTO stan_archiwum_sprzedazy (id, ostatni_blad, ostatni_blad_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET ostatni_blad = excluded.ostatni_blad, ostatni_blad_at = excluded.ostatni_blad_at
  `).run(String(tresc ?? '').slice(0, 500), chwila);
}

export const licznikiArchiwum = (db) => {
  const r = db.prepare(
    'SELECT SUM(skasowana_at IS NULL) dokumentow, SUM(skasowana_at IS NOT NULL) skasowanych FROM archiwum_sprzedazy',
  ).get();
  return { dokumentow: Number(r?.dokumentow ?? 0), skasowanych: Number(r?.skasowanych ?? 0) };
};

export function createZapytania(db) {
  return {
    wierszeMiesiaca: (...args) => wierszeMiesiaca(db, ...args),
    zapiszWiersz: (...args) => zapiszWiersz(db, ...args),
    oznaczSkasowana: (...args) => oznaczSkasowana(db, ...args),
    odnotujUdanyPrzebiegArchiwum: (...args) => odnotujUdanyPrzebiegArchiwum(db, ...args),
    zapiszBladArchiwum: (...args) => zapiszBladArchiwum(db, ...args),
  };
}
