import { expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zalozKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { etagKarty } from '../../../src/moduly/api/trasy/produkty-odczyt.js';

it('PATCH oznacza zmienioną treść jako api i nie oznacza pola o tej samej wartości', async () => {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({ db, config: { auth: { user: 'tester', pass: 'x' } } });
  try {
    await app.ready();
    const kontoId = zalozKonto(db, { login: 'tester', imie: 'Tester', haslo: 'h', admin: true, rola: 'administrator' });
    const { klucz } = zalozKluczApi(db, {
      nazwa: 'test źródła',
      zakresy: ['produkty:zapis'],
      kontoId,
      teraz: new Date().toISOString(),
    });
    const id = utworzKarte(db, { nazwa: 'Lampa Pracowni Półcień', cena_gr: 100 });
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/v1/produkty/${id}`,
      headers: {
        authorization: `Bearer ${klucz}`,
        'if-match': etagKarty(db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id)),
      },
      payload: { nazwa: 'Lampa Pracowni Półcień', opis: 'Poprawka API', cena_gr: 200 },
    });
    expect(r.statusCode).toBe(200);
    const karta = db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
    expect(db.prepare('SELECT pole, zrodlo, reczne, zmieniono_at FROM karty_zrodla_pol ORDER BY pole').all()).toEqual(
      ['cena_gr', 'opis'].map((pole) => ({ pole, zrodlo: 'api', reczne: 1, zmieniono_at: karta.zmieniony_at })),
    );
  } finally {
    await app.close();
    db.close();
  }
});
