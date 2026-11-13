import { expect, it } from 'vitest';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { createErliAdapter, stanErliWPamieci } from '../../../src/oms/erli/adapter.js';
import { createPoller } from '../../../src/moduly/kanaly/services/poller.js';
import { createAtrapaErli } from '../../../deploy/proba/atrapy/erli.mjs';
import { fmtDataCzas } from '../../../src/domena/format-daty.js';

it('import dwa razy: zgłoszenie na karcie, bez duplikatu i bez numeru konta w całym wierszu bazy oraz HTML', async () => {
  const p = nowyPanel();
  try {
    zalozKonto(p.db, { login: 'operator', imie: 'Operator', haslo: 'h', rola: 'administrator', admin: true });
    const admin = jako(p.db, 'operator');
    p.db.prepare(`INSERT INTO kanaly_sprzedazy
      (klucz,typ,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login)
      VALUES ('nietypowy','erli','Test','produkcja','panel','TEST','polaczone','wlaczone','2026-11-01',1,1,1,'2026-11-11','2026-11-11',0,'test')`).run();
    const teraz = () => new Date('2026-11-11T12:00:00Z');
    const klient = createAtrapaErli({ db: p.db, kanal: 'nietypowy', env: { OMS_TRYB: 'proba' }, teraz });
    // Surowy transport atrapy omija dodatkową redakcję klienta HTTP: sprawdzamy sam import.
    const dane = await (await klient.fetchImpl('https://sklep.polcien.example/orders/_search',
      { method: 'POST', body: JSON.stringify({ pagination: { limit: 200 } }) })).json();
    const zgloszone = dane.filter(z => z.returns?.length);
    expect(zgloszone).toHaveLength(1);
    const surowe = zgloszone[0];
    const numerKonta = surowe.returns[0].bankAccount.number;
    const kanal = createErliAdapter({ klient: { ...klient,
      zmianyZamowien: async () => dane.map((payload, i) => ({ id: String(i), payload: structuredClone(payload) })),
      szukajZamowien: async () => [],
    }, stan: stanErliWPamieci(), teraz });
    const poller = createPoller({ db: p.db, sklep: 'nietypowy', kanal });
    for (let i = 0; i < 2; i++) {
      await poller.przebieg();
      const wiersze = p.db.prepare('SELECT * FROM zamowienia WHERE sklep=?').all('nietypowy');
      expect(wiersze).toHaveLength(15);
      expect(JSON.stringify(wiersze)).not.toContain(numerKonta);
      expect(JSON.stringify(wiersze)).not.toContain('bankAccount');
      const z = wiersze.find(w => w.zrodlo_id === surowe.id);
      expect(JSON.parse(z.surowe_json).returns).toHaveLength(1);
      const karta = await get(p.app, `/zamowienia/${z.id}`, admin);
      expect(karta.statusCode).toBe(200);
      expect(karta.body).not.toContain(numerKonta);
      expect(karta.body).not.toContain('bankAccount');
      expect(karta.body.match(/Zgłoszenie zwrotu z ERLI/g)).toHaveLength(1);
      const sekcja = karta.body.match(/<p><b>Zgłoszenie zwrotu z ERLI[\s\S]*?<\/p>/)?.[0];
      expect(sekcja).toContain('Kupujący zrezygnował z zakupu');
      expect(sekcja).toContain(surowe.items[0].name);
      expect(sekcja).toContain('1 szt.');
      expect(sekcja).toContain(fmtDataCzas(surowe.returns[0].created));
      expect(sekcja).toContain('Wybieram inny wzór');
      expect(karta.body).toContain(`href="/zamowienia/${z.id}/zwrot"`);
      expect(karta.body).toContain('Przejdź do ZWROTÓW');
      expect(p.db.prepare('SELECT COUNT(*) AS n FROM zwroty').get().n).toBe(0);
      expect(p.db.prepare('SELECT COUNT(*) AS n FROM zwroty_pozycje').get().n).toBe(0);
    }
    const bez = p.db.prepare('SELECT id FROM zamowienia WHERE sklep=? AND zrodlo_id<>? LIMIT 1').get('nietypowy', surowe.id);
    expect((await get(p.app, `/zamowienia/${bez.id}`, admin)).body).not.toContain('Zgłoszenie zwrotu z ERLI');
    const z = p.db.prepare('SELECT id, surowe_json FROM zamowienia WHERE zrodlo_id=?').get(surowe.id);
    const zapis = JSON.parse(z.surowe_json);
    zapis.returns[0].comment = '<script>zwrotXss()</script>';
    zapis.returns[0].reason = '<b>nowyPowod</b>';
    zapis.returns[0].items = [{ index: 99, quantity: 2 }];
    p.db.prepare('UPDATE zamowienia SET surowe_json=? WHERE id=?').run(JSON.stringify(zapis), z.id);
    const karta = await get(p.app, `/zamowienia/${z.id}`, admin);
    expect(karta.body).toContain('&lt;script&gt;zwrotXss()&lt;/script&gt;');
    expect(karta.body).not.toContain('<script>zwrotXss()');
    expect(karta.body).toContain('&lt;b&gt;nowyPowod&lt;/b&gt;');
    expect(karta.body).toContain('pozycja nr 99');
    p.db.prepare("UPDATE kanaly_sprzedazy SET typ='woo' WHERE klucz='nietypowy'").run();
    expect((await get(p.app, `/zamowienia/${z.id}`, admin)).body).not.toContain('Zgłoszenie zwrotu z ERLI');
  } finally { await p.app.close(); p.db.close(); }
});
