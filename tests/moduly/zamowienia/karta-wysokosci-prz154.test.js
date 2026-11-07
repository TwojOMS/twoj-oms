import { it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

let app, db;
afterEach(async () => { await app?.close(); db?.close(); app = null; db = null; });

it('karta: status i akcje obok używają małego rozmiaru pola i przycisków', async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' } }, poller: { stan: () => ({}) } });
  await app.ready();
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 15442, numer: 'DEMO-15442', klient: { first_name: 'Ewa', email: 'ewa@example.test' },
    dostawa: { city: 'Miasto', country: 'PL' }, metoda_wysylki: 'dpd', kwota_pobrania: null,
    chce_fakture: 0, nip: null, kwota_brutto: '50.00', koszt_dostawy_brutto: '0.00',
    status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-11-07T08:00:00Z', pozycje: [],
  }, {});
  const r = await app.inject({ url: `/zamowienia/${id}`, headers: { authorization: 'Basic ' + Buffer.from('operator:x').toString('base64') } });
  expect(r.statusCode).toBe(200);
  const form = r.body.match(/<form\b[^>]*class="zmiana-statusu"[\s\S]*?<\/form>/u)?.[0];
  expect(form).toBeDefined();
  const select = form.match(/<select\b[^>]*name="status"[^>]*>/u)?.[0];
  expect(select).toMatch(/class="[^"]*\boms-pole--male\b[^"]*"/u);
  expect(form).toMatch(/<button class="btn btn--maly oms-pole--male">Zmień<\/button>/u);
  expect(r.body).toMatch(/<summary class="btn btn--maly oms-pole--male">Wydruki<\/summary>/u);
  const css = readFileSync(new URL('../../../src/public/oms-design.css', import.meta.url), 'utf8');
  const rozmiar = css.match(/#status select\.oms-pole--male\s*\{([^}]+)\}/u)?.[1];
  expect(rozmiar).toMatch(/height:\s*var\(--pole-h-maly\)/u);
  expect(rozmiar).toMatch(/min-height:\s*var\(--pole-h-maly\)/u);
});

it('tabela pozycji rezerwuje miejsce na miniaturę i zachowuje jej szerokość', () => {
  const css = readFileSync(new URL('../../../src/public/oms-design.css', import.meta.url), 'utf8');
  const kolumna = css.match(/\.tab-pozycje\[data-tabela-odczytu\] \.kol-mini\s*\{([^}]+)\}/u)?.[1];
  // Miniatura 38 px z ramką + 24 px wcięć komórki, także w table-layout: fixed.
  expect(kolumna).toMatch(/\bwidth:\s*64px\s*;/u);
  expect(kolumna).toMatch(/\bmin-width:\s*64px\s*;/u);
  const obrazek = css.match(/\.tab-pozycje\[data-tabela-odczytu\] \.mini\s*\{([^}]+)\}/u)?.[1];
  expect(obrazek).toMatch(/\bwidth:\s*38px\s*;/u);
  expect(obrazek).toMatch(/\bmax-width:\s*none\s*;/u);
  expect(obrazek).toMatch(/\bobject-fit:\s*contain\s*;/u);
  // Po rezerwacji miejsca na zdjęcie nazwa musi mieć własne miejsce w przewijaku.
  expect(css).toMatch(/@media\s*\(max-width:\s*40rem\)\s*\{\s*\.tab-pozycje\.tab-stala\[data-tabela-odczytu\]\s*\{\s*min-width:\s*48rem;/u);
});
