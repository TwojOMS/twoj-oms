import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const kolumny = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((k) => k.name);

describe('tabele raportow', () => {
  it('sprzedaz_historyczna ma klucz na apilo_id i dzien handlowy', () => {
    expect(kolumny('sprzedaz_historyczna')).toEqual(expect.arrayContaining([
      'apilo_id', 'platform_account_id', 'dzien', 'brutto', 'tagi_json', 'klient_email',
    ]));
  });

  it('powtorzony zapis tego samego zamowienia nie dubluje wiersza', () => {
    const wstaw = () => db.prepare(
      'INSERT INTO sprzedaz_historyczna (apilo_id, dzien, utworzone_at, brutto, pobrane_at)'
      + " VALUES ('WO1','2026-01-05','2026-01-05T10:00:00.000Z','100.00','x')"
      + ' ON CONFLICT(apilo_id) DO UPDATE SET brutto = excluded.brutto',
    ).run();
    wstaw(); wstaw();
    expect(db.prepare('SELECT COUNT(*) c FROM sprzedaz_historyczna').get().c).toBe(1);
  });

  it('granice_historii trzyma jeden wiersz na kanal', () => {
    expect(kolumny('granice_historii')).toEqual(
      expect.arrayContaining(['kanal', 'do_dnia', 'zrodlo', 'uwaga']),
    );
  });

  it('dane_miesieczne rozbijaja ZUS na skladniki, bo maja znaczenie podatkowe', () => {
    expect(kolumny('dane_miesieczne')).toEqual(expect.arrayContaining([
      'miesiac', 'zus_spoleczne', 'zus_zdrowotna', 'zus_fundusz_pracy', 'zus_razem',
      'pit5_zaplacony', 'vat7_zaplacony', 'kpir_przychod', 'kpir_koszty', 'zwroty_brutto',
    ]));
  });
});
