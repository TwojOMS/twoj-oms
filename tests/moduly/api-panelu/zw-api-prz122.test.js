// PRZ-122.B07c (recenzja, pkt 3) — API panelu (zamówienie z karty i proforma) bierze flagę `zw` z tego samego źródła
// co karta zamówienia (program wbudowany = TwojeFaktury). Firma zwolniona: pozycja z API bez pola `vat` dostaje „zw”,
// proforma z API drukuje „zw” (VAT 0). Bez flagi (brak programu, program „test”) — jak przed zmianą: 23 i 23%.
// Dane zmyślone („Pracownia Półcień”).
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszStawkeDomyslna } from '../../../src/moduly/faktury/db/stawka-vat.js';
import { createProforma } from '../../../src/moduly/faktury/services/proforma.js';
import { proformyZamowienia } from '../../../src/moduly/faktury/db/proformy.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

const naglowki = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost', host: 'localhost' };
function programWbudowany() {
  const p = programTestowy({ id: 'twojefaktury' });
  return { ...p, opis: Object.freeze({ ...p.opis, wbudowany: true }) };
}
const KARTA = {
  kartaId: 'karta-zw', klient: { first_name: 'Ewa', last_name: 'Półcień', email: 'ewa@polcien.invalid' },
  dostawa: { first_name: 'Ewa', last_name: 'Półcień', address_1: 'Lampowa 7', postcode: '00-950', city: 'Warszawa' },
  nip: null, chceFakture: false, kosztDostawyBrutto: '0.00', pozycje: [{ nazwa: 'Kurs lutowania', ilosc: 1, cena_brutto: '100.00' }],
};

let db; let app; let katalog;
async function panel(program) {
  db = openOmsDb(':memory:');
  zapiszStawkeDomyslna(db, 'zw', { zw: true });
  katalog = mkdtempSync(join(tmpdir(), 'prz122-b07c-api-'));
  const proforma = createProforma({ db, teraz: () => new Date('2026-10-27T10:00:00Z'), config: {
    nadawca: { nazwa: 'Pracownia Półcień', ulica: 'Lampowa 7', kod: '00-950', miasto: 'Warszawa', kraj: 'PL', phone: '' },
    proforma: { nip: '1234563218', rachunek: '34109010140000000000000000', bank: 'Bank Przykładowy', katalog },
  } });
  app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] }, proforma,
    ...(program === undefined ? {} : { infakt: program }) });
  await app.ready();
}
afterEach(async () => { await app?.close(); rmSync(katalog, { recursive: true, force: true }); app = null; });

async function zamowienieIProforma() {
  const r = await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: KARTA });
  expect(r.statusCode, r.body).toBe(201);
  const { id } = r.json();
  const stawki = db.prepare("SELECT vat FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'reczna'").all(id).map((p) => p.vat);
  const p = await app.inject({ method: 'POST', url: `/api/zamowienia/${id}/proforma`, headers: naglowki, payload: {} });
  expect(p.statusCode, p.body).toBeLessThan(300);
  const [pr] = proformyZamowienia(db, id);
  const pdf = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', pr.plik_sciezka, '-'], { encoding: 'utf8' });
  return { stawki, pdf };
}

describe('PRZ-122.B07c API panelu — firma zwolniona (domyślna „zw”)', () => {
  it('TwojeFaktury: pozycja z API dostaje „zw”, proforma z API drukuje „zw” bez „%” i bez 23%', async () => {
    await panel(programWbudowany());
    const { stawki, pdf } = await zamowienieIProforma();
    expect(stawki).toEqual(['zw']);
    expect(pdf).toMatch(/\bzw\b/u);
    expect(pdf).not.toContain('zw%');
    expect(pdf).not.toContain('23%');
  });

  it.each([
    ['brak programu', () => undefined],
    ['program „test”', () => programTestowy({ id: 'test' })],
  ])('bez flagi (%s): jak dotąd — pozycja 23, proforma 23%', async (_n, program) => {
    await panel(program());
    const { stawki, pdf } = await zamowienieIProforma();
    expect(stawki).toEqual(['23']);
    expect(pdf).toContain('23%');
    expect(pdf).not.toMatch(/\bzw\b/u);
  });
});
