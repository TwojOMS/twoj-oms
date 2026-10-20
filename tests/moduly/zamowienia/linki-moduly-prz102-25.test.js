import { afterEach, expect, it } from 'vitest';
import { nowyPanel, get, post, BASIC } from '../../pomoc/konta-prz068.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';

const panele = [];
afterEach(async () => { for (const p of panele.splice(0)) { await p.app.close(); p.db.close(); } });
function panel(zKlientem = true) {
  const d = { uuid: 'demo-okres', number: 'DEMO/10', rodzaj: 'vat', invoice_date: '2026-10-01',
    client_company_name: 'Pracownia Przykładowa', kwotaZl: '10.00', pozostaloZl: '0.00',
    stanKsef: 'jest', okres: { id: 1, klient: 'Pracownia Przykładowa', rok: 2026, miesiac: 10 } };
  const p = nowyPanel({ fakturyWidok: { dokumenty: async () => [d], nieoplacone: async () => [d], proformy: () => [] } });
  panele.push(p);
  if (zKlientem) p.db.prepare(`INSERT INTO klienci (klucz,nazwa,nip,utworzone_at,zmienione_at)
    VALUES ('przyklad','Pracownia Przykładowa','1234567890','2026-10-01','2026-10-01')`).run();
  p.db.prepare(`INSERT INTO okresy_rozliczeniowe (klient_klucz,rok,miesiac,stan,utworzony_at,numer,infakt_uuid)
    VALUES ('przyklad',2026,10,'zafakturowany','2026-10-01','DEMO/10','demo-okres')`).run();
  p.db.prepare(`INSERT INTO zamowienia (sklep,zrodlo_id,numer,kwota_brutto,utworzone_at,okres_rozliczeniowy_id,nip,chce_fakture)
    VALUES ('reczne',1,'DEMO/1','10.00','2026-10-01',1,'1234567890',1)`).run();
  p.db.prepare(`INSERT INTO platnosci_okresu (okres_rozliczeniowy_id,kwota,metoda,zrodlo,utworzona_at)
    VALUES (1,'10.00','przelew','reczna','2026-10-01')`).run();
  return p;
}
function wylacz(p, lista) {
  p.db.prepare(`INSERT OR REPLACE INTO ustawienia (klucz,wartosc,zmienione_at)
    VALUES ('moduly.wylaczone',?,'2026-10-20')`).run(JSON.stringify(lista));
}
it('karta zachowuje treść okresu i klienta, a po wyłączeniu usuwa tylko odnośniki', async () => {
  const p = panel();
  const wlaczona = await get(p.app, '/zamowienia/1', BASIC);
  expect(wlaczona.statusCode).toBe(200);
  for (const fragment of ['<a href="/okresy/1">faktura za październik 2026</a>',
    '<a href="/okresy/1">okres październik 2026</a>', '<a href="/okresy/1">okresie październik 2026</a>',
    '<a href="/okresy/1">przejdź do okresu październik 2026</a>', '<a href="/klienci/1">Pracownia Przykładowa</a>']) {
    expect(wlaczona.body).toContain(fragment);
  }
  // Taki rozliczony okres faktycznie pozwala wyłączyć oba moduły przez ekran Ustawień.
  for (const modul of ['okresy', 'klienci']) expect((await post(p.app, '/ustawienia/moduly', BASIC, { modul, wlacz: '0' })).statusCode).toBe(303);
  const r = await get(p.app, '/zamowienia/1', BASIC);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('faktura za październik 2026');
  expect(r.body).toContain('w bazie jako Pracownia Przykładowa');
  expect(r.body).toContain('przejdź do okresu październik 2026 (moduł wyłączony)');
  expect(r.body).not.toContain('href="/okresy/');
  expect(r.body).not.toContain('href="/klienci');
});
it.each([true, false])('nowe zamówienie: odnośnik do klientów z bazą=%s', async zKlientem => {
  const p = panel(zKlientem);
  expect((await get(p.app, '/zamowienia/nowe', BASIC)).body).toContain('<a href="/klienci">Stali klienci</a>');
  wylacz(p, ['klienci']);
  const r = await get(p.app, '/zamowienia/nowe', BASIC);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Stali klienci (moduł wyłączony)');
  expect(r.body).not.toContain('href="/klienci');
});
it('faktury: obie tabele zachowują nazwę okresu bez linku po wyłączeniu', async () => {
  const p = panel();
  expect((await get(p.app, '/faktury', BASIC)).body).toContain('<a href="/okresy/1">Pracownia Przykładowa 2026-10</a>');
  wylacz(p, ['okresy']);
  const r = await get(p.app, '/faktury', BASIC);
  expect(r.statusCode).toBe(200);
  expect(r.body.match(/Pracownia Przykładowa 2026-10/g)).toHaveLength(2);
  expect(r.body).not.toContain('href="/okresy/');
});
it('odmowa faktury starego zamówienia pozostaje osiągalna: usługa i podgląd hurtem wskazują włączenie modułu', async () => {
  const p = panel();
  wylacz(p, ['okresy']);
  const faktura = createFaktura({ db: p.db, infakt: {} });
  await expect(faktura.wystaw(1)).rejects.toThrow('Włącz Rozliczenia w Ustawienia → Moduły, żeby wystawić fakturę za okres.');
  const r = await post(p.app, '/zamowienia/faktury-hurtem/podglad', BASIC, { id: '1' });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Włącz Rozliczenia w Ustawienia → Moduły, żeby wystawić fakturę za okres.');
  expect(r.body).not.toContain('/okresy/1');
});
