import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { schematBazy } from '../../../core/baza.ts';
import type { Migracja } from '../../../core/kontrakty.ts';

export { KLUCZE_UPRAWNIEN_W_DNIU_ZAMROZENIA } from './klucze-zamrozenia.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const BASELINE_SQL = readFileSync(new URL('./0001-baseline.sql', import.meta.url), 'utf8');

export const migracjaBaseline: Migracja = {
  numer: 1,
  nazwa: 'baseline: schemat OMS-u w punkcie zamrożenia',
  wykonaj(db) {
    const { n } = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name <> 'migracje'`).get() as { n: number };
    if (n === 0) { db.exec(BASELINE_SQL); return; }
    // Baza starego OMS-u: niczego nie tworzymy. Sprawdzamy, że to DOKŁADNIE schemat z baseline.
    const wzorzec = new DatabaseSync(':memory:');
    let oczekiwany: Set<string>;
    try {
      wzorzec.exec(BASELINE_SQL);
      oczekiwany = new Set(schematBazy(wzorzec));
    } finally { wzorzec.close(); }
    const faktyczny = new Set(schematBazy(db));
    const brakuje = [...oczekiwany].filter((x) => !faktyczny.has(x));
    const nadmiar = [...faktyczny].filter((x) => !oczekiwany.has(x));
    if (brakuje.length || nadmiar.length) {
      throw new Error(`Istniejąca baza ma inny schemat niż baseline.\nBrakuje: ${brakuje.join('; ') || '—'}\nNadmiar: ${nadmiar.join('; ') || '—'}`);
    }
  },
};
