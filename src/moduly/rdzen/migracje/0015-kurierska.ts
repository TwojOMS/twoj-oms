import type { Migracja } from '../../../core/kontrakty.ts';

const ZNACZNIK = 'prz160p203-kurierska-do-dostawy';

export const migracjaKurierska: Migracja = {
  numer: 15,
  nazwa: 'opłata kurierska jako koszt dostawy klienta',
  wykonaj(db) {
    // Własny znacznik chroni także bezpośrednie powtórzenie wykonaj, poza rejestrem migracji.
    if (db.prepare('SELECT 1 FROM migracje_jednorazowe WHERE nazwa = ?').get(ZNACZNIK)) return;
    db.exec(`UPDATE klienci SET koszt_dostawy_brutto = printf('%.2f', oplata_kurierska_gr / 100.0)
      WHERE oplata_kurierska_gr IS NOT NULL`);
    db.prepare('INSERT INTO migracje_jednorazowe (nazwa, wykonana_at) VALUES (?, ?)')
      .run(ZNACZNIK, new Date().toISOString());
  },
};
