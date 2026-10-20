import { it, expect } from 'vitest';
import { nowyPanel, BASIC, get } from '../../pomoc/konta-prz068.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';

function zamowienie(db, indywidualne = false) {
  return zapiszZamowienie(db, 'reczne', {
    zrodlo_id: 'lampa-15', numer: 'LAMPA-15', kwota_brutto: '10.00',
    status_woo: 'processing', klient: {}, dostawa: {}, pozycje: [],
    metoda_wysylki: 'dpd', oplacone_at: null, nip: null, kwota_pobrania: null,
    chce_fakture: 0, anulowane: 0,
    utworzone_at: '2026-10-20T10:00:00Z', indywidualne,
  }, {});
}

it.each([
  ['bez kanału i historii', '0', false, false],
  ['z kanałem', '1', false, true],
  ['z historią bez kanału', '0', true, true],
  ['z prefiksem historii', undefined, false, true],
])('%s: menu, filtr i liczniki używają tej samej aktywności', async (_, kanal, historia, aktywny) => {
  const { db, app } = nowyPanel({ env: { OMS_KANAL_INDYWIDUALNY: kanal,
    OMS_HISTORIA_KLASYFIKACJA: JSON.stringify({ konta: [], prefiksyIndywidualne: kanal === undefined ? ['I|'] : [] }),
  } });
  try {
    await app.ready();
    zamowienie(db, historia);
    for (const adres of ['/', '/przesylki']) {
      const r = await get(app, adres, BASIC);
      expect(r.statusCode).toBe(200);
      expect(r.body.includes('href="/?status=indywidualne"'), adres).toBe(aktywny);
      expect(r.body.includes('data-status="indywidualne"'), adres).toBe(aktywny);
      if (adres === '/') expect(r.body.includes('value="indywidualne"')).toBe(aktywny);
    }
    expect((await get(app, '/ustawienia/statusy', BASIC)).body).toContain('pokazywany tylko przy zamówieniach indywidualnych');
    const lista = await get(app, '/?status=indywidualne', BASIC);
    expect(lista.statusCode).toBe(200);
    expect(lista.body.includes('LAMPA-15')).toBe(historia);
  } finally { await app.close(); db.close(); }
});

// PRZ-102.15b: pytanie „czy są zamówienia indywidualne” bez indeksu na kolumnie to pełny skan
// tabeli zamówień — przy każdym żądaniu łamało strażnika PRZ-051 (lista czyta jedną stronę).
// Odpowiedź zapada raz przy starcie, a potem dopisuje ją zapis zamówienia, nie żądanie.
const PYTANIE_O_HISTORIE = /\bFROM zamowienia\b[\s\S]*\bindywidualne\s*=\s*1/;
async function zapytaniaOHistorie(db, fn) {
  const przygotuj = db.prepare;
  const sql = [];
  db.prepare = function(tekst) { if (PYTANIE_O_HISTORIE.test(tekst)) sql.push(tekst); return przygotuj.call(this, tekst); };
  try { return { wynik: await fn(), sql }; } finally { db.prepare = przygotuj; }
}

it('zamówienie indywidualne zapisane w trakcie działania (droga pollera) włącza status bez restartu; żądanie nie pyta bazy', async () => {
  const { db, app } = nowyPanel({ env: { OMS_KANAL_INDYWIDUALNY: '0' } });
  try {
    await app.ready();
    zamowienie(db, false);
    const przed = await zapytaniaOHistorie(db, () => get(app, '/', BASIC));
    expect(przed.wynik.body).not.toContain('href="/?status=indywidualne"');
    expect(przed.sql).toEqual([]);
    // Poller zapisuje to samo zamówienie drugi raz (UPDATE) — sklep oznaczył je jako indywidualne.
    zamowienie(db, true);
    const po = await zapytaniaOHistorie(db, () => get(app, '/', BASIC));
    expect(po.wynik.body).toContain('href="/?status=indywidualne"');
    expect(po.wynik.body).toContain('data-status="indywidualne"');
    expect(po.sql).toEqual([]);
  } finally { await app.close(); db.close(); }
});

it('zamówienie indywidualne sprzed startu: status widoczny od pierwszego żądania, bez pytania bazy na żądanie', async () => {
  const db = openOmsDb(':memory:');
  zamowienie(db, true);
  const { app } = nowyPanel({ db, env: { OMS_KANAL_INDYWIDUALNY: '0' } });
  try {
    await app.ready();
    for (const adres of ['/', '/przesylki']) {
      const r = await zapytaniaOHistorie(db, () => get(app, adres, BASIC));
      expect(r.wynik.body, adres).toContain('href="/?status=indywidualne"');
      expect(r.sql, adres).toEqual([]);
    }
  } finally { await app.close(); db.close(); }
});

it('kanał włączony: ani przy starcie, ani na żądanie nie pytamy bazy o historię', async () => {
  const db = openOmsDb(':memory:');
  const { sql } = await zapytaniaOHistorie(db, async () => {
    const { app } = nowyPanel({ db, env: { OMS_KANAL_INDYWIDUALNY: '1' } });
    try {
      await app.ready();
      expect((await get(app, '/', BASIC)).body).toContain('href="/?status=indywidualne"');
    } finally { await app.close(); }
  });
  try { expect(sql).toEqual([]); } finally { db.close(); }
});
