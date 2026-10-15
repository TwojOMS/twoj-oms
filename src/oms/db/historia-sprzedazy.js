// Zapis i odczyt historii sprzedazy zaimportowanej z Apilo. Modul NICZEGO NIE LICZY
// i niczego nie klasyfikuje — kanal rozstrzyga domain/kanaly-raportowe.js przy odczycie,
// zeby zmiana reguly nie wymagala ponownego importu 2000 zamowien.

const teraz = () => new Date().toISOString();

export const PREFIKS_WOO = 'woo:';

const SQL_ZAMOWIENIE = `
  INSERT INTO sprzedaz_historyczna
    (apilo_id, platform_account_id, numer, dzien, utworzone_at, brutto, waluta,
     status, payment_status, tagi_json, klient_email, klient_nazwa, faktura, pobrane_at,
     zrodlo, status_zrodla)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(apilo_id) DO UPDATE SET
    platform_account_id = excluded.platform_account_id, numer = excluded.numer,
    dzien = excluded.dzien, utworzone_at = excluded.utworzone_at, brutto = excluded.brutto,
    waluta = excluded.waluta, status = excluded.status,
    payment_status = excluded.payment_status, tagi_json = excluded.tagi_json,
    klient_email = excluded.klient_email, klient_nazwa = excluded.klient_nazwa,
    faktura = excluded.faktura, pobrane_at = excluded.pobrane_at,
    zrodlo = excluded.zrodlo, status_zrodla = excluded.status_zrodla`;

// ⚠️ BARIERA, NIE WALIDACJA KOSMETYCZNA. `apilo_id` jest kluczem glownym dla obu zrodel,
// wiec sklepowe id bez prefiksu moze trafic w istniejacy klucz Apilo — a `ON CONFLICT DO
// UPDATE` nadpisze wtedy CUDZE zamowienie zamiast wstawic nowe. Wynik: jedna sprzedaz znika,
// druga zmienia kwote, zero bledow.
function sprawdzKlucz(zrodlo, apiloId) {
  const id = String(apiloId ?? '');
  if (zrodlo === 'apilo' && id.startsWith(PREFIKS_WOO)) {
    throw new Error(`Wiersz oznaczony jako 'apilo' ma klucz sklepowy: ${id}`);
  }
  if (zrodlo !== 'apilo' && !id.startsWith(PREFIKS_WOO)) {
    throw new Error(`Wiersz ze zrodla '${zrodlo}' musi miec klucz '${PREFIKS_WOO}…', dostalem: ${id}`);
  }
}

/**
 * Zapisuje zamowienie historyczne razem z pozycjami. IDEMPOTENTNIE.
 *
 * ⚠️ POZYCJE KASUJEMY PRZED WSTAWIENIEM, a nie tylko wstawiamy. Bez tego powtorzony import
 * podwoilby RANKING PRODUKTOW i licznik sztuk, nie ruszajac sumy sprzedazy — czyli usterka
 * widoczna wylacznie w miejscu, na ktore nikt nie patrzy z kalkulatorem.
 *
 * ⚠️⚠️ CALY ZAPIS W JEDNEJ TRANSAKCJI (recenzja Zadania 3 przy budowie Zadania 5/import-apilo.js)
 * — to sa TRZY osobne polecenia (UPSERT naglowka → DELETE pozycji → INSERT pozycji), a w
 * `node:sqlite` kazdy `run()` poza jawna transakcja to WLASNY autocommit. Bez `BEGIN`/`COMMIT`
 * przerwanie procesu (albo blad jednej pozycji — np. NOT NULL na `ilosc` przy zamowieniu ze
 * smieciowymi danymi z Apilo) miedzy DELETE a petla INSERT zostawialoby naglowek BEZ pozycji
 * albo z ich CZESCIA. Zmierzone wprost (przed ta poprawka): druga proba zapisu na tym samym
 * `apilo_id`, w ktorej DRUGA z dwoch pozycji lamala NOT NULL, zostawiala w bazie NOWE (zle)
 * brutto naglowka RAZEM ze STARA pozycja skasowana i tylko PIERWSZA z nowych wstawiona — czyli
 * nie tylko zaniz ranking, ale i NIEZGODNA Z NICZYM sume zamowienia. Import historii (Zadanie 5)
 * wznawia sie po awarii od kursora i odwiedza ten sam `apilo_id` ponownie, wiec dokladnie ten
 * scenariusz — druga proba zapisu na juz-czesciowo-zapisanym zamowieniu — jest tu regula, nie
 * wyjatkiem. `BEGIN IMMEDIATE`, nie `BEGIN`: ten sam powod, co przy migracjach w db/db.js — panel
 * (poller) potrafi pisac do tej samej bazy w tym samym momencie, wiec blokada ma byc wziete
 * OD RAZU, a nie dopiero przy pierwszym `INSERT`.
 */
export function zapiszHistorie(db, z) {
  const zrodlo = z.zrodlo ?? 'apilo';
  sprawdzKlucz(zrodlo, z.apiloId);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(SQL_ZAMOWIENIE).run(
      z.apiloId, z.platformAccountId ?? null, z.numer ?? null, z.dzien, z.utworzoneAt,
      z.brutto, z.waluta ?? 'PLN', z.status ?? null, z.paymentStatus ?? null,
      JSON.stringify(z.tagi ?? []), z.klientEmail ?? null, z.klientNazwa ?? null,
      z.faktura ? 1 : 0, teraz(),
      zrodlo, z.statusZrodla ?? null,
    );
    db.prepare('DELETE FROM sprzedaz_historyczna_pozycje WHERE apilo_id = ?').run(z.apiloId);
    const wstaw = db.prepare(
      'INSERT INTO sprzedaz_historyczna_pozycje'
      + ' (apilo_id, nazwa, sku, original_code, ilosc, brutto_linii, typ) VALUES (?,?,?,?,?,?,?)',
    );
    for (const p of z.pozycje ?? []) {
      wstaw.run(z.apiloId, p.nazwa, p.sku ?? null, p.originalCode ?? null,
        p.ilosc, p.bruttoLinii, p.typ ?? 1);
    }
    db.exec('COMMIT');
  } catch (e) {
    // Polowiczny zapis jest gorszy niz brak zapisu — przerwana proba ma zostawic baze
    // DOKLADNIE w stanie sprzed niej, zeby wznowiony import odwiedzil ten sam `apilo_id`
    // jeszcze raz i zapisal go w calosci, zamiast dziedziczyc cudzy niedokonczony wiersz.
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Zamowienia historyczne w oknie dni. OBIE GRANICE DOMKNIETE — porownanie ostre przy gornej
 * odcinaloby zamowienie z ostatniego dnia, a raport pytajacy miesiac po miesiacu gubilby je
 * zupelnie.
 */
export function historiaWOknie(db, od, doDnia) {
  const wiersze = db.prepare(
    'SELECT * FROM sprzedaz_historyczna WHERE dzien >= ? AND dzien <= ? ORDER BY dzien, apilo_id',
  ).all(od, doDnia);
  if (!wiersze.length) return [];
  const pozycje = db.prepare(
    'SELECT * FROM sprzedaz_historyczna_pozycje WHERE apilo_id IN'
    + ` (SELECT apilo_id FROM sprzedaz_historyczna WHERE dzien >= ? AND dzien <= ?)`,
  ).all(od, doDnia);
  // Jedno zapytanie na pozycje zamiast N+1: raport roczny to ~2000 zamowien, czyli 2000
  // zapytan przy naiwnym rozwiazaniu.
  const wg = new Map();
  for (const p of pozycje) {
    if (!wg.has(p.apilo_id)) wg.set(p.apilo_id, []);
    wg.get(p.apilo_id).push(p);
  }
  return wiersze.map((w) => ({ ...w, pozycje: wg.get(w.apilo_id) ?? [] }));
}

export function ustawGranice(db, kanal, doDnia, zrodlo, uwaga = null) {
  db.prepare(
    'INSERT INTO granice_historii (kanal, do_dnia, zrodlo, uwaga) VALUES (?,?,?,?)'
    + ' ON CONFLICT(kanal) DO UPDATE SET do_dnia = excluded.do_dnia,'
    + ' zrodlo = excluded.zrodlo, uwaga = excluded.uwaga',
  ).run(kanal, doDnia, zrodlo, uwaga);
}

export const granice = (db) => new Map(
  db.prepare('SELECT kanal, do_dnia FROM granice_historii').all().map((w) => [w.kanal, w.do_dnia]),
);

export const wszystkieGranice = (db) => db.prepare(
  'SELECT * FROM granice_historii ORDER BY kanal',
).all();

/**
 * Pierwszy dzien, o ktorym wie ERA APILO dla sklepu A (konto 9).
 *
 * ⚠️⚠️ SUFIT IMPORTU HISTORII SKLEPU MIERZY SIE TYM, NIE WPISUJE Z GLOWY. Sprzedaz sklepowa
 * z zakresu ery Apilo jest juz w tej tabeli; wciagnieta drugi raz z WooCommerce policzy sie
 * PODWOJNIE — i nie rzuci bledem, tylko pokaze lepszy miesiac.
 * `null` = era Apilo jeszcze pusta; wolajacy MUSI wtedy odmowic importu, a nie przyjac
 * „skoro nic nie ma, to wszystko wolno".
 */
export function sufitZApilo(db, konto) {
  if (!Number.isSafeInteger(konto) || konto < 0) throw new Error('Podaj jawne konto Apilo do zmierzenia sufitu historii.');
  const w = db.prepare(
    "SELECT MIN(dzien) AS d FROM sprzedaz_historyczna WHERE zrodlo = 'apilo' AND platform_account_id = ?",
  ).get(konto);
  return w?.d ?? null;
}

export function kursorSklepu(db, sklep) {
  const w = db.prepare('SELECT * FROM stan_importu_sklepu WHERE sklep = ?').get(sklep);
  return w ? { odDnia: w.od_dnia, doDnia: w.do_dnia, ostatniaStrona: w.ostatnia_strona ?? 0 } : null;
}

export function zapiszKursorSklepu(db, { sklep, odDnia, doDnia, ostatniaStrona, blad = null, zakonczonyAt = null }) {
  db.prepare(
    'INSERT INTO stan_importu_sklepu (sklep, od_dnia, do_dnia, ostatnia_strona, zakonczony_at, blad)'
    + ' VALUES (?,?,?,?,?,?) ON CONFLICT(sklep) DO UPDATE SET od_dnia = excluded.od_dnia,'
    + ' do_dnia = excluded.do_dnia, ostatnia_strona = excluded.ostatnia_strona,'
    + ' zakonczony_at = excluded.zakonczony_at, blad = excluded.blad',
  ).run(sklep, odDnia, doDnia, ostatniaStrona, zakonczonyAt, blad);
}

export function wczytajKursorImportu(db) {
  const w = db.prepare('SELECT ostatni_dzien, ostatni_id FROM stan_importu WHERE id = 1').get();
  return { ostatniDzien: w?.ostatni_dzien ?? null, ostatniId: w?.ostatni_id ?? null };
}

export function zapiszKursorImportu(db, { ostatniDzien, ostatniId }) {
  db.prepare('UPDATE stan_importu SET ostatni_dzien = ?, ostatni_id = ?, blad = NULL WHERE id = 1')
    .run(ostatniDzien, ostatniId);
}

export function odnotujKoniecImportu(db) {
  db.prepare('UPDATE stan_importu SET zakonczony_at = ?, blad = NULL WHERE id = 1').run(teraz());
}

export function zapiszBladImportu(db, tresc) {
  db.prepare('UPDATE stan_importu SET blad = ? WHERE id = 1').run(String(tresc).slice(0, 500));
}

export const stanImportu = (db) => db.prepare('SELECT * FROM stan_importu WHERE id = 1').get() ?? null;
