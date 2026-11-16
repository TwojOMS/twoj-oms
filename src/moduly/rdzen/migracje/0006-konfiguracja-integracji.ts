import type { Migracja } from '../../../core/kontrakty.ts';

// Integracje skonfigurowane w Ustawieniach zamiast w pliku .env (pierwsza: kurier DPD; potem InPost,
// Allegro). Jeden wiersz na integrację. W rdzeniu, a nie w module wysyłki, bo z tej samej tabeli skorzystają
// moduły, które wysyłki nie wymagają (kanały Allegro).
//
// `sekrety_json` to POŚWIADCZENIA — ta sama klasa co `tokeny_kanalu` (reguła „sekrety nie wychodzą”): nie do logu,
// nie do komunikatu błędu, nie na ekran. Wartości czyta budowa klienta integracji, a ekran dostaje wyłącznie
// `stanDlaEkranu` (src/oms/db/konfiguracja-integracji.js).
export const migracjaKonfiguracjiIntegracji: Migracja = {
  numer: 6,
  nazwa: 'konfiguracja integracji z Ustawień',
  wykonaj(db) {
    db.exec(`CREATE TABLE konfiguracja_integracji (
      integracja TEXT PRIMARY KEY,
      ustawienia_json TEXT NOT NULL,
      sekrety_json TEXT NOT NULL,
      konto_id INTEGER,
      konto_login TEXT,
      zmieniono_at TEXT NOT NULL
    )`);
  },
};
