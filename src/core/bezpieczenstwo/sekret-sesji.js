// Sekret podpisujący ciasteczka sesji. Tabelę `sekret_sesji` zakłada migracja bazowa
// (src/moduly/rdzen/migracje/0001-baseline.sql); sekret należy do jednej bazy, więc
// „Wyloguj wszystkie osoby” unieważnia ciasteczka tylko tej instalacji.
//
// ⚠️ TA WARTOŚĆ JEST POŚWIADCZENIEM. Nie wypisujemy jej do logu, nie wkładamy do
// komunikatu błędu i nie oddajemy na ekran. Kto ją ma, ten wystawi sobie ważne
// ciasteczko na dowolne konto — bez znajomości hasła.

import { nowySekret } from './sesja.js';

/**
 * Sekret do podpisywania i sprawdzania ciasteczek. Zaklada go przy pierwszym wywolaniu.
 *
 * ⚠️ ZAKŁADANIE MUSI BYĆ ATOMOWE. Poller chodzi cyklicznie, równolegle z żądaniami
 * z przeglądarki, więc dwa wątki potrafią trafić tu w tej samej chwili na świeżej bazie.
 * `INSERT OR IGNORE` + ponowny SELECT sprawiają, że drugi z nich odczyta sekret zapisany
 * przez pierwszego, zamiast nadpisać go swoim — nadpisanie wylogowałoby operatora
 * w losowym momencie startu i wyglądało na usterkę ciasteczek.
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
 * ⚠️ TEJ funkcji używa strażnik przy KAŻDYM żądaniu, i to jest cała różnica. Zakładanie
 * sekretu to sprawa STARTU usługi, nie obsługi kliknięcia: `wczytajSekret` w haku na
 * żądaniu próbowałby zapisu przy każdym wejściu na stronę, więc baza, do której chwilowo
 * nie da się pisać (pełny dysk), przestawałaby oddawać COKOLWIEK — zamiast dalej pokazywać
 * to, co już ma. Panel ma się wtedy degradować do odczytu, a nie oddawać 500.
 */
export function odczytajSekret(db) {
  return db.prepare('SELECT sekret FROM sekret_sesji WHERE id = 1').get()?.sekret ?? null;
}

/**
 * Podmienia sekret — czyli uniewaznia WSZYSTKIE wydane ciasteczka naraz.
 * To jest cala implementacja „Wyloguj wszystkie osoby": nie ma listy sesji do
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
 * czlowiekowi. Bez tego przycisk „Wyloguj wszystkie osoby" nie mialby zadnego
 * potwierdzenia, ze cokolwiek zrobil.
 */
export function sekretZmienionyAt(db) {
  return db.prepare('SELECT zmieniony_at FROM sekret_sesji WHERE id = 1').get()?.zmieniony_at ?? null;
}
