// PRZ-051 — syntetyczne zamówienia do testów listy (bez danych firmy).
//
// Wstawianie gołym SQL-em w jednej transakcji, bo granica 32 767 wierszy ma się sprawdzać
// w sekundach, a `zapiszZamowienie` na wiersz robi kilka zapytań i wpis do logu.
import { openOmsDb } from '../../src/oms/db/db.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import { migracjaIndeksuListy } from '../../src/moduly/zamowienia/migracje/0001-indeks-listy.ts';

/** Baza z rdzeniem i migracją modułu zamówień (tabele indeksu listy) — jak w panelu. */
export const otworzBazeListy = (sciezka = ':memory:') => openOmsDb(sciezka, {
  moduly: [modulRdzen, { nazwa: 'zamowienia', migracje: [migracjaIndeksuListy] }],
});

export const KANALY_TESTOWE = [
  { klucz: 'kanal_a', typ: 'woo', prefiks: 'A', etykieta: 'Sklep syntetyczny A', raport: 'SKLEP_A' },
  { klucz: 'kanal_b', typ: 'allegro', prefiks: 'B', etykieta: 'Rynek syntetyczny B', raport: 'RYNEK_B' },
];

/**
 * Same wiersze `zamowienia`, bez dzieci. `utworzone` liczy datę wiersza (domyślnie jedna
 * data dla wszystkich — po to, żeby kolejność rozstrzygał wyłącznie identyfikator).
 */
export function wstawGole(db, n, { utworzone = () => '2026-10-01T10:00:00', sklep = 'kanal_a', od = 1 } = {}) {
  const ins = db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, metoda_wysylki, utworzone_at)
    VALUES (?, ?, ?, '10.00', 'dpd', ?)`);
  const ids = [];
  db.exec('BEGIN');
  try {
    for (let i = od; i < od + n; i++) ids.push(Number(ins.run(sklep, i, `T-${i}`, utworzone(i)).lastInsertRowid));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return ids;
}

/**
 * Zestaw mieszany: każdy stan, który rozróżnia panel boczny (nowe, indywidualne, w realizacji,
 * wysłane, zwrot, anulowane, anulowane z paczką, faktura do wyjaśnienia, paczka bez etykiety,
 * nieudany sync, opłacone dawno = po terminie), po kilka sztuk, z dziećmi.
 */
export function wstawMieszane(db, { powtorzen = 3 } = {}) {
  const insZ = db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, klient_json, dostawa_json, metoda_wysylki, kwota_brutto,
    oplacone_at, anulowane, anulowane_recznie, w_realizacji_at, zwrot_at, utworzone_at, wyslane_at, metoda_platnosci, indywidualne, sync_woo_blad, pobranie, b2b)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insP = db.prepare(`INSERT INTO pozycje (zamowienie_id, nazwa, sku, ilosc, cena_brutto, brutto_linii, vat) VALUES (?,?,?,1,'10.00','10.00','23')`);
  const insPl = db.prepare(`INSERT INTO platnosci (zamowienie_id, kwota, data, metoda, zrodlo, utworzona_at) VALUES (?, '10.00', ?, 'Przelew', 'sklep', ?)`);
  const insPrz = db.prepare(`INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_sciezka, status_kuriera, status_kuriera_at, utworzona_at, kolejnosc)
    VALUES (?, 'dpd', ?, ?, ?, ?, ?, ?, 1)`);
  const insF = db.prepare(`INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, utworzona_at) VALUES (?,?,?,?,?)`);
  const insZw = db.prepare(`INSERT INTO zwroty (zamowienie_id, data, kwota, pieniadze_oddane_at, utworzony_at) VALUES (?, '2026-09-20', '10.00', ?, '2026-09-20T10:00:00Z')`);
  const rodzaje = [
    { nazwa: 'nowe' },
    // Ręczna zmiana metody wysyłki: sklep mówi dpd, panel — odbiór osobisty (filtr ma widzieć efektywną).
    { nazwa: 'odbior-reczny', wysylkaReczna: 'odbior_osobisty' },
    // Telefon zapisany ze spacjami i prefiksem — fraza cyfrowa ma go znaleźć po samych cyfrach.
    { nazwa: 'z-telefonem', telefon: true },
    { nazwa: 'nowe-oplacone-dawno', oplacone: '2026-09-01T09:00:00Z' },
    { nazwa: 'indywidualne', indywidualne: 1 },
    { nazwa: 'w-realizacji', wReal: '2026-09-30T10:00:00Z' },
    { nazwa: 'wyslane-czyste', wyslane: '2026-09-25T10:00:00Z', paczka: 'doreczona', oplacone: '2026-09-24T10:00:00Z' },
    { nazwa: 'wyslane-bez-etykiety', wyslane: '2026-09-25T10:00:00Z', paczka: 'bez-etykiety', oplacone: '2026-09-24T10:00:00Z' },
    { nazwa: 'wyslane-faktura-do-wyjasnienia', wyslane: '2026-09-25T10:00:00Z', paczka: 'doreczona', faktura: 'do_wyjasnienia', oplacone: '2026-09-24T10:00:00Z' },
    { nazwa: 'wyslane-sync', wyslane: '2026-09-25T10:00:00Z', paczka: 'doreczona', sync: 'odmowa', oplacone: '2026-09-24T10:00:00Z' },
    { nazwa: 'wyslane-w-drodze', wyslane: '2026-09-25T10:00:00Z', paczka: 'w-drodze', oplacone: '2026-09-24T10:00:00Z' },
    { nazwa: 'zwrot-rozliczony', wyslane: '2026-09-15T10:00:00Z', paczka: 'doreczona', zwrot: 'oddane', oplacone: '2026-09-14T10:00:00Z' },
    { nazwa: 'zwrot-nierozliczony', wyslane: '2026-09-15T10:00:00Z', paczka: 'doreczona', zwrot: 'nieoddane', oplacone: '2026-09-14T10:00:00Z' },
    { nazwa: 'anulowane', anulowane: 1 },
    { nazwa: 'anulowane-z-paczka', anulowane: 1, paczka: 'doreczona' },
    { nazwa: 'anulowane-recznie', anulowaneRecznie: 1 },
    { nazwa: 'faktura-w-toku', faktura: 'w_toku', fakturaAt: '2026-09-01T10:00:00Z' },
    // Przejścia w czasie wokół 2026-10-01T09:30Z (chwila T0 testu klasyfikacji): zegar
    // wysyłki rusza tuż przed T0, faktura „w toku" staje się sprawą 3 minuty po T0.
    { nazwa: 'oplacone-swiezo', oplacone: '2026-10-01T08:00:00Z' },
    { nazwa: 'faktura-swiezo-w-toku', wyslane: '2026-09-30T10:00:00Z', paczka: 'doreczona', faktura: 'w_toku', fakturaAt: '2026-10-01T09:28:00Z', oplacone: '2026-09-29T10:00:00Z' },
    // Każda gałąź reguł zależna od czasu ma tu zamówienie, które w horyzoncie PRZECHODZI
    // (recenzja PRZ-051: test monotoniczności odwiedzał 2 z 6 gałęzi). T0 to czwartek 11:30 PL.
    // Allegro opłacone przed 12:00 w dzień roboczy: limit 0, po terminie od piątku.
    { nazwa: 'allegro-przed-12', sklep: 'allegro_test', oplacone: '2026-10-01T08:00:00Z', utw: '2026-10-01T07:55:00Z' },
    // Pobranie i B2B: zegar od złożenia, nie od wpłaty (której nie ma).
    { nazwa: 'pobranie-swieze', pobranie: 1, utw: '2026-10-01T09:00:00Z' },
    { nazwa: 'b2b-swieze', b2b: 1, utw: '2026-10-01T09:00:00Z' },
    // Ekspres (po nazwie pozycji): limit 2 dni robocze.
    { nazwa: 'ekspres-oplacone', pozycja: 'Realizacja ekspresowa', oplacone: '2026-10-01T08:00:00Z', utw: '2026-10-01T07:55:00Z' },
    // Indywidualne opłacone: limit 7 dni roboczych.
    { nazwa: 'indywidualne-oplacone', indywidualne: 1, oplacone: '2026-10-01T08:00:00Z', utw: '2026-10-01T07:55:00Z' },
    // Paczka „w trakcie" nadania: po 5 minutach „zawieszona" = sprawa.
    { nazwa: 'paczka-w-trakcie', wyslane: '2026-09-30T10:00:00Z', paczka: 'w-trakcie', oplacone: '2026-09-29T10:00:00Z' },
    // Paczka wysłana wczoraj, ostatni ruch wczoraj: „bez ruchu" po 3 dniach roboczych.
    { nazwa: 'paczka-stanie', wyslane: '2026-09-30T10:00:00Z', paczka: 'w-drodze', oplacone: '2026-09-29T10:00:00Z' },
  ];
  const wynik = [];
  // Kolejne wywołanie dokłada nowe zamówienia, a nie koliduje z UNIQUE (sklep, zrodlo_id).
  let n = db.prepare('SELECT COALESCE(MAX(zrodlo_id), 0) AS n FROM zamowienia').get().n;
  db.exec('BEGIN');
  try {
    for (let k = 0; k < powtorzen; k++) {
      for (const r of rodzaje) {
        n++;
        const utw = r.utw ?? `2026-09-${String(10 + (n % 18)).padStart(2, '0')}T${String(8 + (n % 10)).padStart(2, '0')}:00:00`;
        const sklep = r.sklep ?? (n % 3 === 0 ? 'kanal_b' : 'kanal_a');
        const id = Number(insZ.run(sklep, n, `M-${n}`,
          JSON.stringify({ first_name: `Imię${n}`, last_name: n % 4 === 0 ? 'Kowalski' : `Zażółć${n}`, email: `m${n}@email.invalid`,
            ...(r.telefon ? { phone: `+48 600 ${String(n).padStart(3, '0')} 777` } : {}) }),
          JSON.stringify({ first_name: `Imię${n}`, last_name: n % 4 === 0 ? 'Kowalski' : `Zażółć${n}`, city: n % 2 ? 'Pęki' : 'Miasto' }),
          r.wysylkaReczna ? 'dpd' : n % 2 ? 'dpd' : 'inpost_paczkomat', '10.00', r.oplacone ?? null, r.anulowane ?? 0, r.anulowaneRecznie ?? null, r.wReal ?? null, null, utw,
          r.wyslane ?? null, n % 2 ? 'Przelew' : 'BLIK', r.indywidualne ?? null, r.sync ?? null, r.pobranie ?? 0, r.b2b ?? 0).lastInsertRowid);
        insP.run(id, r.pozycja ?? `Produkt ${n % 5}`, `SKU-${n}`);
        if (r.wysylkaReczna) db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ? WHERE id = ?').run(JSON.stringify({ metoda: r.wysylkaReczna }), id);
        if (r.telefon) wynik.telefon = { id, cyfry: `600${String(n).padStart(3, '0')}777` };
        if (r.oplacone) insPl.run(id, r.oplacone, r.oplacone);
        if (r.paczka === 'doreczona') insPrz.run(id, 'nadana', `L${n}`, `/tmp/e${n}.pdf`, 'Doręczona', r.wyslane ?? '2026-09-25T10:00:00Z', r.wyslane ?? '2026-09-25T10:00:00Z');
        if (r.paczka === 'bez-etykiety') insPrz.run(id, 'nadana', `L${n}`, null, 'Doręczona', r.wyslane, r.wyslane);
        if (r.paczka === 'w-drodze') insPrz.run(id, 'nadana', `L${n}`, `/tmp/e${n}.pdf`, 'W drodze', r.wyslane, r.wyslane);
        if (r.paczka === 'w-trakcie') insPrz.run(id, 'w_trakcie', null, null, null, null, '2026-10-01T09:28:00Z');
        if (r.faktura === 'do_wyjasnienia') insF.run(id, `u${n}`, `FV/${n}`, 'do_wyjasnienia', '2026-09-25T10:00:00Z');
        if (r.faktura === 'w_toku') insF.run(id, `u${n}`, null, 'w_toku', r.fakturaAt);
        if (r.zwrot) insZw.run(id, r.zwrot === 'oddane' ? '2026-09-21T10:00:00Z' : null);
        wynik.push({ id, rodzaj: r.nazwa });
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return wynik;
}
