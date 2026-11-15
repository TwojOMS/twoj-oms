import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { pobierzTrescOfertAllegro } from '../../../src/moduly/magazyn/services/allegro-tresc-kart.js';
import { zapiszTrescWoo } from '../../../src/moduly/magazyn/services/woo-tresc-kart.js';
import { produktErliZKarty } from '../../../src/domena/erli-produkt.js';
import { trescOferty } from '../../../src/moduly/magazyn/services/tresc-oferty.js';

const AT = '2026-11-13T12:00:00.000Z';
const adresy = [1, 2, 3].map(i => `https://polcien.example.invalid/${i}.jpg`);
const bazy = [];
afterEach(() => { for (const db of bazy.splice(0)) db.close(); });
function baza(moduly) {
  const db = openOmsDb(':memory:', moduly ? { moduly } : undefined); bazy.push(db);
  const id = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 10000, stawka_vat: '23' });
  const pid = zapiszProduktSklepowy(db, { kanal: 'allegro', produkt_id: 'LMP-01', wariant_id: '', nazwa: 'Lampa', odczytane_at: AT });
  powiazProdukt(db, pid, id);
  return { db, id, pid };
}
const galeria = (db, id) => db.prepare('SELECT * FROM zdjecia_kart WHERE karta_id = ? ORDER BY kolejnosc, id').all(id);
async function importuj({ db, pid }, ai, lista = adresy) {
  const wynik = await pobierzTrescOfertAllegro({ db, kanalyAllegro: ['allegro'], ofertaWskazana: pid,
    allegro: { allegro: { pobierzOferte: async () => ({ id: 'LMP-01', name: 'Lampa', images: lista, aiCoCreatedContent: { images: ai } }) } },
    teraz: () => new Date(AT), pobierzZdjecie: async adres => adres,
    zapiszZdjecie: async adres => ({ sha256: String(adresy.indexOf(adres) + 1).repeat(64), plik: 'test.jpg', typ: 'image/jpeg', rozmiar: 1 }),
  });
  expect(wynik).toMatchObject({ pobrane: 1, bledy: [], blad: null });
}
const ustawienia = { narzutBp: 0, stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'Lampy', stawkaVat: '23' };

it('migracja 0014 dwa razy: stare zdjęcie pozostaje nieznane', () => {
  const { db, id } = baza([{ ...modulRdzen, migracje: modulRdzen.migracje.filter(m => m.numer < 14) }]);
  db.prepare("UPDATE karty_produktow SET ai_wspoltworzone = 1 WHERE id = ?").run(id);
  db.prepare("INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'reczne', ?, ?)").run(id, adresy[0], AT);
  const migracja = modulRdzen.migracje.find(m => m.numer === 14);
  expect(migracja).toBeDefined();
  migracja.wykonaj(db); migracja.wykonaj(db);
  expect(galeria(db, id)[0]).toMatchObject({ ai: null, ai_reczne: 0, wyslane_at: null });
});

it.each([adresy[1], { url: adresy[1] }])('import 3 zdjęć: dokładnie jedno AI; ERLI tylko true i domyślnie bez znacznika (%j)', async ai => {
  const b = baza(); await importuj(b, [ai]);
  const zdjecia = galeria(b.db, b.id);
  expect(zdjecia.map(z => z.ai)).toEqual([0, 1, 0]);
  expect(b.db.prepare('SELECT ai_wspoltworzone FROM karty_produktow WHERE id = ?').get(b.id).ai_wspoltworzone).toBeNull();
  const wejscie = { karta: { nazwa: 'Lampa', cena_gr: 10000 }, ustawienia, zdjecia };
  const wlaczone = produktErliZKarty({ ...wejscie, wysylajAi: true });
  expect(wlaczone.bledy).toEqual([]);
  expect(wlaczone.zadanie.images).toEqual(adresy.map((url, i) => i === 1 ? { url, aiGenerated: true } : { url }));
  expect(produktErliZKarty(wejscie).zadanie.images).toEqual(adresy.map(url => ({ url })));
  b.db.prepare('UPDATE zdjecia_kart SET ai = NULL WHERE id = ?').run(zdjecia[2].id);
  const podglad = trescOferty(b.db, b.id, ustawienia);
  expect(podglad.ostrzezenia.join(' ')).toContain('Zdjęcia wygenerowane przez AI: tak — zdjęcia: 2');
  expect(podglad.ostrzezenia.join(' ')).toContain('nieznane: 3');
  expect(podglad.ostrzezenia.join(' ')).toContain('ustaw go w panelu ERLI');
});

it('ręczne oznaczenie przeżywa przebudowę po sha256; zmiana listy AI odświeża niezmienioną galerię', async () => {
  const b = baza(); await importuj(b, [adresy[1]]);
  const { ustawZnacznikAi } = await import('../../../src/moduly/magazyn/services/znacznik-ai.js');
  const pierwsze = galeria(b.db, b.id)[0];
  ustawZnacznikAi(b.db, { kartaId: b.id, zdjecieId: pierwsze.id, ai: 1, at: AT });
  await importuj(b, []);
  expect(galeria(b.db, b.id).map(z => [z.ai, z.ai_reczne])).toEqual([[1, 1], [0, 0], [0, 0]]);
  b.db.prepare('UPDATE zdjecia_kart SET wyslane_at = ? WHERE id = ?').run(AT, pierwsze.id);
  await importuj(b, [adresy[2]], [...adresy].reverse());
  expect(galeria(b.db, b.id).map(z => [z.ai, z.ai_reczne, z.wyslane_at])).toEqual([[1, 0, null], [0, 0, null], [1, 1, AT]]);
});

it.each([false, true])('wysłane nieręczne zdjęcie zachowuje AI przy zmianie listy i przebudowie=%s', async przebudowa => {
  const b = baza(); await importuj(b, [adresy[0]]);
  const pierwsze = galeria(b.db, b.id)[0];
  b.db.prepare('UPDATE zdjecia_kart SET wyslane_at = ? WHERE id = ?').run(AT, pierwsze.id);
  await importuj(b, [adresy[1]], przebudowa ? [...adresy].reverse() : adresy);
  const zdjecia = galeria(b.db, b.id);
  expect(zdjecia.find(z => z.sha256 === pierwsze.sha256)).toMatchObject({ ai: 1, ai_reczne: 0, wyslane_at: AT });
  expect(zdjecia.find(z => z.adres_zrodlowy === adresy[1])).toMatchObject({ ai: 1, ai_reczne: 0, wyslane_at: null });
});

it('podgląd bez zdjęć AI, ale z nieznanymi, nie deklaruje braku AI', async () => {
  const b = baza(); await importuj(b, []);
  b.db.prepare('UPDATE zdjecia_kart SET ai = NULL WHERE id = ?').run(galeria(b.db, b.id)[1].id);
  const tekst = trescOferty(b.db, b.id, ustawienia).ostrzezenia.join(' ');
  expect(tekst).toContain('Zdjęcia wygenerowane przez AI: nieznane — zdjęcia: brak; nieznane: 2');
  expect(tekst).not.toContain('Zdjęcia wygenerowane przez AI: nie —');
});

it('usługa zmienia jedno zdjęcie, zapisuje źródło ręczne i datę karty; po wysłaniu odmawia', async () => {
  const b = baza(); await importuj(b, []);
  const { ustawZnacznikAi } = await import('../../../src/moduly/magazyn/services/znacznik-ai.js');
  const z = galeria(b.db, b.id)[1];
  ustawZnacznikAi(b.db, { kartaId: b.id, zdjecieId: z.id, ai: 1, at: AT });
  expect(galeria(b.db, b.id).map(z => z.ai)).toEqual([0, 1, 0]);
  expect(b.db.prepare('SELECT * FROM karty_zrodla_pol WHERE karta_id = ? AND pole = ?').get(b.id, `zdjecie:${z.sha256}:ai`))
    .toMatchObject({ zrodlo: 'reczne', reczne: 1, zmieniono_at: AT });
  expect(b.db.prepare('SELECT zmieniony_at FROM karty_produktow WHERE id = ?').get(b.id).zmieniony_at).toBe(AT);
  expect(() => ustawZnacznikAi(b.db, { kartaId: b.id + 1, zdjecieId: z.id, ai: 0, at: AT })).toThrow(/nie istnieje/);
  expect(() => ustawZnacznikAi(b.db, { kartaId: b.id, zdjecieId: z.id, ai: 2, at: AT })).toThrow(/znacznik/);
  b.db.prepare('UPDATE zdjecia_kart SET wyslane_at = ? WHERE id = ?').run(AT, z.id);
  expect(() => ustawZnacznikAi(b.db, { kartaId: b.id, zdjecieId: z.id, ai: 0, at: AT })).toThrow(/wysłan/);
  expect(galeria(b.db, b.id)[1].ai).toBe(1);
});

it('Woo nowe zdjęcia mają 0, ręczne i wysłane zachowane przy zmianie kolejności', () => {
  const b = baza();
  const pid = zapiszProduktSklepowy(b.db, { kanal: 'woo', produkt_id: 'LMP-02', wariant_id: '', nazwa: 'Lampa', odczytane_at: AT });
  powiazProdukt(b.db, pid, b.id);
  const produkt = zdjecia => ({ kanal: 'woo', produkt_id: 'LMP-02', tresc_woo: { pola: {}, zdjecia } });
  zapiszTrescWoo(b.db, produkt(adresy), pid, AT);
  expect(galeria(b.db, b.id).map(z => z.ai)).toEqual([0, 0, 0]);
  b.db.prepare('UPDATE zdjecia_kart SET ai = 1, ai_reczne = 1, wyslane_at = ? WHERE id = ?').run(AT, galeria(b.db, b.id)[0].id);
  zapiszTrescWoo(b.db, produkt([...adresy].reverse()), pid, AT);
  expect(galeria(b.db, b.id).map(z => [z.ai, z.ai_reczne, z.wyslane_at])).toEqual([[0, 0, null], [0, 0, null], [1, 1, AT]]);
});
