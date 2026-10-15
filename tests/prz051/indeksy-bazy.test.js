// PRZ-051 — indeksy uzasadnione pomiarem: plan zapytania ma ich używać. Bez nich (pomiar na
// 15 000 zamówień) start panelu trwał ~40 s, a pole „Płatność" nad listą 129–157 ms.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { wstawMieszane, otworzBazeListy } from './pomoc.js';

const plan = (db, sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((w) => w.detail).join(' | ');

describe('PRZ-051 indeksy', () => {
  const db = otworzBazeListy();
  wstawMieszane(db, { powtorzen: 2 });
  db.exec('ANALYZE');

  it('uzupełnienie wyslane_at przy starcie szuka paczek zamówienia indeksem, nie skanem', () => {
    const p = plan(db, `SELECT 1 FROM zamowienia WHERE wyslane_at IS NULL AND EXISTS (SELECT 1 FROM przesylki p
      WHERE p.zamowienie_id = zamowienia.id AND p.status = 'nadana' AND p.utworzona_at < '2026-01-01' AND p.zrodlo_numeru IS NOT 'allegro')`);
    expect(p).toMatch(/SEARCH p (EXISTS )?USING INDEX przesylki_zamowienie/);
  });

  it('przeniesienie wpłat przy starcie i odczyt wpłat zamówienia idą indeksem', () => {
    expect(plan(db, 'SELECT 1 FROM zamowienia WHERE NOT EXISTS (SELECT 1 FROM platnosci p WHERE p.zamowienie_id = zamowienia.id)'))
      .toMatch(/SEARCH p (EXISTS )?USING (COVERING )?INDEX platnosci_zamowienie/);
    expect(plan(db, 'SELECT * FROM platnosci WHERE zamowienie_id = 1 ORDER BY COALESCE(data, utworzona_at), id'))
      .toMatch(/USING INDEX platnosci_zamowienie/);
  });

  it('metody płatności nad listą czyta indeks pokrywający, nie wiersze z surowe_json', () => {
    expect(plan(db, "SELECT DISTINCT metoda_platnosci AS m FROM zamowienia WHERE metoda_platnosci IS NOT NULL AND TRIM(metoda_platnosci) <> '' ORDER BY m COLLATE NOCASE"))
      .toMatch(/COVERING INDEX zamowienia_metoda_platnosci/);
  });

  it('bezpiecznik kanałów (każde /health i każda lista) czyta okno 30 dni indeksem wyrażeniowym', () => {
    // Pomiar PRZ-051, 50 000 zamówień ze 100 dni: 230 ms bez indeksu, 4 ms z nim.
    // Dosłownie zapytanie z modułu zdrowia, z parametrami (plan dla literałów może być inny).
    const sql = fs.readFileSync('src/moduly/zdrowie/bezpiecznik-kanalow.ts', 'utf8').match(/db\.prepare\(`([\s\S]*?)`\)/)[1];
    const iso = '2026-10-09T10:00:00.000Z';
    expect(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(iso, iso).map((w) => w.detail).join(' | ')).toMatch(/INDEX zamowienia_julianday_utworzenia/);
  });

  it('ostrzeżenie o pobraniach czyta tylko zamówienia za pobraniem, nie wszystkie faktury', () => {
    // Pomiar PRZ-051, 50 000 zamówień: 35 ms bez indeksu, 0,1 ms z nim.
    expect(plan(db, `SELECT z.id FROM faktury f JOIN zamowienia z ON z.id = f.zamowienie_id
      WHERE (z.pobranie = 1 OR z.wysylka_reczna_json IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM zwroty w WHERE w.zamowienie_id = z.id) ORDER BY z.id`))
      .toMatch(/INDEX zamowienia_pobranie/);
  });

  it('strona i liczniki indeksu listy idą indeksami lista_stan', () => {
    expect(plan(db, 'SELECT zamowienie_id FROM lista_stan ORDER BY utworzone_at DESC, zamowienie_id DESC LIMIT 100'))
      .toMatch(/lista_stan_porzadek/);
    expect(plan(db, "SELECT zamowienie_id FROM lista_stan WHERE status = 'nowe' ORDER BY utworzone_at DESC, zamowienie_id DESC LIMIT 100"))
      .toMatch(/lista_stan_status/);
    expect(plan(db, 'SELECT COUNT(*) FROM lista_stan WHERE robocze_od <= 1')).toMatch(/lista_stan_robocze/);
    expect(plan(db, 'SELECT COUNT(*) FROM lista_stan WHERE po_terminie_od <= 1')).toMatch(/lista_stan_termin/);
  });
});
