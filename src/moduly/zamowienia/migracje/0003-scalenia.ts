import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-101.04 — scalanie zamówień (decyzje właściciela 18.10.2026; reguły: domena/scalanie.js).
//
// ⚠️ DWIE KOLUMNY, OBIE NASZE (poller ich nie zna — UPDATE w `zapiszZamowienie` wymienia kolumny
// z nazwy, więc synchronizacja ich nie ruszy):
//   `scalone_do`    — na zamówieniu DOŁĄCZONYM: id zamówienia głównego. Znika z listy i liczników.
//   `scalenie_json` — na zamówieniu GŁÓWNYM: {"wysylka":"glowne"|"suma","dolaczone":[id…],"at","kto"}.
// Indeks częściowy: scalonych jest garstka, a pytanie „kto jest dołączony do X” ma być tanie.
export const migracjaScalen: Migracja = {
  numer: 3,
  nazwa: 'scalanie zamówień: scalone_do i scalenie_json',
  wykonaj(db) {
    db.exec(`
      ALTER TABLE zamowienia ADD COLUMN scalone_do INTEGER;
      ALTER TABLE zamowienia ADD COLUMN scalenie_json TEXT;
      CREATE INDEX zamowienia_scalone_do ON zamowienia (scalone_do) WHERE scalone_do IS NOT NULL;
    `);
  },
};
