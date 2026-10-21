import type { Migracja } from '../../../core/kontrakty.ts';

// PRZ-104 — ręczna data wysyłki („najpóźniej do”, decyzja właściciela 21.10.2026): dzień `RRRR-MM-DD`
// albo NULL = standardowy termin (domena/termin-wysylki.js). Kolumna NASZA — poller jej nie zna
// (UPDATE w `zapiszZamowienie` wymienia kolumny z nazwy), więc synchronizacja ze sklepem jej nie ruszy.
//
// ⚠️ W RDZENIU, a nie w module zamówień: czytają ją reguła terminu, indeks listy i statystyki,
// a zapisuje także zakładanie zamówienia ręcznego (src/oms/db/zamowienia-reczne.js) — na bazie,
// którą testy i skrypty otwierają samym rdzeniem.
// Odporna na ponowne uruchomienie: kolumna już jest → nic.
export const migracjaTerminuWysylkiRecznego: Migracja = {
  numer: 7,
  nazwa: 'ręczna data wysyłki zamówienia',
  wykonaj(db) {
    const jest = db.prepare('PRAGMA table_info(zamowienia)').all()
      .some((k) => (k as { name: string }).name === 'termin_wysylki_reczny');
    if (!jest) db.exec('ALTER TABLE zamowienia ADD COLUMN termin_wysylki_reczny TEXT');
  },
};
