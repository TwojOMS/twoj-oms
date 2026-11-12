import { expect, it, vi } from 'vitest';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { mapujZamowienieErli } from '../../../src/domena/erli-mapowanie.js';
import { createFabrykaErli } from '../../../src/moduly/kanaly/services/kanal-erli.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { createAtrapaErli } from '../../../deploy/proba/atrapy/erli.mjs';

it('karta z atrapy: ustalane bez HTTP, potem drogi i sprawa blokady; typ z rejestru', async () => {
  const p = nowyPanel();
  try {
    zalozKonto(p.db, { login: 'operator', imie: 'Operator', haslo: 'h', rola: 'administrator', admin: true });
    const admin = jako(p.db, 'operator');
    p.db.prepare(`INSERT INTO kanaly_sprzedazy
      (klucz,typ,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login)
      VALUES ('nietypowy','erli','Test','produkcja','panel','TEST','polaczone','wlaczone','2026-11-01',1,1,1,'2026-11-11','2026-11-11',0,'test')`).run();
    zapiszKonfiguracjeIntegracji(p.db, 'erli:nietypowy', { ustawienia: { adresApi: 'https://sklep.polcien.example' }, sekrety: { kluczApi: 'atrapa' } });
    const atrapa = createAtrapaErli({ db: p.db, kanal: 'nietypowy', env: { OMS_TRYB: 'proba' }, teraz: () => new Date('2026-11-11T12:00:00Z') });
    const http = vi.fn(atrapa.fetchImpl);
    const uslugi = createFabrykaErli({ db: p.db })({ polaczenie: { klucz: 'nietypowy', odUtc: null }, http, sprawdzZapis() {} });
    const dane = await uslugi.klient.szukajZamowien({ pagination: { limit: 200 } });
    expect(dane.some(z => z.delivery.typeId === 'paczkomat' && z.delivery.pickupPlace)).toBe(true);
    const surowe = dane.find(z => z.delivery.typeId === 'erliPaczkomat');
    const id = zapiszZamowienie(p.db, 'nietypowy', mapujZamowienieErli(surowe), surowe);
    http.mockClear();
    let karta = await get(p.app, `/zamowienia/${id}`, admin);
    expect(karta.statusCode).toBe(200);
    expect(karta.body).toContain('Nadanie: ustalane…');
    expect(http).not.toHaveBeenCalled();
    await uslugi.poller.przebieg();
    http.mockClear();
    karta = await get(p.app, `/zamowienia/${id}`, admin);
    expect(karta.body).toContain('Nadanie: Przesyłki Erli — Paczkomat ERLI');
    expect(karta.body).not.toContain('Nieznana metoda');
    expect(karta.body).not.toContain('<p>Nadanie:');
    expect(http).not.toHaveBeenCalled();
    const zamowienia = p.db.prepare('SELECT id, surowe_json FROM zamowienia WHERE sklep=?').all('nietypowy');
    expect(zamowienia).toHaveLength(15);
    for (const [typeId, napis] of [['dpd', 'Nadanie: Twoja umowa — DPD'], ['paczkomat', 'Nadanie: Twoja umowa — Paczkomat InPost'], ['nieznanaMetoda', 'ERLI: nie wiem, jak nadać metodę Dostawa nieznana (nieznanaMetoda)']]) {
      const z = zamowienia.find(z => JSON.parse(z.surowe_json).delivery.typeId === typeId);
      const r = await get(p.app, `/zamowienia/${z.id}`, admin);
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain(napis);
      if (typeId === 'nieznanaMetoda') expect(r.body).toMatch(/class="sprawy"[\s\S]*ERLI: nie wiem/);
    }
    p.db.prepare("UPDATE kanaly_sprzedazy SET typ='woo' WHERE klucz='nietypowy'").run();
    expect((await get(p.app, `/zamowienia/${id}`, admin)).body).not.toContain('Nadanie:');
    p.db.prepare("UPDATE kanaly_sprzedazy SET typ='erli', pobieranie='wylaczone' WHERE klucz='nietypowy'").run();
    expect((await get(p.app, `/zamowienia/${id}`, admin)).body).toContain('Kanał ERLI wyłączony — włącz pobieranie');
  } finally { await p.app.close(); p.db.close(); }
});
