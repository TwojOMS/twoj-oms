import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zbudujOms } from '../pomoc/zbuduj-oms.ts';
import type { ModulOms } from '../../src/core/kontrakty.ts';

describe('baza i pomocnik modułów', () => {
  it('otwiera baseline bez zasiewu danych firmy i pozwala dołączyć zapytania', () => {
    const db = openOmsDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM zamowienia').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM kampanie').get()).toEqual({ n: 0 });
    db.close();
  });
  it('składa rzeczywisty moduł i jawne nadpisanie bez produkcyjnych atrap', async () => {
    const modul: ModulOms = { nazwa: 'sonda', wersja: '1.0.0', wymaga: [], migracje: [], uprawnienia: [], menu: [],
      konfiguracja: () => ({}), zbuduj: (ctx) => ({ uslugi: { liczba: 1 }, trasy: (app) => {
        app.get('/sonda', () => ({ liczba: ctx.usluga('sonda', 'liczba') }));
      } }) };
    const oms = await zbudujOms({ moduly: [modul], env: {}, db: openOmsDb(), nadpisania: { 'sonda.liczba': 7 } });
    expect((await oms.app.inject('/sonda')).json()).toEqual({ liczba: 7 });
    await oms.app.close(); oms.db.close();
  });
});
