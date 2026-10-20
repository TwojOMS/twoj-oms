import { it, expect } from 'vitest';
import { nowyPanel, BASIC, get, post } from '../../pomoc/konta-prz068.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { koloryStatusow } from '../../../src/oms/db/statusy.js';
import { domyslneStatusy } from '../../../src/domena/statusy-konfiguracja.js';
import { modyfikatorStatusu } from '../../../src/core/web/klasa-statusu.js';

it('render listy odczytuje konfigurację statusów najwyżej raz i kolejne żądanie widzi zmianę', async () => {
  const { db, app } = nowyPanel();
  const przygotuj = db.prepare;
  try {
    await app.ready();
    for (let n = 1; n <= 25; n++) zapiszZamowienie(db, 'reczne', {
      zrodlo_id: n, numer: `LAMPA-${n}`, kwota_brutto: '10.00', status_woo: 'processing',
      klient: {}, dostawa: {}, metoda_wysylki: 'dpd', oplacone_at: null, nip: null,
      kwota_pobrania: null, chce_fakture: 0, anulowane: 0,
      utworzone_at: '2026-10-18T12:00:00Z', pozycje: [],
    }, {});
    let odczyty = 0;
    // PRZ-102.02: ta sama tabela zawiera też przełączniki modułów. Mierzymy tylko statusy.
    const liczOdczytyStatusow = function(sql) {
      const zapytanie = przygotuj.call(this, sql);
      if (/^SELECT wartosc FROM ustawienia WHERE klucz = \?$/.test(sql)) {
        const get = zapytanie.get;
        zapytanie.get = function(...parametry) {
          if (parametry[0] === 'statusy.konfiguracja') odczyty++;
          return get.apply(this, parametry);
        };
      }
      return zapytanie;
    };
    db.prepare = liczOdczytyStatusow;
    const lista = await get(app, '/', BASIC);
    expect(lista.statusCode).toBe(200);
    expect(lista.body).toContain('LAMPA-25');
    expect(odczyty).toBeLessThanOrEqual(1);
    db.prepare = przygotuj;
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'edytuj', klucz: 'nowe', etykieta: 'Oczekujące lampy', kolor: 'czerwony' });
    odczyty = 0;
    db.prepare = liczOdczytyStatusow;
    const po = await get(app, '/', BASIC);
    expect(po.body).toContain('Oczekujące lampy');
    expect(po.body).toMatch(/znacznik znacznik--czerwony/);
    expect(odczyty).toBeLessThanOrEqual(1);
  } finally { db.prepare = przygotuj; await app.close(); db.close(); }
});

it.each([false, true])('przywrócenie domyślnych odtwarza dawne klasy systemowe (własny: %s)', async wlasny => {
  const { db, app } = nowyPanel();
  try {
    await app.ready();
    const dawne = domyslneStatusy().map(s => modyfikatorStatusu(s.klucz));
    if (wlasny) await post(app, '/ustawienia/statusy', BASIC, { akcja: 'dodaj', etykieta: 'Druk', kolor: 'fioletowy', jak: 'w_realizacji' });
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'edytuj', klucz: 'anulowane', etykieta: 'Anulowane lampy', kolor: 'czerwony' });
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'domyslne' });
    expect(domyslneStatusy().map(s => modyfikatorStatusu(s.klucz, koloryStatusow(db)))).toEqual(dawne);
    const lista = await get(app, '/', BASIC);
    expect(lista.body).toMatch(/kropka znacznik--anulowane/);
    if (wlasny) expect(modyfikatorStatusu('w_druk', koloryStatusow(db))).toBe('znacznik--zwrot');
  } finally { await app.close(); db.close(); }
});
