import type { DatabaseSync } from 'node:sqlite';
import type { Migracja } from '../../../core/kontrakty.ts';

// Adres producenta w polach: ulica z numerem, kod pocztowy, miejscowość i kraj (kod ISO). Pola dają kraj,
// którego GPSR wymaga na etykiecie, i kod sprawdzany według kraju — jedno pole tekstowe tego nie zapewniało.
//
// Kolumna `adres` zostaje NOT NULL i dalej trzyma adres w jednym tekście: z niego czytają karta, opis GPSR
// i eksporty. Nowy zapis składa ją domena z pól. Starzy producenci (z jednym polem) zostają bez zmian, z NULL
// w nowych kolumnach — przepisanie adresu do pól robi człowiek w formularzu, bo tekstu nie da się pewnie
// rozdzielić. Dlatego kolumny bez NOT NULL i bez CHECK (strażnik migracji nie pozwala dokładać ograniczeń
// do istniejącej tabeli); postać kodu i listę krajów pilnuje `walidujProducenta`.
//
// Wyłącznie addytywna i odporna na ponowienie: dokłada tylko brakujące kolumny. Wycofanie wydania zostawia
// kolumny, których stary obraz nie zna i nie czyta.
const KOLUMNY = ['ulica', 'kod_pocztowy', 'miasto', 'kraj'];

export const migracjaAdresuProducenta: Migracja = {
  numer: 23,
  nazwa: 'adres producenta w polach',
  wykonaj(db: DatabaseSync) {
    const sa = new Set(
      db
        .prepare('PRAGMA table_info(producenci)')
        .all()
        .map((k) => (k as { name: string }).name),
    );
    for (const kolumna of KOLUMNY) {
      if (!sa.has(kolumna)) db.exec(`ALTER TABLE producenci ADD COLUMN ${kolumna} TEXT`);
    }
  },
};
