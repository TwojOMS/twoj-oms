import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { createTrescAllegroPrzebieg } from '../../../src/moduly/magazyn/services/allegro-tresc-kart.js';
import { przelaczStany, dodajRuch } from '../../../src/oms/db/stany-magazynowe.js';

const auth = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost' };
const kanal = 'allegro_demo';
let db, app, id, oferta, tresc;
beforeEach(() => {
  db = openOmsDb(':memory:');
  id = utworzKarte(db, { nazwa: 'Karta próbna', waga_g: 1900, cena_gr: 28900, szerokosc_mm: 315, wysokosc_mm: 400 });
  oferta = zapiszProduktSklepowy(db, { kanal, produkt_id: '501', nazwa: 'Oferta próbna', cena_gr: 28900, odczytane_at: '2026-11-13' });
  powiazProdukt(db, oferta, id);
  tresc = { gotowy: () => true, stan: () => ({ trwa: false }), start: vi.fn(() => ({ wystartowal: true })) };
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' }, sklepy: { sklep_demo: {} }, kanaly: { [kanal]: {} },
    definicje: [{ klucz: kanal, typ: 'allegro', etykieta: 'Konto próbne' }, { klucz: 'sklep_demo', typ: 'woo', etykieta: 'Sklep próbny' }] },
    magazyn: { gotowy: () => true }, nadpisania: { 'magazyn.trescAllegro': tresc } });
});
afterEach(async () => { await app?.close(); db.close(); });
const strona = async () => { const r = await app.inject({ url: `/magazyn/${id}`, headers: auth }); expect(r.statusCode).toBe(200); return r.body; };
const post = (pid = oferta, headers = auth) => app.inject({ method: 'POST', url: `/magazyn/${id}/tresc-oferty/${pid}`, headers, payload: {} });

it('pokazuje polskie liczby, wagę, wymiary i cenę oferty', async () => {
  const html = await strona();
  expect(html).toContain('1,9 kg');
  expect(html).toContain('31,5 × 40 cm');
  expect(html.match(/289,00 zł/g)?.length).toBe(2);
  expect(html).toContain(`action="/magazyn/${id}/tresc-oferty/${oferta}"`);
});
it.each([
  ['reczne', 1, 'ręcznie'], ['zastane', 1, 'zastane'], ['api', 1, 'API'],
  [`allegro:${kanal}`, 0, 'Allegro: Konto próbne'], ['woo:sklep_demo', 0, 'sklep: Sklep próbny'],
])('pokazuje źródło %s przy każdym polu', async (zrodlo, reczne, etykieta) => {
  db.prepare('DELETE FROM karty_zrodla_pol WHERE karta_id = ?').run(id);
  for (const pole of ['nazwa', 'ean', 'cena_gr', 'stawka_vat', 'opis_sekcje_json', 'zdjecia']) {
    db.prepare('INSERT INTO karty_zrodla_pol (karta_id,pole,zrodlo,reczne,zmieniono_at) VALUES (?,?,?,?,?)').run(id,pole,zrodlo,reczne,'2026-11-13');
  }
  const html = await strona();
  expect(html.match(/class="zrodlo-pola"/g)?.length).toBe(6);
  expect(html.match(new RegExp(`>${etykieta}</small>`, 'g'))?.length).toBe(6);
});
it('bez wiersza źródła nie pokazuje etykiety', async () => {
  db.prepare('DELETE FROM karty_zrodla_pol WHERE karta_id = ?').run(id);
  expect(await strona()).not.toContain('class="zrodlo-pola"');
});
it('umieszcza pełny powód ruchu w nazwanym kontenerze dostępnym z klawiatury', async () => {
  przelaczStany(db, { wlacz: true, konto: { id: 1, login: 'operator' }, at: '2026-11-12T08:00:00Z' });
  const powod = 'Korekta po przeliczeniu długiej partii próbnej — pełne wyjaśnienie ruchu magazynowego';
  dodajRuch(db, { kartaId: id, rodzaj: 'korekta', ilosc: 2, powod, klucz: '07d-ruch', at: '2026-11-13T08:00:00Z' });
  const html = await strona();
  expect(html).toMatch(/class="ruchy-przewijanie" tabindex="0" role="region" aria-label="Historia ruchów magazynowych">\s*<table/);
  expect(html).toContain(`<td>${powod}</td>`);
});
it('pokazuje błąd z datą bez pełnego URL i nie renderuje przycisku dla Woo', async () => {
  db.prepare('UPDATE produkty_sklepowe SET tresc_blad = ?, tresc_blad_at = ? WHERE id = ?')
    .run('Treść nie pobrana: Błąd zdjęcia https://foto.example/a.jpg?prywatne=1', '2026-11-13T08:10:00Z', oferta);
  const woo = zapiszProduktSklepowy(db, { kanal: 'sklep_demo', produkt_id: '12', nazwa: 'Produkt próbny', odczytane_at: '2026-11-13' });
  powiazProdukt(db, woo, id);
  const html = await strona();
  expect(html).toContain('Treść nie pobrana: Błąd zdjęcia');
  // Przebieg zapisuje gotowy tekst z przedrostkiem — widok nie dokleja drugiego.
  expect(html.match(/Treść nie pobrana:/g)).toHaveLength(1);
  expect(html).toContain('13.11.2026');
  expect(html).not.toContain('https://foto.example/a.jpg');
  expect(html).not.toContain('prywatne=1');
  expect(html).not.toContain(`/tresc-oferty/${woo}`);
});
it('odrzuca ofertę innej karty', async () => {
  const obca = utworzKarte(db, { nazwa: 'Inna karta' });
  powiazProdukt(db, oferta, obca);
  expect((await post()).statusCode).toBe(404);
  expect(tresc.start).not.toHaveBeenCalled();
});
it('ukrywa pobieranie treści znikniętej oferty, zachowując możliwość odpięcia', async () => {
  db.prepare('UPDATE produkty_sklepowe SET zniknal_at = ? WHERE id = ?').run('2026-11-13', oferta);
  const html = await strona();
  expect(html).toContain('Oferta próbna');
  expect(html).not.toContain(`/tresc-oferty/${oferta}`);
  expect(html).toContain(`name="produktSklepowyId" value="${oferta}"`);
});
it('odmawia po polsku 400 pobrania treści znikniętej oferty bez startu przebiegu', async () => {
  db.prepare('UPDATE produkty_sklepowe SET zniknal_at = ? WHERE id = ?').run('2026-11-13', oferta);
  const r = await post();
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('Oferta zniknęła z Allegro');
  expect(tresc.start).not.toHaveBeenCalled();
});
it('odrzuca Woo', async () => {
  db.prepare('UPDATE produkty_sklepowe SET kanal = ? WHERE id = ?').run('sklep_demo', oferta);
  expect((await post()).statusCode).toBe(404);
  expect(tresc.start).not.toHaveBeenCalled();
});
it('startuje wskazaną ofertę nawet po trwałym błędzie i wraca z komunikatem', async () => {
  db.prepare('UPDATE produkty_sklepowe SET tresc_blad = ? WHERE id = ?').run('HTTP 404', oferta);
  const r = await post();
  expect(tresc.start).toHaveBeenCalledExactlyOnceWith({ ofertaWskazana: oferta });
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe(`/magazyn/${id}?tresc=rozpoczeta`);
  const get = await app.inject({ url: r.headers.location, headers: auth });
  expect(get.body).toContain('Pobieram treść i zdjęcia ofert Allegro');
});
it('przy trwającym przebiegu nie wywołuje drugiego startu', async () => {
  tresc.stan = () => ({ trwa: true });
  const r = await post();
  expect(tresc.start).not.toHaveBeenCalled();
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toContain('tresc=w-toku');
});
it('chroni POST przez CSRF', async () => {
  expect((await post(oferta, { authorization: auth.authorization })).statusCode).toBeGreaterThanOrEqual(400);
  expect(tresc.start).not.toHaveBeenCalled();
});
it('przekazuje wskazanie przez rzeczywisty przebieg i ponawia ofertę już pobraną', async () => {
  db.prepare('UPDATE produkty_sklepowe SET tresc_pobrana_at = ? WHERE id = ?').run('2026-11-12', oferta);
  const pobierzOferte = vi.fn(async () => { throw new Error('kontrolowany błąd próby'); });
  const przebieg = createTrescAllegroPrzebieg({ db, kanalyAllegro: [kanal], allegro: { [kanal]: { pobierzOferte } } });
  expect(przebieg.start({ ofertaWskazana: oferta })).toEqual({ wystartowal: true });
  await vi.waitFor(() => expect(przebieg.stan().trwa).toBe(false));
  expect(pobierzOferte).toHaveBeenCalledExactlyOnceWith('501');
});
