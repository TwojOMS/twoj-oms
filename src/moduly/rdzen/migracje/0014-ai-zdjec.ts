import type { Migracja } from '../../../core/kontrakty.ts';

// Znacznik pojedynczego zdjęcia; NULL = brak wiedzy. Bez CHECK — `src/core/baza.ts` przyjmuje tylko migracje
// addytywne bez nowych ograniczeń; wartości 0/1 pilnuje `ustawZnacznikAi`. Starej flagi karty nie przenosimy.
// Etap 3 Allegro: POST /sale/images z isAiCoCreated z tej samej kolumny ai.
const KOLUMNY: readonly [string, string][] = [
  ['ai', 'ALTER TABLE zdjecia_kart ADD COLUMN ai INTEGER'],
  ['ai_reczne', 'ALTER TABLE zdjecia_kart ADD COLUMN ai_reczne INTEGER NOT NULL DEFAULT 0'],
  ['wyslane_at', 'ALTER TABLE zdjecia_kart ADD COLUMN wyslane_at TEXT'],
];

export const migracjaAiZdjec: Migracja = {
  numer: 14,
  nazwa: 'znacznik AI pojedynczego zdjecia',
  wykonaj(db) {
    const sa = new Set(db.prepare('PRAGMA table_info(zdjecia_kart)').all().map(k => (k as { name: string }).name));
    for (const [kolumna, sql] of KOLUMNY) if (!sa.has(kolumna)) db.exec(sql);
  },
};
