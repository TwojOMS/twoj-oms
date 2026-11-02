// PRZ-123 C09 — ekran automatu KSeF: wybór trybu (ręcznie / po wystawieniu / o godzinie) i odstępu edycji TYLKO przy
// programie z własną wysyłką (opis.wbudowany, TwojeFaktury). inFakt — formularz bez zmian (przełącznik + godzina).
// Zapis trybu i odstępu zostawia wpis w logu z kontem. Model i obsługa zapisu bez serwera; widok przez ejs.
import { describe, it, expect, vi, afterEach } from 'vitest';
import ejs from 'ejs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modelAutomatuKsef, obsluzZapisAutomatuKsef } from '../../../src/moduly/faktury/trasy/automat-ksef-ekran.js';
import { wczytajAutomatKsef, odstepEdycjiMin, wstrzymajFakture } from '../../../src/moduly/faktury/db/ksef-automat.js';
import { sprawdzFormularzTrybu } from '../../../src/domena/ksef-automat.js';

const TU = dirname(fileURLToPath(import.meta.url));
const PARTIAL = join(TU, '../../../src/moduly/faktury/widoki/_automat-ksef.ejs');
const TF = { opis: { wbudowany: true }, nazwa: { mianownik: 'TwojeFaktury', dopelniacz: 'TwojeFaktury', miejscownik: 'TwojeFaktury', narzednik: 'TwojeFaktury' } };
const konfiguracja = { odlaczonyDoRestartu: () => false, wymagaRestartu: () => false };
const TERAZ = new Date('2026-10-28T09:00:00.000Z');

const bazy = [];
afterEach(() => { while (bazy.length) bazy.pop().close(); vi.restoreAllMocks(); });
function baza() { const db = openOmsDb(':memory:'); bazy.push(db); return db; }

function zapis(zaleznosci, body) {
  const info = vi.fn();
  const req = { konto: { admin: true, login: 'adam' }, body, method: 'POST', query: {}, log: { info, warn: vi.fn(), error: vi.fn() } };
  const reply = { kod: 200, cel: null, code(k) { this.kod = k; return this; }, redirect(c) { this.cel = c; return this; }, view: vi.fn() };
  return obsluzZapisAutomatuKsef(zaleznosci)(req, reply).then(() => ({ reply, info }));
}
const render = (automat) => ejs.renderFile(PARTIAL, { automat, konsumenckie: false, fmtDataCzas: (s) => String(s) });

describe('PRZ-123 C09 — formularz trybu (domena)', () => {
  it('poprawne wartości; odstęp 0–120 (puste = 15); zły tryb, odstęp poza zakresem i zła godzina → błędy', () => {
    expect(sprawdzFormularzTrybu({ tryb: 'po_wystawieniu', odstep_edycji: '0', godzina: '20:00' }))
      .toMatchObject({ tryb: 'po_wystawieniu', odstepEdycji: 0, godzina: '20:00', bledy: [] });
    expect(sprawdzFormularzTrybu({ tryb: 'reczna', odstep_edycji: '', godzina: '20:00' })).toMatchObject({ odstepEdycji: 15, bledy: [] });
    expect(sprawdzFormularzTrybu({ tryb: 'o_godzinie', odstep_edycji: '120', godzina: '07:30' }).bledy).toEqual([]);
    expect(sprawdzFormularzTrybu({ tryb: 'codziennie', odstep_edycji: '15', godzina: '20:00' }).bledy).toHaveLength(1);
    expect(sprawdzFormularzTrybu({ tryb: 'reczna', odstep_edycji: '121', godzina: '20:00' }).bledy).toHaveLength(1);
    expect(sprawdzFormularzTrybu({ tryb: 'reczna', odstep_edycji: '-1', godzina: '20:00' }).bledy).toHaveLength(1);
    expect(sprawdzFormularzTrybu({ tryb: 'reczna', odstep_edycji: '7.5', godzina: '20:00' }).bledy).toHaveLength(1);
    expect(sprawdzFormularzTrybu({ tryb: 'o_godzinie', odstep_edycji: '15', godzina: '23:59' }).bledy).toHaveLength(1);
  });
});

describe('PRZ-123 C09 — ekran przy TwojeFaktury', () => {
  it('domyślnie „ręcznie”, odstęp 15; widok ma wybór trybu i pole odstępu', async () => {
    const db = baza();
    const m = modelAutomatuKsef({ db, konfiguracjaInfaktu: konfiguracja, automatKsef: {}, teraz: () => TERAZ, infakt: TF });
    expect(m.wyborTrybu).toBe(true);
    expect(m.formularz).toMatchObject({ tryb: 'reczna', odstepEdycji: 15 });
    const html = await render(m);
    expect(html).toMatch(/name="tryb" value="reczna"[^>]* checked/u);
    expect(html).toContain('name="tryb" value="po_wystawieniu"');
    expect(html).toContain('name="tryb" value="o_godzinie"');
    expect(html).toMatch(/name="odstep_edycji"[^>]*value="15"/u);
    expect(html).not.toContain('name="wlaczony"');
  });

  it('zapis trybu „po wystawieniu” i odstępu: baza, wpis w logu z kontem, przekierowanie; linia stanu „co 5 minut”', async () => {
    const db = baza();
    const zal = { db, konfiguracjaInfaktu: konfiguracja, automatKsef: {}, teraz: () => TERAZ, infakt: TF };
    const { reply, info } = await zapis(zal, { tryb: 'po_wystawieniu', odstep_edycji: '30', godzina: '20:00' });
    expect(reply.kod).toBe(303);
    expect(wczytajAutomatKsef(db)).toMatchObject({ tryb: 'po_wystawieniu', odstepEdycji: 30, wlaczony: true, zmienil: { login: 'adam' } });
    expect(odstepEdycjiMin(db)).toBe(30);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ konto: 'adam', tryb: 'po_wystawieniu', odstepEdycji: 30 }), expect.any(String));
    const m = modelAutomatuKsef(zal);
    expect(m.najblizszy).toBe('co 5 minut');
    const html = await render(m);
    expect(html).toMatch(/name="tryb" value="po_wystawieniu"[^>]* checked/u);
    expect(html).toContain('Po wystawieniu');
  });

  it('powrót do „ręcznie” wyłącza automat; zły odstęp → 400 i nic nie zapisane', async () => {
    const db = baza();
    const zal = { db, konfiguracjaInfaktu: konfiguracja, automatKsef: {}, teraz: () => TERAZ, infakt: TF };
    await zapis(zal, { tryb: 'o_godzinie', odstep_edycji: '15', godzina: '20:00' });
    expect(wczytajAutomatKsef(db)).toMatchObject({ tryb: 'o_godzinie', wlaczony: true });
    await zapis(zal, { tryb: 'reczna', odstep_edycji: '15', godzina: '20:00' });
    expect(wczytajAutomatKsef(db)).toMatchObject({ tryb: 'reczna', wlaczony: false });
    const przed = wczytajAutomatKsef(db);
    const { reply } = await zapis(zal, { tryb: 'po_wystawieniu', odstep_edycji: '500', godzina: '20:00' }).catch(() => ({ reply: { kod: 400 } }));
    expect(reply.kod).toBe(400);
    expect(wczytajAutomatKsef(db)).toMatchObject({ tryb: przed.tryb, odstepEdycji: przed.odstepEdycji });
  });
});

// PRZ-123 C09cb: wpisu „odrzucona” / „nie-wyslano” nie da się zwolnić (ekran wyniku odmawia) — pasek tego nie obiecuje.
describe('PRZ-123 C09cb — pasek wstrzymanych bez „albo zwolnij” dla wpisów, których nie da się zwolnić', () => {
  const wpis = (db, wpisy) => { for (const w of wpisy) wstrzymajFakture(db, w, TERAZ.toISOString()); };
  const W1 = { uuid: 'u-1', numer: 'FV/1/10/2026', dzien: '27.10.2026', powod: 'kod 450: Błąd semantyki', kod: 'odrzucona', wersja: 1 };
  const W2 = { uuid: 'u-2', numer: 'FV/2/10/2026', dzien: '27.10.2026', powod: 'brak faktury na liście sesji', kod: 'nie-wyslano', wersja: 1 };
  const W3 = { uuid: 'u-3', numer: 'FV/3/10/2026', dzien: '27.10.2026', powod: 'Kontrahent bez NIP' };
  const zal = (db) => ({ db, konfiguracjaInfaktu: konfiguracja, automatKsef: {}, teraz: () => TERAZ, infakt: TF });

  it('same „odrzucona” i „nie-wyslano”: bez „albo zwolnij”, link do ekranu wyniku zostaje', async () => {
    const db = baza();
    wpis(db, [W1, W2]);
    const html = await render(modelAutomatuKsef(zal(db)));
    expect(html).toContain('FV/1/10/2026, FV/2/10/2026');
    expect(html).not.toContain('albo zwolnij');
    expect(html).toContain('href="/faktury/ksef/automat"');
  });

  // PRZ-123 K440c2: przy programie z własną wysyłką pasek odsyła po „co się stało i następny krok” do ekranu wyniku
  // (tam jest „Zwolnij” i „Sprawdź ponownie”); „albo zwolnij” w pasku zostaje tylko przy inFakcie.
  it('jest choć jeden wpis do zwolnienia: TwojeFaktury — następny krok na ekranie wyniku, inFakt — „albo zwolnij” jak dotąd', async () => {
    const db = baza();
    wpis(db, [W1, W3]);
    const html = await render(modelAutomatuKsef(zal(db)));
    expect(html).toContain('Co się stało i jaki jest następny krok — na <a href="/faktury/ksef/automat">');
    expect(html).not.toContain('albo zwolnij');
    expect(await render(modelAutomatuKsef({ ...zal(db), infakt: null }))).toContain('albo zwolnij na');
  });
});

describe('PRZ-123 C09 — inFakt bez zmian', () => {
  it('model bez wyboru trybu, widok z przełącznikiem i godziną; zapis przełącznikiem jak dotąd (tryb nie powstaje)', async () => {
    const db = baza();
    const zal = { db, konfiguracjaInfaktu: konfiguracja, automatKsef: {}, teraz: () => TERAZ, infakt: null };
    const m = modelAutomatuKsef(zal);
    expect(m.wyborTrybu).toBe(false);
    const html = await render(m);
    expect(html).not.toContain('name="tryb"');
    expect(html).not.toContain('name="odstep_edycji"');
    expect(html).toContain('name="wlaczony"');
    const { reply } = await zapis(zal, { wlaczony: ['0', '1'], godzina: '20:00' });
    expect(reply.kod).toBe(303);
    expect(wczytajAutomatKsef(db)).toMatchObject({ wlaczony: true, godzina: '20:00' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ustawienia WHERE klucz = 'ksef.automat.tryb'").get().n).toBe(0);
  });
});
