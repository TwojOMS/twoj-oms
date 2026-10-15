// Sekret podpisujacy ciasteczka sesji. Tabele `sekret_sesji` zaklada schema.sql KAZDEJ
// z baz osobno (src/db/ i src/oms/db/) — panele maja rozdzielne bazy i rozdzielne
// sekrety, wiec „Wyloguj wszystkie urzadzenia" w jednym nie rusza drugiego.
//
// ⚠️ TA WARTOSC JEST POSWIADCZENIEM (niezmiennik 4.10). Nie wypisujemy jej do logu, nie
// wkladamy do komunikatu bledu i nie oddajemy na ekran. Kto ja ma, ten wystawi sobie wazne
// ciasteczko na dowolne konto — bez znajomosci hasla.

import { nowySekret } from './sesja.js';

/**
 * Sekret do podpisywania i sprawdzania ciasteczek. Zaklada go przy pierwszym wywolaniu.
 *
 * ⚠️ ZAKLADANIE MUSI BYC ATOMOWE. Poller chodzi co dwie minuty rownolegle z zadaniami
 * z przegladarki, wiec dwa watki potrafia trafic tu w tej samej chwili na swiezej bazie.
 * `INSERT OR IGNORE` + ponowny SELECT sprawiaja, ze drugi z nich odczyta sekret zapisany
 * przez pierwszego, zamiast nadpisac go swoim — nadpisanie wylogowaloby operatora
 * w losowym momencie startu i wygladalo na usterke ciasteczek.
 */
export function wczytajSekret(db) {
  const istniejacy = db.prepare('SELECT sekret FROM sekret_sesji WHERE id = 1').get();
  if (istniejacy?.sekret) return istniejacy.sekret;

  db.prepare('INSERT OR IGNORE INTO sekret_sesji (id, sekret, zmieniony_at) VALUES (1, ?, ?)')
    .run(nowySekret(), new Date().toISOString());

  return db.prepare('SELECT sekret FROM sekret_sesji WHERE id = 1').get().sekret;
}

/**
 * Sam ODCZYT sekretu — bez zakladania go, gdy go nie ma. Zwraca `null` zamiast pisac.
 *
 * ⚠️ TEJ funkcji uzywa straznik przy KAZDYM zadaniu, i to jest cala roznica. Zakladanie
 * sekretu to sprawa STARTU uslugi, nie obslugi kliknięcia: `wczytajSekret` w haku na
 * zadaniu probowalby zapisu przy kazdym wejsciu na strone, wiec baza, do ktorej chwilowo
 * nie da sie pisac (pelny dysk), przestawalaby oddawac COKOLWIEK — zamiast dalej pokazywac
 * to, co juz ma. Zlapala to suita: szesc testow „baza bez zapisow" oddawalo 500 tam, gdzie
 * panel ma sie degradowac do odczytu.
 */
export function odczytajSekret(db) {
  return db.prepare('SELECT sekret FROM sekret_sesji WHERE id = 1').get()?.sekret ?? null;
}

/**
 * Podmienia sekret — czyli uniewaznia WSZYSTKIE wydane ciasteczka naraz.
 * To jest cala implementacja „Wyloguj wszystkie urzadzenia": nie ma listy sesji do
 * przejrzenia, bo nie ma tabeli sesji. Zwraca nowy sekret, zeby wolajacy mogl od razu
 * wystawic swieze ciasteczko urzadzeniu, ktore wlasnie klika przycisk.
 */
export function podmienSekret(db) {
  const sekret = nowySekret();
  db.prepare(`
    INSERT INTO sekret_sesji (id, sekret, zmieniony_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET sekret = excluded.sekret, zmieniony_at = excluded.zmieniony_at
  `).run(sekret, new Date().toISOString());
  return sekret;
}

/**
 * Kiedy ostatnio podmieniono sekret — jedyna rzecz z tej tabeli, ktora WOLNO pokazac
 * czlowiekowi. Bez tego przycisk „Wyloguj wszystkie urzadzenia" nie mialby zadnego
 * potwierdzenia, ze cokolwiek zrobil.
 */
export function sekretZmienionyAt(db) {
  return db.prepare('SELECT zmieniony_at FROM sekret_sesji WHERE id = 1').get()?.zmieniony_at ?? null;
}
