import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { polaczenia } from '../../../src/oms/db/reklamy.js';
import { provisionReklam } from '../../../scripts/oms-reklamy-provision.mjs';

describe('powiązanie istniejących kont z reklamami', () => {
  it('tworzy neutralne połączenia i pozwala powtórzyć przebieg bez duplikatów', () => {
    const db = openOmsDb(':memory:');
    const env = { GA4_KLUCZ: '/data-oms/ga4.json', META_TOKEN: 'niewypisuj', META_KONTA: 'act_1,act_2' };
    const args = ['--ga4=123:pro', '--meta=act_1', '--meta=act_2'];
    expect(provisionReklam(db, args, env).map((w) => w.stan)).toEqual(['dodano', 'dodano', 'dodano']);
    expect(provisionReklam(db, args, env).map((w) => w.stan)).toEqual(['istnieje', 'istnieje', 'istnieje']);
    expect(polaczenia(db)).toHaveLength(3);
    expect(JSON.stringify(polaczenia(db))).not.toContain('niewypisuj');
    db.close();
  });

  it('nie dopisuje konta Meta spoza konfiguracji', () => {
    const db = openOmsDb(':memory:');
    expect(() => provisionReklam(db, ['--meta=act_inne'], { META_TOKEN: 'x', META_KONTA: 'act_1' }))
      .toThrow('listy kont');
    expect(polaczenia(db)).toHaveLength(0);
    db.close();
  });
});
