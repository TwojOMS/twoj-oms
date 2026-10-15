import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import {
  zapiszDaneMiesiaca, daneMiesiaca, daneOkresu, rozjazdZus, wgrajDaneStartowe,
  miesiaceZDanymi,
} from '../../pomoc/dane-miesieczne-parytetu.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('dane miesieczne', () => {
  it('zapisuje i czyta miesiac', () => {
    zapiszDaneMiesiaca(db, '2026-06', {
      zusSpoleczne: '1788.29', zusZdrowotna: '894.30', zusFunduszPracy: '138.47',
      zusRazem: '2821.06', pit5: '779.00', vat7: '1617.00',
    });
    expect(daneMiesiaca(db, '2026-06')).toMatchObject({ zus_razem: '2821.06', pit5_zaplacony: '779.00' });
  });

  it('BRAKUJACY MIESIAC JEST WYMIENIONY Z NAZWY, a nie liczony jako zero', () => {
    zapiszDaneMiesiaca(db, '2026-05', { zusRazem: '2369.59' });
    // ⚠️ '2026-07', NIE '2026-06': `openOmsDb` (patrz beforeEach) wywoluje `wgrajDaneStartowe`
    // przy KAZDYM otwarciu, wiec styczen–czerwiec 2026 maja wiersz z migracji od razu i zaden
    // z nich nie jest juz „brakujacy" — '2026-06' jako sondowany miesiac dawal falszywy
    // negatyw (kolizja z brief Krok 4). Lipiec 2026 lezy poza zasiegiem migracji.
    const wynik = daneOkresu(db, ['2026-05', '2026-07']);
    expect(wynik.brakujace).toEqual(['2026-07']);
  });

  it('suma okresu idzie po groszach, nie po napisach', () => {
    zapiszDaneMiesiaca(db, '2026-05', { zusRazem: '2369.59', pit5: '287.00' });
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', pit5: '779.00' });
    const { suma } = daneOkresu(db, ['2026-05', '2026-06']);
    expect(suma.zusRazemGrosze).toBe(519065);
    expect(suma.pit5Grosze).toBe(106600);
  });

  it('ROZJAZD SKLADNIKOW I PRZELEWU jest widoczny, a nie wygladzony', () => {
    zapiszDaneMiesiaca(db, '2026-01', {
      zusSpoleczne: '1432.08', zusZdrowotna: '314.96', zusFunduszPracy: '127.49',
      zusRazem: '2088.92',
    });
    // 1432,08 + 314,96 + 127,49 = 1874,53; przelew 2088,92 → rozjazd 214,39.
    expect(rozjazdZus(daneMiesiaca(db, '2026-01'))).toBe(21439);
  });

  it('bez kompletu skladnikow rozjazdu NIE ZGADUJEMY', () => {
    zapiszDaneMiesiaca(db, '2026-02', { zusRazem: '2257.61' });
    expect(rozjazdZus(daneMiesiaca(db, '2026-02'))).toBeNull();
  });

  it('migracja startowa wgrywa szesc miesiecy I NIE POWTARZA SIE przy drugim starcie', () => {
    wgrajDaneStartowe(db);
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '9999.99' });
    wgrajDaneStartowe(db);
    expect(daneMiesiaca(db, '2026-01').zus_razem).toBe('2088.92');
    // ⚠️ Migracja nie ma prawa cofnac decyzji czlowieka przy najblizszym wdrozeniu.
    expect(daneMiesiaca(db, '2026-06').zus_razem).toBe('9999.99');
  });
});

describe('kwoty wpisane po polsku', () => {
  it('PRZECINEK zamienia sie na kropke — wlasciciel przepisuje skladki z PUE ZUS', () => {
    // ⚠️ Bez tego napis '1874,53' wchodzil do bazy znak w znak, a `grosze()` na nim RZUCA:
    // kazde kolejne wejscie na ekran i kazdy rachunek odbijalby sie od wpisu, ktory
    // z ekranu wyglada zupelnie poprawnie.
    zapiszDaneMiesiaca(db, '2026-09', { zusSpoleczne: '1874,53', zusRazem: '2 088,92' });
    const w = daneMiesiaca(db, '2026-09');
    expect(w.zus_spoleczne).toBe('1874.53');
    expect(w.zus_razem).toBe('2088.92');
  });

  it('pole UWAGI zostaje nietkniete — to nie jest kwota', () => {
    zapiszDaneMiesiaca(db, '2026-09', { uwagi: 'rozjazd 214,39 do sprawdzenia' });
    expect(daneMiesiaca(db, '2026-09').uwagi).toBe('rozjazd 214,39 do sprawdzenia');
  });
});

describe('ktore miesiace roku maja juz wpis (pasek miesiecy)', () => {
  it('oddaje TYLKO miesiace z wierszem, i tylko z pytanego roku', () => {
    // ⚠️ Rok 2027, a nie 2026: baza testowa przechodzi te same migracje, co produkcyjna,
    // a migracja startowa wgrywa styczen–czerwiec 2026 (`wgrajDaneStartowe`).
    zapiszDaneMiesiaca(db, '2027-02', { zusRazem: '2088.92' });
    zapiszDaneMiesiaca(db, '2027-05', { zusRazem: '2359.30' });
    zapiszDaneMiesiaca(db, '2028-01', { zusRazem: '1900.00' });
    expect([...miesiaceZDanymi(db, '2027')].sort()).toEqual(['2027-02', '2027-05']);
    // Rok obok nie przecieka — `LIKE '2027-%'` nie ma prawa zlapac 2028-01.
    expect([...miesiaceZDanymi(db, '2028')]).toEqual(['2028-01']);
  });

  it('rok bez ani jednego wpisu oddaje pusty zbior, nie rzuca', () => {
    expect(miesiaceZDanymi(db, '2019').size).toBe(0);
  });

  it('⚠️ WIERSZ SAMYCH PUSTYCH POL TEZ SIE LICZY — pasek mowi „wpisano", nie „ile wpisano"', () => {
    // Miesiac, w ktorym wlasciciel zapisal formularz bez kwot, MA wiersz — a rachunek
    // zarzadczy nie zglasza go wtedy jako brakujacy (daneOkresu.brakujace patrzy na wiersz,
    // nie na kwoty). Pasek musi mowic to samo, co rachunek, inaczej ekran wysyla operatora
    // do miesiaca, ktorego rachunek juz nie szuka.
    zapiszDaneMiesiaca(db, '2026-07', {});
    expect(miesiaceZDanymi(db, '2026').has('2026-07')).toBe(true);
    expect(daneOkresu(db, ['2026-07']).brakujace).toEqual([]);
  });
});
