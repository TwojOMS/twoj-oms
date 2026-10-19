import { it, expect } from 'vitest';
import { nowyPanel, BASIC, post, get } from '../../pomoc/konta-prz068.js';
import { zapiszZamowienie, pobierzZamowienie, zapiszFaktyStatusu, zamowieniaPoId } from '../../../src/oms/db/zamowienia.js';
import { wyliczStatus } from '../../../src/domena/status.js';
import { indeksListy } from '../../../src/oms/db/indeks-listy.js';
import { etykietyStatusow } from '../../../src/oms/db/statusy.js';

it.each(['wyslane_at', 'anulowane', 'zwrot_at'])('usuwanie liczy tylko widoczne etapy i sprząta przypisania przysłonięte przez %s', async fakt => {
  const { db, app } = nowyPanel();
  try {
    await app.ready();
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'dodaj', etykieta: 'Do pakowania', kolor: 'fioletowy', jak: 'w_realizacji' });
    const ids = [1, 2].map(n => zapiszZamowienie(db, 'reczne', {
      zrodlo_id: n, numer: `LAMPA-${n}`, kwota_brutto: '10.00', status_woo: 'processing',
      klient: {}, dostawa: {}, metoda_wysylki: 'dpd', oplacone_at: null, nip: null,
      kwota_pobrania: null, chce_fakture: 0, anulowane: 0,
      utworzone_at: '2026-10-18T12:00:00Z', pozycje: [],
    }, {}));
    for (const id of ids) await post(app, `/zamowienia/${id}/status`, BASIC, { status: 'w_do_pakowania' });
    const zakoncz = id => db.prepare(`UPDATE zamowienia SET ${fakt} = ? WHERE id = ?`).run(fakt === 'anulowane' ? 1 : '2026-10-18T13:00:00Z', id);
    zakoncz(ids[0]);
    const odmowa = await post(app, '/ustawienia/statusy', BASIC, { akcja: 'usun', klucz: 'w_do_pakowania' });
    expect(decodeURIComponent(odmowa.headers.location)).toContain('Przenieś 1 zamówienie');
    expect(db.prepare('SELECT * FROM zamowienia_status_wlasny').all()).toHaveLength(2);
    zakoncz(ids[1]);
    const indeks = indeksListy(db);
    const teraz = Date.now();
    await indeks.odswiez(teraz);
    const przed = db.prepare('SELECT * FROM lista_stan ORDER BY zamowienie_id').all();
    db.exec("CREATE TEMP TRIGGER test_odmowa_definicji BEFORE UPDATE ON ustawienia WHEN OLD.klucz = 'statusy.konfiguracja' BEGIN SELECT RAISE(ABORT, 'test'); END");
    const blad = await post(app, '/ustawienia/statusy', BASIC, { akcja: 'usun', klucz: 'w_do_pakowania' });
    expect(blad.statusCode).toBe(500);
    expect(etykietyStatusow(db).w_do_pakowania).toBe('Do pakowania');
    expect(db.prepare('SELECT * FROM zamowienia_status_wlasny').all()).toHaveLength(2);
    db.exec('DROP TRIGGER test_odmowa_definicji');
    const usuniecie = await post(app, '/ustawienia/statusy', BASIC, { akcja: 'usun', klucz: 'w_do_pakowania' });
    expect(usuniecie.headers.location).not.toContain('blad=1');
    expect(etykietyStatusow(db).w_do_pakowania).toBeUndefined();
    expect(db.prepare('SELECT * FROM zamowienia_status_wlasny').all()).toHaveLength(0);
    await indeks.odswiez(teraz);
    expect(db.prepare('SELECT * FROM lista_stan ORDER BY zamowienie_id').all()).toEqual(przed);
  } finally { await app.close(); db.close(); }
});

it('własny etap na karcie i hurtem, indeks, liczniki, filtr, odmowa usunięcia oraz czyszczenie', async () => {
  const { db, app } = nowyPanel();
  try {
    await app.ready();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='zamowienia_status_wlasny'").get()).toBeTruthy();
    const dodaj = await post(app, '/ustawienia/statusy', BASIC, { akcja: 'dodaj', etykieta: 'Do pakowania', kolor: 'fioletowy', jak: 'w_realizacji' });
    expect(dodaj.statusCode).toBe(303);
    const utworz = n => zapiszZamowienie(db, 'reczne', {
      zrodlo_id: n, numer: `LAMPA-${n}`, kwota_brutto: '10.00', status_woo: 'processing',
      klient: {}, dostawa: {}, metoda_wysylki: 'dpd', oplacone_at: null, nip: null,
      kwota_pobrania: null, chce_fakture: 0, anulowane: 0,
      utworzone_at: '2026-10-18T12:00:00Z', pozycje: [],
    }, {});
    const a = utworz(1), b = utworz(2);
    const zmiana = await post(app, `/zamowienia/${a}/status`, BASIC, { status: 'w_do_pakowania' });
    expect(zmiana.statusCode, zmiana.body).toBe(302);
    expect(wyliczStatus(pobierzZamowienie(db, a))).toBe('w_do_pakowania');
    const przygotuj = db.prepare;
    let zapytania = 0;
    db.prepare = function(sql) { zapytania++; return przygotuj.call(this, sql); };
    try {
      const wiersze = zamowieniaPoId(db, [a, b]);
      expect(wiersze).toHaveLength(2);
      expect(wyliczStatus(wiersze.find(z => z.id === a))).toBe('w_do_pakowania');
    } finally { db.prepare = przygotuj; }
    expect(zapytania).toBe(6); // konfiguracja i własny etap nie dodają N+1
    expect(db.prepare('SELECT kto FROM zamowienia_status_wlasny WHERE zamowienie_id = ?').get(a).kto).toBeTruthy();
    const lista = await get(app, '/?status=w_do_pakowania', BASIC);
    expect(lista.statusCode, lista.body).toBe(200);
    expect(lista.body).toContain('LAMPA-1');
    expect(lista.body).not.toContain('LAMPA-2');
    expect(lista.body).toMatch(/znacznik znacznik--zwrot[^>]*>Do pakowania/);
    const i = indeksListy(db);
    expect(i.liczniki(Date.now()).statusy.w_do_pakowania).toBe(1);
    expect(i.liczniki(Date.now()).do_zrobienia).toBe(2);
    const odmowa = await post(app, '/ustawienia/statusy', BASIC, { akcja: 'usun', klucz: 'w_do_pakowania' });
    expect((await get(app, odmowa.headers.location, BASIC)).body).toContain('Przenieś 1 zamówienie');
    expect(etykietyStatusow(db).w_do_pakowania).toBe('Do pakowania');
    const hurt = await post(app, '/zamowienia/masowe/status', BASIC, { id: [String(a), String(b)], status: 'w_do_pakowania' });
    expect(hurt.statusCode, JSON.stringify(db.prepare("SELECT wynik FROM log WHERE akcja='status.masowy'").all())).toBe(302);
    await i.odswiez();
    expect(i.liczniki(Date.now()).statusy.w_do_pakowania).toBe(2);
    // Zmiany samej tabeli etapów także unieważniają indeks (np. narzędzie administracyjne).
    db.prepare('DELETE FROM zamowienia_status_wlasny WHERE zamowienie_id = ?').run(b);
    await i.odswiez();
    expect(i.liczniki(Date.now()).statusy.w_do_pakowania).toBe(1);
    await post(app, `/zamowienia/${a}/status`, BASIC, { status: 'nowe' });
    expect(pobierzZamowienie(db, a).status_wlasny).toBe(null);
    expect(db.prepare('SELECT * FROM zamowienia_status_wlasny WHERE zamowienie_id = ?').get(a)).toBeUndefined();
    // Błąd zapisu etapu wycofuje także UPDATE faktów.
    db.exec("CREATE TEMP TRIGGER test_odmowa BEFORE INSERT ON zamowienia_status_wlasny BEGIN SELECT RAISE(ABORT, 'test'); END");
    expect(() => zapiszFaktyStatusu(db, a, { w_realizacji_at: 'nie-zapisuj', status_wlasny: 'w_do_pakowania' })).toThrow();
    expect(pobierzZamowienie(db, a).w_realizacji_at).toBe(null);
  } finally { await app.close(); db.close(); }
});
