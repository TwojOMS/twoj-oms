import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nowyPanel, BASIC, ORIGIN } from '../../pomoc/konta-prz068.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zalozKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';
import { createProforma } from '../../../src/moduly/faktury/services/proforma.js';

const cialo = {
  kartaId: 'karta-polcien',
  klient: { first_name: 'Ala', last_name: 'Testowa', company: 'Pracownia Półcień', email: 'ala@example.test' },
  dostawa: { first_name: 'Ala', last_name: 'Testowa', address_1: 'Przykładowa 7', postcode: '00-001', city: 'Testowo' },
  chceFakture: false, kosztDostawyBrutto: '19.00',
  pozycje: [{ nazwa: 'Dekoracja testowa', sku: 'TEST-1', ilosc: 2, cena_brutto: '61.50' }],
};
let zestawy;
beforeEach(() => { zestawy = []; });
afterEach(async () => {
  for (const z of zestawy) {
    await z.app.close();
    z.db.close();
    rmSync(z.katalog, { recursive: true, force: true });
  }
});
async function zestaw(v1, { proformy = true, kanal = true } = {}) {
  const db = openOmsDb(':memory:');
  const katalog = mkdtempSync(join(tmpdir(), 'api-zapis-'));
  const dokumenty = [];
  const proforma = proformy ? createProforma({
    db, config: {
      nadawca: { nazwa: 'Pracownia Półcień', ulica: 'Przykładowa 1', kod: '00-001', miasto: 'Testowo', kraj: 'PL' },
      proforma: { katalog, nip: '1234563218', rachunek: '34109010140000000000000000', bank: 'Bank testowy' },
    },
    teraz: () => new Date('2026-11-06T10:00:00.000Z'),
    budujPdf: dane => { dokumenty.push(dane); return Buffer.from('%PDF-1.3 atrapa lokalna'); },
  }) : null;
  const syncSklep = { odeslijStatus: vi.fn(async () => {}) };
  const { app } = nowyPanel({ db, proforma, syncSklep, env: { OMS_KANAL_INDYWIDUALNY: kanal ? '1' : '0' } });
  const z = { app, db, katalog, dokumenty, syncSklep };
  zestawy.push(z);
  await app.ready();
  const kontoId = zalozKonto(db, { login: 'tester', imie: 'Tester', haslo: 'h', admin: true, rola: 'administrator' });
  z.klucz = zakresy => ({ authorization: `Bearer ${zalozKluczApi(db, {
    nazwa: 'panel testowy', zakresy, kontoId, teraz: new Date().toISOString(),
  }).klucz}` });
  const headers = v1 ? z.klucz(['zamowienia:zapis', 'proformy:zapis']) : { ...BASIC, ...ORIGIN };
  z.wolaj = (path, payload, method = 'POST', inneNaglowki = headers) => app.inject({
    method, url: `${v1 ? '/api/v1' : '/api'}${path === '/zamowienia/z-karty' && !v1 ? '/zamowienia-z-karty' : path}`,
    headers: inneNaglowki, ...(payload === undefined ? {} : { payload }),
  });
  z.zaloz = () => z.wolaj('/zamowienia/z-karty', cialo);
  return z;
}
const bezZmiennych = w => Object.fromEntries(Object.entries(w).filter(([k]) =>
  k !== 'id' && k !== 'zamowienie_id' && !k.endsWith('_at') && k !== 'wRealizacjiAt'));
const wiersze = (z, tabela) => z.db.prepare(`SELECT * FROM ${tabela} ORDER BY id`).all().map(bezZmiennych);
async function para(opcje) { return [await zestaw(false, opcje), await zestaw(true, opcje)]; }
async function zalozOba(a, b) {
  const ra = await a.zaloz(), rb = await b.zaloz();
  expect(ra.statusCode).toBe(201);
  expect(rb.statusCode).toBe(ra.statusCode);
  expect(bezZmiennych(rb.json())).toEqual(bezZmiennych(ra.json()));
  return [ra.json().id, rb.json().id];
}

it('z karty: identyczne odpowiedzi i wiersze dwóch baz, powtórka 409; klucz działa bez Origin', async () => {
  const [a, b] = await para();
  const [ia, ib] = await zalozOba(a, b);
  expect(wiersze(b, 'zamowienia')).toEqual(wiersze(a, 'zamowienia'));
  expect(wiersze(b, 'pozycje')).toEqual(wiersze(a, 'pozycje'));
  expect(wiersze(b, 'pozycje')).toHaveLength(1);
  for (const [z, id] of [[a, ia], [b, ib]]) {
    const r = await z.zaloz();
    expect(r.statusCode).toBe(409);
    const { numer } = z.db.prepare('SELECT numer FROM zamowienia WHERE id = ?').get(id);
    expect(r.json()).toEqual({ id, numer, powod: 'Zamówienie z tej karty już istnieje.' });
  }
  expect(b.db.prepare("SELECT akcja, kto FROM log WHERE akcja = 'zamowienie.z-karty'").all())
    .toEqual([{ akcja: 'zamowienie.z-karty', kto: 'klucz: panel testowy' }]);
});

it('w realizacji: identyczny skutek, idempotencja i wywołanie usługi synchronizacji', async () => {
  const [a, b] = await para();
  const ids = await zalozOba(a, b);
  const wyniki = [];
  for (const [i, z] of [a, b].entries()) {
    const r = await z.wolaj(`/zamowienia/${ids[i]}/w-realizacji`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json().wRealizacjiAt).toBeTruthy();
    const drugi = await z.wolaj(`/zamowienia/${ids[i]}/w-realizacji`, {});
    expect(drugi.json()).toEqual(r.json());
    expect(z.syncSklep.odeslijStatus).toHaveBeenCalledWith(ids[i]);
    wyniki.push(bezZmiennych(r.json()));
  }
  expect(wyniki[1]).toEqual(wyniki[0]);
  expect(wiersze(b, 'zamowienia')).toEqual(wiersze(a, 'zamowienia'));
});

it('proforma: identyczne kwoty, seria, dane dokumentu i PDF przez v1', async () => {
  const [a, b] = await para();
  const ids = await zalozOba(a, b);
  const wyniki = [];
  for (const [i, z] of [a, b].entries()) {
    const r = await z.wolaj(`/zamowienia/${ids[i]}/proforma`, {});
    expect(r.statusCode).toBe(201);
    expect(r.json().numer).toBe('PF/1/11/2026');
    // pdfUrl prowadzi pod wejście, którym wystawiono — klucz v1 nie otwiera adresu panelu.
    expect(r.json().pdfUrl).toBe(`${i ? '/api/v1' : '/api'}/proformy/${r.json().id}/pdf`);
    const { pdfUrl, ...bezAdresu } = r.json();
    wyniki.push(bezAdresu);
    const pdf = await z.wolaj(pdfUrl.replace(/^\/api(\/v1)?/, ''), undefined, 'GET');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(z.db.prepare('SELECT kwota_brutto FROM proformy').get().kwota_brutto).toBe('142.00');
  }
  expect(wyniki[1]).toEqual(wyniki[0]);
  expect(b.dokumenty).toEqual(a.dokumenty);
});

it('brak konfiguracji proform daje 503 dla wystawienia i PDF w obu wejściach', async () => {
  const [a, b] = await para({ proformy: false });
  const ids = await zalozOba(a, b);
  for (const [i, z] of [a, b].entries()) {
    for (const [path, method] of [[`/zamowienia/${ids[i]}/proforma`, 'POST'], ['/proformy/1/pdf', 'GET']]) {
      const r = await z.wolaj(path, undefined, method);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ powod: 'Proformy nie są skonfigurowane.' });
    }
  }
});

it('wyłączony kanał odmawia założenia w obu wejściach', async () => {
  for (const z of await para({ kanal: false })) {
    const r = await z.zaloz();
    expect(r.statusCode).toBe(503);
    expect(r.json().powod).toContain('Kanał zamówień indywidualnych jest wyłączony');
    expect(wiersze(z, 'zamowienia')).toEqual([]);
  }
});

it.each([
  ['/zamowienia/z-karty', 'POST', 'zamowienia:zapis'],
  ['/zamowienia/1/w-realizacji', 'POST', 'zamowienia:zapis'],
  ['/zamowienia/1/proforma', 'POST', 'proformy:zapis'],
  ['/proformy/1/pdf', 'GET', 'proformy:zapis'],
])('%s: klucz bez właściwego zakresu dostaje 403 brak_zakresu', async (path, method, zakres) => {
  const z = await zestaw(true);
  const r = await z.wolaj(path, method === 'POST' ? cialo : undefined, method, z.klucz(['druk']));
  expect(r.statusCode).toBe(403);
  expect(r.json()).toEqual({ kod: 'brak_zakresu', powod: `Klucz nie ma zakresu ${zakres}.` });
});
