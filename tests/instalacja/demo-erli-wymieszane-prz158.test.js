import { afterEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { modulyPiaskownicy, nadpisaniaPiaskownicy } from '../../deploy/proba/atrapy/index.mjs';
import { createAtrapaInfaktu } from '../../deploy/proba/atrapy/infakt.mjs';
import { ENV_DEMO, wygenerujDaneDemo } from '../../scripts/demo-dane.mjs';
import { FIRMY_B2B } from '../../scripts/demo-dane-firma.mjs';
import { uzupelnijDemoErli } from '../../scripts/demo-dane-erli.mjs';
import { MODULY_KANALOW, ustawRejestrKanalow } from '../../src/domena/moduly-kanalow.ts';

let db, aplikacja;
afterEach(async () => {
  await aplikacja?.app.close();
  db?.close();
  ustawRejestrKanalow(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('demo po imporcie ERLI miesza kanały, koszyki, dostawy i FV, zachowując przypadki brzegowe', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  const siec = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Test: sieć zabroniona'));
  const env = { ...ENV_DEMO };
  const moduly = modulyPiaskownicy(env, { baza: () => db });
  db = openOmsDb(':memory:', { moduly });
  wygenerujDaneDemo(db, { dzis: '2026-11-11', env });
  db.prepare("UPDATE kanaly_sprzedazy SET aktor_login='operator-test' WHERE klucz='erli_polcien'").run();
  // Konto inFaktu mogło być już odczytane przed pierwszym przebiegiem ERLI.
  const infakt = createAtrapaInfaktu({ db, env, log: () => {} });
  await infakt.listaFaktur();
  aplikacja = await zbudujAplikacje({ db, env,
    moduly: moduly.filter(m => ['rdzen', 'kanaly'].includes(m.nazwa)),
    nadpisania: nadpisaniaPiaskownicy({ db, env, log: () => {} }),
    teraz: () => new Date('2026-11-11T12:00:00Z'), log: () => {} });
  ustawRejestrKanalow(k => k === 'erli_polcien' ? 'erli' : null, MODULY_KANALOW);
  const poller = aplikacja.usluga('kanaly', 'rejestrKanalow');
  await poller.przebiegZamowien();
  const najnowsze = db.prepare('SELECT sklep,numer FROM zamowienia ORDER BY utworzone_at DESC,id DESC LIMIT 16').all();
  const miejscaErli = najnowsze.flatMap((z, i) => z.sklep === 'erli_polcien' ? [i] : []);
  expect.soft(new Set(najnowsze.map(z => z.sklep)).size).toBeGreaterThanOrEqual(3);
  expect.soft(miejscaErli.length).toBeGreaterThanOrEqual(2);
  expect.soft(miejscaErli.length).toBeLessThanOrEqual(6);
  expect.soft(miejscaErli.some((p, i) => i > 0 && p > miejscaErli[i - 1] + 1)).toBe(true);
  const erli = db.prepare("SELECT * FROM zamowienia WHERE sklep='erli_polcien' ORDER BY numer").all();
  expect(erli).toHaveLength(15);
  const surowe = erli.map(z => JSON.parse(z.surowe_json));
  const metody = new Set(surowe.map(z => z.delivery.typeId));
  expect.soft(metody.size).toBeGreaterThanOrEqual(4);
  const startowe = db.prepare("SELECT dane_json FROM atrapa_erli_stan WHERE rodzaj='zamowienie' AND kanal='erli_polcien'").all().map(w => JSON.parse(w.dane_json));
  const rozklad = Object.fromEntries([...new Set(startowe.map(z => z.delivery.typeId))].map(m => [m, startowe.filter(z => z.delivery.typeId === m).length]));
  for (const ile of Object.values(rozklad)) expect.soft(ile).toBeLessThanOrEqual(startowe.length / 2);
  for (const z of startowe.filter(z => ['paczkomat', 'erliPaczkomat'].includes(z.delivery.typeId))) {
    expect.soft(z.delivery.pickupPlace?.externalId).toBeTruthy();
  }
  expect.soft(new Set(surowe.map(z => z.sellerStatus)).size).toBeGreaterThanOrEqual(3);
  expect.soft(surowe.some(z => z.sellerStatus === 'sent' && z.deliveryTracking?.trackingNumber)).toBe(true);
  expect.soft(surowe.some(z => z.status === 'cancelled')).toBe(true);
  expect.soft(erli.some(z => z.w_realizacji_at)).toBe(true);
  expect.soft(erli.some(z => z.wyslane_at)).toBe(true);
  for (const z of erli) {
    if (z.w_realizacji_at) expect.soft(Date.parse(z.w_realizacji_at) - Date.parse(z.utworzone_at)).toBeGreaterThanOrEqual(2 * 3600000);
    if (z.wyslane_at) expect.soft(Date.parse(z.wyslane_at) - Date.parse(z.utworzone_at)).toBeGreaterThanOrEqual(2 * 3600000);
  }
  const wyslane = erli.filter(z => JSON.parse(z.surowe_json).sellerStatus === 'sent');
  expect(wyslane.length).toBeGreaterThanOrEqual(1);
  for (const z of wyslane) {
    const dane = JSON.parse(z.surowe_json);
    const paczki = db.prepare('SELECT * FROM przesylki WHERE zamowienie_id=?').all(z.id);
    expect.soft(paczki).toHaveLength(1);
    expect.soft(paczki[0]).toMatchObject({ numer_listu: dane.deliveryTracking.trackingNumber,
      kurier: dane.delivery.typeId === 'dpd' ? 'dpd' : 'inpost', status: 'nadana', zrodlo_numeru: 'demo',
      status_kuriera: 'Przesyłka doręczona do odbiorcy' });
    expect.soft(paczki[0]?.utworzona_at).toBe(z.wyslane_at);
  }
  expect.soft(erli.some(z => z.anulowane)).toBe(true);
  expect.soft(surowe.some(z => z.items.length > 1 && z.items.some(p => p.quantity > 1))).toBe(true);
  expect.soft(new Set(surowe.map(z => z.totalPrice)).size).toBeGreaterThan(3);
  expect.soft(new Set(surowe.map(z => z.created.slice(0, 10))).size).toBeGreaterThanOrEqual(7);
  for (const z of surowe) expect.soft(z.totalPrice).toBe(z.items.reduce((s, p) => s + p.quantity * p.unitPrice, 0) + z.delivery.price);
  const fv = db.prepare("SELECT f.*,z.nip,z.oplacone_at FROM faktury f JOIN zamowienia z ON z.id=f.zamowienie_id WHERE z.sklep='erli_polcien'").all();
  expect.soft(fv.length).toBeGreaterThanOrEqual(2);
  expect.soft(fv.length).toBeLessThan(erli.length);
  const dokumenty = await infakt.listaFaktur();
  const dokumentyErli = dokumenty.filter(d => fv.some(f => f.infakt_uuid === d.uuid));
  expect.soft(dokumentyErli).toHaveLength(fv.length);
  expect.soft(dokumentyErli.some(d => d.status === 'paid')).toBe(true);
  expect.soft(dokumentyErli.some(d => d.status === 'sent')).toBe(true);
  expect.soft(dokumentyErli.some(d => FIRMY_B2B.some(f => f.nip === d.client_tax_code && f.nazwa === d.client_company_name))).toBe(true);
  for (const d of dokumentyErli) {
    const z = erli.find(z => fv.some(f => f.zamowienie_id === z.id && f.infakt_uuid === d.uuid));
    expect(d.gross_price).toBe(Math.round(Number(z.kwota_brutto) * 100));
  }
  const z = n => surowe.find(z => z.id === `PC-ERLI-${String(n).padStart(4, '0')}`);
  const pending = JSON.parse(db.prepare("SELECT dane_json FROM atrapa_erli_stan WHERE rodzaj='zamowienie' AND id='PC-ERLI-0006'").get().dane_json);
  expect(pending.status).toBe('pending');
  expect(z(9).user.email).toBeFalsy();
  expect(z(10)).toMatchObject({ currency: 'EUR', market: 'de' });
  expect(z(5).user.invoiceAddress.nip).toBe(FIRMY_B2B[0].nip);
  expect(z(8).returns).not.toHaveLength(0);
  // 12.11 właściciel: „w demo nie może takiego być” — kanał demo bez nieznanej metody dostawy (blokady nadania).
  expect(z(11).delivery.typeId).toBe('erliKurier24InPost10kg');
  expect(surowe.map(z => z.delivery.typeId)).not.toContain('nieznanaMetoda');
  expect(z(2).delivery.cod).toBe(true);
  await poller.przebiegZamowien();
  await poller.przebiegZamowien();
  expect(db.prepare("SELECT COUNT(*) n FROM faktury f JOIN zamowienia z ON z.id=f.zamowienie_id WHERE z.sklep='erli_polcien'").get().n).toBe(fv.length);
  expect(db.prepare("SELECT anulowane FROM zamowienia WHERE numer='PC-ERLI-0007'").get().anulowane).toBe(1);
  expect(db.prepare("SELECT COUNT(*) n FROM przesylki p JOIN zamowienia z ON z.id=p.zamowienie_id WHERE z.sklep='erli_polcien'").get().n).toBe(wyslane.length);
  // Inny kanał ERLI, nawet założony przez demo, nie dostaje uzupełnień.
  db.prepare("UPDATE kanaly_sprzedazy SET klucz='erli_inny',aktor_login='demo' WHERE klucz='erli_polcien'").run();
  db.prepare("UPDATE zamowienia SET sklep='erli_inny' WHERE sklep='erli_polcien'").run();
  db.prepare("DELETE FROM faktury WHERE zamowienie_id IN (SELECT id FROM zamowienia WHERE sklep='erli_inny')").run();
  db.prepare("DELETE FROM przesylki WHERE zamowienie_id IN (SELECT id FROM zamowienia WHERE sklep='erli_inny')").run();
  await uzupelnijDemoErli({ db, kanal: 'erli_inny', env, teraz: () => new Date(), log: () => {} });
  for (const tabela of ['faktury', 'przesylki']) expect(db.prepare(`SELECT COUNT(*) n FROM ${tabela} p JOIN zamowienia z ON z.id=p.zamowienie_id WHERE z.sklep='erli_inny'`).get().n).toBe(0);
  expect(siec).not.toHaveBeenCalled();
  console.log(JSON.stringify({ kanaly: najnowsze.map(z => z.sklep), erli: miejscaErli.length, rozklad, wyslaneZListem: wyslane.length, faktury: fv.length }));
});
