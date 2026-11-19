// Ustawienia → Magazyn — przełącznik „Włącz stany magazynowe” na prawdziwym serwerze.
import { describe, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { dodajProducenta, ustawDomyslnego } from '../../../src/oms/db/producenci.js';
import { przelacznikStanow } from '../../../src/oms/db/stany-magazynowe.js';
import { nowyPanel, jako, get, post } from '../../pomoc/panel-konta-testowe.js';

function panel() {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'magazyn']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}

/** Wycinek sekcji „Stany magazynowe” — asercje nie łapią napisów z menu ani z reszty strony. */
function sekcja(html) {
  const m = /<section class="ust-sekcja" id="ust-stany">[\s\S]*?<\/section>/u.exec(html);
  expect(m, 'brak sekcji #ust-stany').not.toBeNull();
  return m[0];
}
const formularz = (html) => /<form id="ust-stany-przelacz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';

describe('Ustawienia → Magazyn', () => {
  it('podmenu ma „Magazyn”, a ekran domyślnie mówi „Wyłączone” i daje przycisk „Włącz”', async () => {
    const { app, admin } = panel();
    const r = await get(app, '/magazyn/ustawienia', admin);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('href="/magazyn/ustawienia" aria-current="page"');
    const s = sekcja(r.body);
    expect(s).toContain('<strong>Wyłączone.</strong>');
    expect(s).not.toContain('Włączone</strong> od');
    expect(s).toContain('nie są wysyłane do sklepów ani na Allegro');
    const f = formularz(r.body);
    expect(f).toContain('action="/magazyn/ustawienia/stany"');
    expect(f).toContain('name="wlacz" value="1"');
    expect(f).toContain('Włącz stany magazynowe');
    expect(f).not.toContain('Wyłącz stany magazynowe');
    expect(f).not.toContain('liczy od nowa'); // pierwsze włączenie — bez ostrzeżenia o nowej granicy
    expect(s).not.toContain('Historia przełączania');
  });

  it('POST wlacz=1 włącza (303 na ekran), ekran pokazuje „Włączone od” i historię z loginem; drugi POST wyłącza', async () => {
    const { db, app, admin } = panel();
    const r = await post(app, '/magazyn/ustawienia/stany', admin, { wlacz: '1' });
    expect(r.statusCode, r.body).toBe(303);
    expect(r.headers.location).toMatch(/^\/magazyn\/ustawienia(\?|$)/u);
    const p = przelacznikStanow(db);
    expect(p.wlaczone).toBe(true);
    expect(p.historia[0]).toMatchObject({ wlaczone: true, konto_login: 'adam' });

    const wlaczony = await get(app, r.headers.location, admin);
    const s = sekcja(wlaczony.body);
    expect(s).toMatch(/<strong>Włączone<\/strong> od: <strong>\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u);
    expect(formularz(wlaczony.body)).toContain('name="wlacz" value="0"');
    expect(formularz(wlaczony.body)).toContain('Wyłącz stany magazynowe');
    expect(formularz(wlaczony.body)).toContain('Wyłączenie niczego nie kasuje');
    const historia = /<table class="tab-pozycje" id="ust-stany-historia">[\s\S]*?<\/table>/u.exec(s)?.[0] ?? '';
    expect(historia).toMatch(/<td>adam<\/td>\s*<td>włączenie<\/td>/u);

    const w = await post(app, '/magazyn/ustawienia/stany', admin, { wlacz: '0' });
    expect(w.statusCode, w.body).toBe(303);
    expect(przelacznikStanow(db)).toMatchObject({ wlaczone: false, granica: null });
    const wylaczony = await get(app, '/magazyn/ustawienia', admin);
    expect(sekcja(wylaczony.body)).toContain('<strong>Wyłączone.</strong>');
    const f = formularz(wylaczony.body);
    expect(f).toContain('Włącz stany magazynowe');
    expect(f).toContain('liczy od nowa'); // było już włączone — ostrzeżenie przy ponownym włączeniu
    const h2 = /<table class="tab-pozycje" id="ust-stany-historia">[\s\S]*?<\/table>/u.exec(wylaczony.body)?.[0] ?? '';
    expect(h2.match(/<tr>/gu)).toHaveLength(3); // nagłówek + dwa wpisy
    expect(h2).toMatch(/<td>adam<\/td>\s*<td>wyłączenie<\/td>[\s\S]*<td>adam<\/td>\s*<td>włączenie<\/td>/u);
  });

  it('wartość inna niż 1/0 → 400 i nic się nie zapisuje', async () => {
    const { db, app, admin } = panel();
    const r = await post(app, '/magazyn/ustawienia/stany', admin, { wlacz: 'tak' });
    expect(r.statusCode).toBe(400);
    expect(przelacznikStanow(db).historia).toHaveLength(0);
  });

  it('konto bez uprawnienia „ustawienia” nie wejdzie ani nie przełączy', async () => {
    const { db, app, ewa } = panel();
    const g = await get(app, '/magazyn/ustawienia', ewa);
    expect(g.statusCode).toBe(403);
    const r = await post(app, '/magazyn/ustawienia/stany', ewa, { wlacz: '1' });
    expect(r.statusCode).toBe(403);
    expect(przelacznikStanow(db)).toMatchObject({ wlaczone: false });
    expect(przelacznikStanow(db).historia).toHaveLength(0);
  });

  describe('blok „Producenci (GPSR)”', () => {
    const blok = (html) => /<section class="ust-sekcja" id="ust-producenci">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';
    const dane = (nazwa) => ({
      nazwa,
      ulica: 'ul. Przykładowa 1',
      kod: '00-001',
      miasto: 'Miasto',
      kraj: 'PL',
      email: 'kontakt@polcien.invalid',
    });

    it('bez producentów: zachęta i odnośnik do /magazyn/producenci', async () => {
      const { app, admin } = panel();
      const b = blok((await get(app, '/magazyn/ustawienia', admin)).body);
      expect(b).toContain('Nie masz jeszcze producentów — oferty Allegro i przepisy GPSR ich wymagają');
      expect(b).toContain('<a href="/magazyn/producenci">Producenci</a>');
    });

    it('dwóch producentów z domyślnym: liczba, nazwa domyślnego i odnośnik', async () => {
      const { db, app, admin } = panel();
      dodajProducenta(db, dane('Warsztat Przykładowy'));
      const id = dodajProducenta(db, dane('Pracownia Półcień')).id;
      ustawDomyslnego(db, id);
      const b = blok((await get(app, '/magazyn/ustawienia', admin)).body);
      expect(b).toContain('Producentów: <strong>2</strong>');
      expect(b).toContain('Domyślny: <strong>Pracownia Półcień</strong>');
      expect(b).not.toContain('Nie masz jeszcze producentów');
      expect(b).toContain('href="/magazyn/producenci"');
    });

    it('bez domyślnego: „brak domyślnego”; nazwa z <script> jest escapowana', async () => {
      const { db, app, admin } = panel();
      dodajProducenta(db, dane('Bez domyślnego'));
      expect(blok((await get(app, '/magazyn/ustawienia', admin)).body)).toContain('brak domyślnego');
      const zly = dodajProducenta(db, dane('<script>alert(1)</script>')).id;
      ustawDomyslnego(db, zly);
      const b = blok((await get(app, '/magazyn/ustawienia', admin)).body);
      expect(b).not.toContain('<script>alert(1)');
      expect(b).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });
});
