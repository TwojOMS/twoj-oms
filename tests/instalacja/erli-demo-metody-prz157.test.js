import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { uruchomZegary } from '../../src/core/zegary.ts';
import { ustawRejestrKanalow } from '../../src/domena/moduly-kanalow.ts';
import * as modulyKurierow from '../../src/domena/moduly-kurierow.ts';
import * as kanalErli from '../../src/moduly/kanaly/services/kanal-erli.ts';
import { modulyPiaskownicy } from '../../deploy/proba/atrapy/index.mjs';
import { ENV_DEMO, wygenerujDaneDemo } from '../../scripts/demo-dane.mjs';

let db, aplikacja, katalog;
let zegary = [];
afterEach(async () => {
  zegary.forEach(clearInterval);
  vi.useRealTimers();
  await aplikacja?.app.close();
  db?.close();
  if (katalog) rmSync(katalog, { recursive: true, force: true });
  ustawRejestrKanalow(null);
  vi.restoreAllMocks();
});

async function przygotujDemo() {
  const siec = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Test: sieć zabroniona'));
  katalog = mkdtempSync(new URL('../../.tmp-erli-demo-metody-', import.meta.url));
  const env = { ...ENV_DEMO, OMS_USER: 'test', OMS_PASS: 'fikcyjne',
    OMS_PROFORMY_KATALOG: join(katalog, 'proformy'), OMS_ETYKIETY_KATALOG: join(katalog, 'etykiety') };
  const moduly = modulyPiaskownicy(env, { baza: () => db });
  db = openOmsDb(':memory:', { moduly });
  wygenerujDaneDemo(db, { dzis: '2026-11-11', env });
  aplikacja = await zbudujAplikacje({ db, env, moduly,
    teraz: () => new Date('2026-11-11T12:00:00Z'), log: () => {} });
  return siec;
}

async function lista(kanal) {
  const r = await aplikacja.app.inject({ url: `/?wszystkie=1&kanal=${kanal}`,
    headers: { authorization: 'Basic ' + Buffer.from('test:fikcyjne').toString('base64') } });
  expect(r.statusCode).toBe(200);
  return r.body;
}

function dostawa(html, numer) {
  const wiersz = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)?.find(w => w.includes(numer));
  expect(wiersz, numer).toBeTruthy();
  return wiersz.match(/<td class="komorka-dostawa">([\s\S]*?)<\/td>/)[1];
}

it('demo: lista po pollerze pokazuje nazwy dostaw ERLI, obie drogi i żadnej blokady nadania', async () => {
  const siec = await przygotujDemo();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  zegary = uruchomZegary(aplikacja.zegary.filter(z => z.nazwa === 'poller'));
  await vi.advanceTimersByTimeAsync(120_000);
  const zamowienia = db.prepare("SELECT * FROM zamowienia WHERE sklep='erli_polcien' ORDER BY numer").all();
  expect(zamowienia).toHaveLength(15);
  // PRZ-159: ta baza nie ma lustra sklepu (demo je ma z generatora) — zakładamy je dla SKU pozycji ERLI.
  const dodajDoLustra = db.prepare("INSERT INTO produkty_sklepowe (kanal, produkt_id, nazwa, sku_sklepu, miniatura, odczytane_at) VALUES ('polcien', ?, ?, ?, ?, '2026-11-11T12:00:00Z')");
  for (const p of db.prepare("SELECT DISTINCT p.sku, p.nazwa FROM pozycje p JOIN zamowienia z ON z.id = p.zamowienie_id WHERE z.sklep = 'erli_polcien'").all()) {
    dodajDoLustra.run(p.sku, p.nazwa, p.sku, `https://demo.twojoms.pl/public/demo-produkty/${p.sku}.jpg`);
  }
  const html = await lista('erli_polcien');
  const komorki = zamowienia.map(z => dostawa(html, z.numer));
  // PRZ-158: dostawa ERLI jak u innych kanałów — plakietka przewoźnika, bez dopisku drogi.
  // 12.11 właściciel: „w demo nie może takiego być” — żadne zamówienie demo nie ma nieznanej metody ani blokady nadania
  // (ostrzeżenie blokady sprawdzają karta-erli-nadanie, nadanie-erli-07c i lista-dostawa-erli-prz158 na kanale własnym).
  for (const [i] of zamowienia.entries()) {
    expect(komorki[i]).not.toContain('nieznana metoda');
    expect(komorki[i]).not.toContain('class="uwaga"');
    expect(komorki[i]).toContain('class="nazwa-dostawy"');
    expect(komorki[i]).not.toContain('kurier z umowy');
  }
  expect(komorki.some(k => k.includes('plakietka--erli'))).toBe(true);
  expect(komorki.some(k => k.includes('plakietka--dpd'))).toBe(true);
  expect(dostawa(html, 'PC-ERLI-0001')).toContain('title="Kurier DPD">Kurier DPD</span>');
  expect(dostawa(html, 'PC-ERLI-0002')).toContain('title="Kurier DPD (pobranie)">Kurier DPD (pobranie)</span>');
  expect(dostawa(html, 'PC-ERLI-0003')).toContain('title="Erli Paczkomat InPost">Erli Paczkomat InPost</span>');
  expect(dostawa(html, 'PC-ERLI-0008')).toContain('title="Erli Kurier InPost">Erli Kurier InPost</span>');
  expect(dostawa(html, 'PC-ERLI-0001')).not.toContain('umowa firmy');
  expect(dostawa(html, 'PC-ERLI-0011')).toContain('title="Erli Kurier InPost">Erli Kurier InPost</span>');
  // PRZ-159: pozycje ERLI (bez zdjęcia w zamówieniu) mają miniaturę produktu z lustra magazynu po SKU.
  const wiersze = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  for (const z of zamowienia) {
    const wiersz = wiersze.find(w => w.includes(z.numer));
    expect(wiersz, z.numer).toMatch(/<img class="mini" src="https:\/\/demo\.twojoms\.pl\/public\/demo-produkty\/[^"]+"/);
  }
  // Karta zamówienia i ekran nadania — ta sama droga (miniaturyEkranu).
  const auth = { authorization: 'Basic ' + Buffer.from('test:fikcyjne').toString('base64') };
  for (const adres of [`/zamowienia/${zamowienia[0].id}`, `/zamowienia/${zamowienia[0].id}/nadaj`]) {
    const r = await aplikacja.app.inject({ url: adres, headers: auth });
    expect(r.body, adres).toMatch(/src="https:\/\/demo\.twojoms\.pl\/public\/demo-produkty\/[^"]+"/);
  }
  const metodaKuriera = modulyKurierow.metodaKuriera;
  vi.spyOn(modulyKurierow, 'metodaKuriera').mockImplementation(kurier =>
    kurier === 'inpost_paczkomat' ? undefined : metodaKuriera(kurier));
  expect(dostawa(await lista('erli_polcien'), 'PC-ERLI-0012'))
    .toMatch(/<small>[^<]*OMS nie ma modułu tego kuriera[^<]*<\/small>/);
  expect(zamowienia.every(z => z.metoda_wysylki === 'nieznana')).toBe(true);
  expect(siec).not.toHaveBeenCalled();
});

it.each([
  [{ droga: 'umowa', kurier: 'dpd' }, 'Kurier DPD'],
  [{ droga: 'umowa', kurier: 'inpost_paczkomat' }, 'InPost Paczkomat'],
  [{ droga: 'umowa', kurier: 'odbior' }, 'Surowa nazwa metody'],
  [{ droga: 'przesylki_erli', metoda: { id: 'test', operator: 'DPD' } }, 'Erli Kurier DPD'],
  [{ droga: 'przesylki_erli', metoda: { id: 'test', operator: 'INPOST' } }, 'Erli Kurier InPost'],
  [{ droga: 'przesylki_erli', metoda: { id: 'test', operator: 'OTHER' } }, 'Erli Surowa nazwa metody'],
  [{ droga: 'blokada', komunikat: 'Testowa blokada' }, 'Surowa nazwa metody'],
  [null, 'Surowa nazwa metody'],
])('lista: nazwa i title dla drogi %j, także przy pobraniu', async (droga, nazwa) => {
  const siec = await przygotujDemo();
  const { id, numer } = db.prepare('SELECT id,numer FROM zamowienia LIMIT 1').get();
  db.prepare("UPDATE zamowienia SET sklep='erli_polcien', metoda_wysylki='nieznana', metoda_wysylki_nazwa='Surowa nazwa metody', pobranie=1 WHERE id=?").run(id);
  vi.spyOn(kanalErli, 'drogaErliDlaZamowienia').mockReturnValue(droga);
  const komorka = dostawa(await lista('erli_polcien'), numer);
  if (droga?.droga === 'blokada') {
    // Nierozpoznany przewoźnik już dziś daje ostrzeżenie zamiast nazwy.
    expect(komorka).toContain('nieznana metoda — nadaj ręcznie u przewoźnika');
    expect(komorka).toContain('<small>Testowa blokada</small>');
  } else {
    expect(komorka).toContain(`title="${nazwa} (pobranie)">${nazwa} (pobranie)</span>`);
  }
  expect(siec).not.toHaveBeenCalled();
});

it('lista ERLI z wyłączonym pobieraniem pokazuje powód blokady zamiast odsyłać do panelu ERLI', async () => {
  const siec = await przygotujDemo();
  db.prepare("UPDATE kanaly_sprzedazy SET pobieranie='wylaczone' WHERE klucz='erli_polcien'").run();
  const { id, numer } = db.prepare('SELECT id,numer FROM zamowienia LIMIT 1').get();
  db.prepare("UPDATE zamowienia SET sklep='erli_polcien' WHERE id=?").run(id);
  const komorka = dostawa(await lista('erli_polcien'), numer);
  expect(komorka).toContain('class="uwaga"');
  expect(komorka).toContain('>Nadanie zablokowane</span>');
  expect(komorka).toContain('<small>Kanał ERLI wyłączony — włącz pobieranie</small>');
  expect(komorka).not.toContain('nadaj w panelu ERLI');
  expect(siec).not.toHaveBeenCalled();
});

it('lista ERLI bez gotowych słowników pokazuje samą nazwę dostawy', async () => {
  const siec = await przygotujDemo();
  const { id } = db.prepare('SELECT id FROM zamowienia LIMIT 1').get();
  db.prepare("UPDATE zamowienia SET sklep='erli_polcien', metoda_wysylki='nieznana', metoda_wysylki_nazwa='Dostawa przed synchronizacją' WHERE id=?").run(id);
  const z = db.prepare('SELECT * FROM zamowienia WHERE id=?').get(id);
  const komorka = dostawa(await lista('erli_polcien'), z.numer);
  expect(komorka).toContain(z.metoda_wysylki_nazwa);
  expect(komorka).not.toContain('nieznana metoda');
  expect(komorka).not.toContain('class="uwaga"');
  expect(komorka).not.toContain('kurier z umowy');
  expect(komorka).not.toContain('Przesyłka Erli');
  expect(siec).not.toHaveBeenCalled();
});

it('lista nadal ostrzega o nieznanej metodzie dla kanału spoza ERLI', async () => {
  await przygotujDemo();
  const z = db.prepare("SELECT id,numer,sklep FROM zamowienia WHERE sklep<>'erli_polcien' LIMIT 1").get();
  db.prepare("UPDATE zamowienia SET metoda_wysylki='nieznana' WHERE id=?").run(z.id);
  const komorka = dostawa(await lista(z.sklep), z.numer);
  expect(komorka).toContain('class="uwaga"');
  expect(komorka).toContain('nieznana metoda — nadaj ręcznie u przewoźnika');
});

it('lista ERLI z ręcznie zmienioną metodą pokazuje tę metodę, nie drogę ERLI (jak nadanie)', async () => {
  await przygotujDemo();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  zegary = uruchomZegary(aplikacja.zegary.filter(z => z.nazwa === 'poller'));
  await vi.advanceTimersByTimeAsync(120_000);
  const wiersze = db.prepare("SELECT id,numer FROM zamowienia WHERE sklep='erli_polcien' ORDER BY numer").all();
  const przed = await lista('erli_polcien');
  const cel = wiersze.find(w => dostawa(przed, w.numer).includes('plakietka--erli'));
  expect(cel).toBeTruthy();
  db.prepare(`UPDATE zamowienia SET wysylka_reczna_json='{"metoda":"dpd"}' WHERE id=?`).run(cel.id);
  const komorka = dostawa(await lista('erli_polcien'), cel.numer);
  expect(komorka).not.toContain('plakietka--erli');
  expect(komorka).toContain('DPD');
});
