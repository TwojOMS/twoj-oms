import { expect, it } from 'vitest';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { mapujZamowienieErli } from '../../../src/domena/erli-mapowanie.js';
import { createFabrykaErli } from '../../../src/moduly/kanaly/services/kanal-erli.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { createAtrapaErli } from '../../../deploy/proba/atrapy/erli.mjs';

// Odtworzenie recenzji tmp/07br/repro-07br.test.js, rozszerzone o pobranie i brak nieaktualnej drogi.
it('karta ERLI zachowuje ręczne DPD i pobranie, a usuwa nieaktualną linię nadania', async () => {
  const p = nowyPanel();
  try {
    zalozKonto(p.db, { login: 'operator', imie: 'Operator', haslo: 'h', rola: 'administrator', admin: true });
    const admin = jako(p.db, 'operator');
    p.db.prepare(`INSERT INTO kanaly_sprzedazy
      (klucz,typ,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login)
      VALUES ('nietypowy','erli','Test','produkcja','panel','TEST','polaczone','wlaczone','2026-11-01',1,1,1,'2026-11-11','2026-11-11',0,'test')`).run();
    zapiszKonfiguracjeIntegracji(p.db, 'erli:nietypowy', { ustawienia: { adresApi: 'https://sklep.polcien.example' }, sekrety: { kluczApi: 'atrapa' } });
    const atrapa = createAtrapaErli({ db: p.db, kanal: 'nietypowy', env: { OMS_TRYB: 'proba' }, teraz: () => new Date('2026-11-11T12:00:00Z') });
    const uslugi = createFabrykaErli({ db: p.db })({ polaczenie: { klucz: 'nietypowy', odUtc: null }, http: atrapa.fetchImpl, sprawdzZapis() {} });
    const dane = await uslugi.klient.szukajZamowien({ pagination: { limit: 200 } });
    const sur = dane.find(z => z.delivery.typeId === 'erliPaczkomat');
    const id = zapiszZamowienie(p.db, 'nietypowy', mapujZamowienieErli(sur), sur);
    await uslugi.poller.przebieg();

    const karta = () => get(p.app, `/zamowienia/${id}`, admin);
    const metoda = body => body.match(/<span>Metoda wysyłki<\/span>[\s\S]*?<\/div>/)[0];
    p.db.prepare('UPDATE zamowienia SET wysylka_reczna_json=? WHERE id=?').run(JSON.stringify({ metoda: 'dpd', pobranie: true, kwota_pobrania: '10.00' }), id);
    let r = await karta();
    expect(r.statusCode).toBe(200);
    expect(metoda(r.body)).toContain('DPD (pobranie)');
    expect(metoda(r.body)).toContain('plakietka--dpd');
    expect(r.body).not.toContain('<span>Nadanie</span>');
    expect(metoda(r.body)).toContain('zmienione ręcznie');

    // Przywrócona metoda kanału również zachowuje dopisek dla zamówienia za pobraniem.
    p.db.prepare('UPDATE zamowienia SET wysylka_reczna_json=NULL, pobranie=1, kwota_pobrania=? WHERE id=?').run('10.00', id);
    r = await karta();
    expect(metoda(r.body)).toContain('Paczkomat ERLI (pobranie)');
    expect(r.body).toContain('Nadanie: Przesyłki Erli');

    const nieznane = dane.find(z => z.delivery.typeId === 'nieznanaMetoda');
    const idBlokady = zapiszZamowienie(p.db, 'nietypowy', mapujZamowienieErli(nieznane), nieznane);
    p.db.prepare('UPDATE zamowienia SET wysylka_reczna_json=? WHERE id=?').run(JSON.stringify({ metoda: 'dpd', pobranie: false }), idBlokady);
    const recznaBlokada = await get(p.app, `/zamowienia/${idBlokady}`, admin);
    expect(recznaBlokada.statusCode).toBe(200);
    expect(recznaBlokada.body).not.toContain('<span>Nadanie</span>');
  } finally { await p.app.close(); p.db.close(); }
});
