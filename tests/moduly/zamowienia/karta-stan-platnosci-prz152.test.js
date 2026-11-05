// PRZ-152.G3a — panel „Szczegóły zamówienia”: wiersz „Status” znika, w jego miejscu stoi
// „Status płatności” z kolorową plakietką bez daty (właściciel 04.11). Stan liczy domena
// (stanPlatnosciKarty), widok tylko drukuje klasę i napis. Dane zmyślone („Pracownia Półcień”).
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajWplateReczna } from '../../../src/oms/db/platnosci.js';
import { dodajZwrot, oznaczPieniadzeOddane } from '../../../src/oms/db/zwroty.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-11-04T12:00:00', ostatni_blad: null }) };

let nr = 15200;
const zmapowane = (nad = {}) => {
  nr += 1;
  return {
    zrodlo_id: nr, numer: String(nr), klient: { first_name: 'Pracownia', last_name: 'Półcień', email: 'biuro@example.test' },
    dostawa: { city: 'Lublin' }, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
    kwota_brutto: '100.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
    metoda_platnosci: 'Przelew tradycyjny', utworzone_at: '2026-11-03T10:15:00',
    pozycje: [{ nazwa: 'Szablon liść', sku: 'PC-LISC-01', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: null }],
    ...nad,
  };
};

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

const nowe = (nad) => zapiszZamowienie(db, 'pro', zmapowane(nad), {});
const pobranie = { pobranie: 1, kwota_pobrania: '100.00', metoda_platnosci: 'Za pobraniem' };

// Panel „Szczegóły zamówienia” od nagłówka sekcji do jej końca.
async function szczegoly(id) {
  const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
  expect(r.statusCode, r.body).toBe(200);
  const od = r.body.indexOf('id="szczegoly"');
  expect(od, 'brak panelu „Szczegóły”').toBeGreaterThan(-1);
  return r.body.slice(od, r.body.indexOf('</section>', od));
}
// Sam wiersz „Status płatności” (plakietka ma zagnieżdżone <span>, ale żadnego <div>).
function wiersz(panel) {
  const od = panel.indexOf('<div><span>Status płatności</span>');
  expect(od, 'brak wiersza „Status płatności”').toBeGreaterThan(-1);
  return panel.slice(od, panel.indexOf('</div>', od));
}

describe('panel „Szczegóły”: Status płatności zamiast Status', () => {
  it('opłacone online → zielona „Opłacone”, bez daty; wiersza „Status” nie ma', async () => {
    const p = await szczegoly(nowe({ oplacone_at: '2026-11-03T10:18:27', metoda_platnosci: 'Przelewy24' }));
    expect(p).not.toContain('<span>Status</span>');
    const w = wiersz(p);
    expect(w).toMatch(/class="znacznik znacznik--ok"[^>]*>Opłacone</);
    expect(w).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(w).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // Stary wiersz z datą znika — „Status płatności” jest w panelu dokładnie raz.
    expect(p.split('Status płatności').length - 1).toBe(1);
  });

  it('brak wpłaty → czerwona „Nieopłacone”', async () => {
    const w = wiersz(await szczegoly(nowe()));
    expect(w).toMatch(/class="znacznik znacznik--czerwony"[^>]*>Nieopłacone</);
  });

  it('pobranie przed doręczeniem → pomarańczowa „Pobranie · czeka na kuriera” (dawniej czerwone „nieopłacone”)', async () => {
    const w = wiersz(await szczegoly(nowe(pobranie)));
    expect(w).toMatch(/class="znacznik znacznik--pomaranczowy"[^>]*>Pobranie · czeka na kuriera</);
    expect(w).not.toContain('nieopłacone');
  });

  it('pobranie rozliczone przez kuriera (wpłata ręczna „Za pobraniem”) → zielona „Opłacone” i „potwierdzone ręcznie”', async () => {
    const id = nowe(pobranie);
    dodajWplateReczna(db, id, { kwota: '100.00', data: '2026-11-04', metoda: 'Za pobraniem' });
    const w = wiersz(await szczegoly(id));
    expect(w).toMatch(/class="znacznik znacznik--ok"[^>]*>Opłacone</);
    expect(w).toContain('potwierdzone ręcznie');
  });

  it('błąd (1): pobranie z „wpłatą” sklepu „Za pobraniem” → pomarańczowe, nie zielone „opłacone”', async () => {
    const w = wiersz(await szczegoly(nowe({ ...pobranie, oplacone_at: '2026-10-30T10:18:27' })));
    expect(w).toMatch(/znacznik--pomaranczowy/);
    expect(w).not.toMatch(/znacznik--ok|Opłacone/);
  });

  it('błąd (2): wpłata 100,00 i zwrot 100,00 z oddanymi pieniędzmi → szare „Zwrócone w całości”', async () => {
    const id = nowe({ oplacone_at: '2026-10-26T09:00:00' });
    const zwrotId = dodajZwrot(db, id, { data: '2026-11-02', kwota: '100.00', pozycje: [] }).id;
    oznaczPieniadzeOddane(db, id, zwrotId, '2026-11-03T09:00:00');
    const w = wiersz(await szczegoly(id));
    expect(w).toMatch(/class="znacznik znacznik--szary"[^>]*>Zwrócone w całości</);
  });

  it('błąd wyceny → szary „Błąd wyceny” z opisem z domeny w title', async () => {
    const id = nowe();
    db.prepare("UPDATE zamowienia SET kwota_brutto = 'abc' WHERE id = ?").run(id);
    const w = wiersz(await szczegoly(id));
    expect(w).toMatch(/class="znacznik znacznik--szary" title="[^"]+"[^>]*>Błąd wyceny</);
  });
});
