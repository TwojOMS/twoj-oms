import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nowyPanel, BASIC, get } from '../../pomoc/konta-prz068.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { mapujZamowienieErli } from '../../../src/domena/erli-mapowanie.js';
import { createFabrykaErli } from '../../../src/moduly/kanaly/services/kanal-erli.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { createAtrapaErli } from '../../../deploy/proba/atrapy/erli.mjs';

let p, http, surowe;
beforeEach(async () => {
  p = nowyPanel();
  p.db.prepare(`INSERT INTO kanaly_sprzedazy
    (klucz,typ,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login)
    VALUES ('rynek_testowy','erli','Rynek testowy','produkcja','panel','TEST','polaczone','wlaczone','2026-11-01',1,1,1,'2026-11-11','2026-11-11',0,'test')`).run();
  zapiszKonfiguracjeIntegracji(p.db, 'erli:rynek_testowy', {
    ustawienia: { adresApi: 'https://sklep.polcien.example' }, sekrety: { kluczApi: 'atrapa' },
  });
  const atrapa = createAtrapaErli({ db: p.db, kanal: 'rynek_testowy', env: { OMS_TRYB: 'proba' },
    teraz: () => new Date('2026-11-11T12:00:00Z') });
  http = vi.fn(atrapa.fetchImpl);
  const uslugi = createFabrykaErli({ db: p.db })({ polaczenie: { klucz: 'rynek_testowy', odUtc: null }, http, sprawdzZapis() {} });
  const dane = await uslugi.klient.szukajZamowien({ pagination: { limit: 200 } });
  surowe = dane.find(z => z.delivery.typeId === 'dpd');
  await uslugi.poller.przebieg();
  http.mockClear();
});
afterEach(async () => { await p.app.close(); p.db.close(); });

async function dostawa(delivery, { kanal = 'rynek_testowy', reczna = null } = {}) {
  const sur = { ...surowe, id: 'test-plakietki', delivery: { price: 1000, cod: false, ...delivery } };
  const id = zapiszZamowienie(p.db, kanal, mapujZamowienieErli(sur), sur);
  if (reczna) p.db.prepare('UPDATE zamowienia SET wysylka_reczna_json=? WHERE id=?').run(JSON.stringify(reczna), id);
  const r = await get(p.app, '/?wszystkie=1', BASIC);
  expect(r.statusCode).toBe(200);
  expect(http).not.toHaveBeenCalled();
  const wiersz = r.body.split('<tr').find(w => w.startsWith(` id="zamowienie-${id}"`));
  expect(wiersz, `brak wiersza ${id}`).toBeDefined();
  return wiersz.slice(wiersz.indexOf('<td class="komorka-dostawa">'), wiersz.indexOf('<td class="komorka-kwota">'));
}

it.each([
  [{ typeId: 'dpd', name: 'Kurier DPD — umowa firmy' }, 'dpd', 'Kurier DPD'],
  [{ typeId: 'dpd', name: 'Przesyłka kurierska' }, 'dpd', 'Kurier DPD'],
  [{ typeId: 'paczkomat', name: 'Automat paczkowy 24/7', pickupPlace: { externalId: 'PC001' } }, 'inpost', 'InPost Paczkomat'],
  [{ typeId: 'paczkomat', name: 'Paczkomat InPost — umowa firmy', pickupPlace: { externalId: 'PC001' } }, 'inpost', 'InPost Paczkomat'],
  [{ typeId: 'paczkomat', name: 'Kurier InPost — umowa firmy' }, 'inpost', 'Kurier InPost — umowa firmy'],
  [{ typeId: 'erliPaczkomat', name: 'Paczkomat ERLI' }, 'erli', 'Erli Paczkomat InPost'],
  [{ typeId: 'erliKurier24InPost10kg', name: 'Kurier ERLI' }, 'erli', 'Erli Kurier InPost'],
])('dostawa %j ma plakietkę %s z nazwą według drogi nadania', async (delivery, klucz, nazwa) => {
  const html = await dostawa(delivery);
  expect(html).toMatch(new RegExp(`plakietka plakietka--${klucz}"[\\s\\S]*?<span class="nazwa-dostawy" title="${nazwa}">${nazwa}</span>\\s*</span>`));
  expect(html).not.toContain('kurier z umowy:');
  expect(html).not.toContain('<small>Przesyłka Erli</small>');
  expect(html).not.toContain('nieznana metoda');
});

it('blokada zostaje pod plakietką i zawiera komunikat', async () => {
  p.db.prepare("UPDATE kanaly_sprzedazy SET pobieranie='wylaczone' WHERE klucz='rynek_testowy'").run();
  const html = await dostawa({ typeId: 'dpd', name: 'Kurier DPD — umowa firmy' });
  expect(html).toContain('plakietka--dpd');
  expect(html).toContain('Nadanie zablokowane</span>');
  expect(html).toContain('<small>Kanał ERLI wyłączony — włącz pobieranie</small>');
  expect(html.indexOf('Nadanie zablokowane')).toBeGreaterThan(html.indexOf('plakietka--dpd'));
});

it('nieznana metoda wygląda jak poza ERLI, a blokada pozostaje widoczna', async () => {
  const delivery = { typeId: 'nieznanaMetoda', name: 'Dostawa nieznana' };
  const erli = await dostawa(delivery);
  const inny = await dostawa(delivery, { kanal: 'testowy_sklep' });
  const uwaga = '<span class="uwaga">nieznana metoda — nadaj ręcznie u przewoźnika</span>';
  expect(erli).toContain(uwaga);
  expect(inny).toContain(uwaga);
  expect(erli).toContain('Nadanie zablokowane');
  expect(erli).toContain('ERLI: nie wiem, jak nadać metodę');
  expect(erli).not.toContain('plakietka');
});

it('odbiór osobisty ma jedną nazwę i nie ma plakietki ani dopisku', async () => {
  const html = await dostawa({ typeId: 'odbiorOsobisty', name: 'Odbiór osobisty' });
  expect(html).toContain('>Odbiór osobisty</span>');
  expect(html).not.toContain('plakietka');
  expect(html).not.toContain('<small>');
});

it('ręczna zmiana paczkomatu ERLI na DPD korzysta z aktualnej metody', async () => {
  const html = await dostawa({ typeId: 'erliPaczkomat', name: 'Paczkomat ERLI' }, {
    reczna: { metoda: 'dpd', pobranie: false },
  });
  expect(html).toContain('plakietka--dpd');
  expect(html).not.toContain('plakietka--erli');
  expect(html).toContain('>Kurier DPD</span>');
});
