// Referencja PRZ-094.13 z 9ccdd75, przed optymalizacją.
import { historiaWOknie, granice } from '../../../src/oms/db/historia-sprzedazy.js';
import { kanalHistoryczny, kanalOms, wymagajKlasyfikacji } from '../../../src/domena/kanaly-raportowe.js';
import { anulowaneEfektywnie } from '../../../src/domena/status-reczny.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';
import { grosze } from '../../../src/domena/kwoty.js';
import { kwotaOczekiwanaGrosze } from '../../../src/domena/suma-pozycji.js';
import { nalozNadpisaniaPozycji } from '../../../src/domena/pozycje-reczne.js';

import { nettoZamowieniaGrosze } from '../../../src/domena/netto-zamowienia.js';
export { nettoZamowieniaGrosze } from '../../../src/domena/netto-zamowienia.js';
export const KLIENCI_WDT = new Set();
const KOLUMNY_KLASYFIKACJI = ['sklep', 'indywidualne', 'b2b', 'okres_rozliczeniowy_id'];
const STATUSY_ODRZUCONE = new Set([21, 18]);
export function czyTestowe(email, nazwa, { czyTestowe: filtr = () => false } = {}) {
  return filtr(email, nazwa);
}
function granicaDla(mapa, kanal) {
  const g = mapa.get(kanal);
  if (!g) {
    const e = new Error(
      `Raport nie wie, gdzie przebiega granica historii dla kanału ${kanal}.`
      + JAK_ZALOZYC_GRANICE,
    );
    e.dlaOperatora = true;
    throw e;
  }
  return g;
}

export function sprzedazWOkresie(db, { od, do: doDnia }, reguly = {}) {
  wymagajKlasyfikacji(reguly.klasyfikacja);
  const mapa = granice(db);
  sprawdzGraniceBezHistorii(db, reguly.klasyfikacja);
  const wynik = [];

  for (const w of historiaWOknie(db, od, doDnia)) {
    if (STATUSY_ODRZUCONE.has(w.status)) continue;
    if (czyTestowe(w.klient_email, w.klient_nazwa, reguly)) continue;
    const kanal = kanalHistoryczny(w, reguly.klasyfikacja);
    if (w.dzien > granicaDla(mapa, kanal)) continue;
    const bruttoGrosze = grosze(w.brutto, `historia ${w.apilo_id}`);
    wynik.push({
      zrodlo: 'historia', id: w.apilo_id, numer: w.numer ?? w.apilo_id, dzien: w.dzien, kanal, bruttoGrosze,
      zrodloDanych: w.zrodlo,
      nettoGrosze: nettoZamowieniaGrosze(bruttoGrosze, w.klient_email, reguly.klienciWdt),
      faktura: Boolean(w.faktura), oplacone: w.payment_status === 2,
      email: w.klient_email ?? null, tagi: JSON.parse(w.tagi_json ?? '[]'),
      pozycje: w.pozycje.map((p) => ({
        nazwa: p.nazwa, ilosc: p.ilosc, typ: p.typ,
        bruttoGrosze: grosze(p.brutto_linii, `pozycja ${w.apilo_id}`),
      })),
    });
  }

  const zOms = db.prepare(
    'SELECT ' + KOLUMNY_KLASYFIKACJI.join(', ') + ', id, numer, kwota_brutto, utworzone_at,'
    + ' anulowane, anulowane_recznie, chce_fakture, chce_fakture_reczne, klient_json,'
    + ' klient_reczny_json, oplacone_at, oplacone_recznie,'
    + ' koszt_dostawy_brutto, pozycje_reczne_json FROM zamowienia',
  ).all();

  for (const w of zOms) {
    if (anulowaneEfektywnie(w)) continue;
    const dzien = dzienWarszawa(w.utworzone_at);
    if (!dzien || dzien < od || dzien > doDnia) continue;
    const kanal = kanalOms(w, reguly.klasyfikacja);
    if (dzien <= granicaDla(mapa, kanal)) continue;
    const klient = { ...bezpiecznyJson(w.klient_json), ...bezpiecznyJson(w.klient_reczny_json) };
    if (czyTestowe(klient.email, `${klient.first_name ?? ''} ${klient.last_name ?? ''} ${klient.company ?? ''}`, reguly)) continue;
    const pozycje = nalozNadpisaniaPozycji(pozycjeSurowe(db, w.id), w.pozycje_reczne_json);
    const bruttoGrosze = kwotaOczekiwanaGrosze({ ...w, pozycje });
    wynik.push({
      zrodlo: 'oms', id: w.id, numer: w.numer, dzien, kanal, bruttoGrosze,
      nettoGrosze: nettoZamowieniaGrosze(bruttoGrosze, klient.email, reguly.klienciWdt),
      faktura: Boolean(w.chce_fakture_reczne ?? w.chce_fakture),
      oplacone: Boolean(w.oplacone_at || w.oplacone_recznie),
      email: klient.email ?? null, tagi: [],
      pozycje: doRankingu(pozycje, w.id),
    });
  }

  return wynik.sort((a, b) => (a.dzien === b.dzien ? 0 : (a.dzien < b.dzien ? -1 : 1)));
}

function bezpiecznyJson(s) {
  try { return JSON.parse(s ?? '{}') ?? {}; } catch { return {}; }
}

export function zwrotyWOkresie(db, { od, do: doDnia }, reguly = {}) {
  wymagajKlasyfikacji(reguly.klasyfikacja);
  const wiersze = db.prepare(
    'SELECT w.id, w.zamowienie_id, w.data, w.kwota, w.kwota_dostawy,'
    + ' ' + KOLUMNY_KLASYFIKACJI.map(k => `z.${k}`).join(', ') + ', z.anulowane, z.anulowane_recznie, z.klient_json, z.klient_reczny_json'
    + ' FROM zwroty w JOIN zamowienia z ON z.id = w.zamowienie_id'
    + ' WHERE w.data >= ? AND w.data <= ? ORDER BY w.data, w.id',
  ).all(od, doDnia);

  const wynik = [];
  for (const w of wiersze) {
    if (anulowaneEfektywnie(w)) continue;
    const klient = { ...bezpiecznyJson(w.klient_json), ...bezpiecznyJson(w.klient_reczny_json) };
    if (czyTestowe(klient.email, `${klient.first_name ?? ''} ${klient.last_name ?? ''} ${klient.company ?? ''}`, reguly)) continue;
    const bruttoGrosze = grosze(w.kwota, `zwrot ${w.id}`)
      + (w.kwota_dostawy ? grosze(w.kwota_dostawy, `zwrot dostawy ${w.id}`) : 0);
    wynik.push({
      id: w.id, zamowienieId: w.zamowienie_id, dzien: w.data, kanal: kanalOms(w, reguly.klasyfikacja),
      bruttoGrosze, nettoGrosze: nettoZamowieniaGrosze(bruttoGrosze, klient.email, reguly.klienciWdt),
    });
  }
  return wynik;
}

function pozycjeSurowe(db, zamowienieId) {
  return db.prepare(
    'SELECT id, zrodlo_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo FROM pozycje WHERE zamowienie_id = ?',
  ).all(zamowienieId);
}

function doRankingu(pozycje, zamowienieId) {
  return pozycje.map((p) => ({
    nazwa: p.nazwa, ilosc: p.ilosc, typ: 1,
    bruttoGrosze: grosze(p.brutto_linii ?? '0.00', `pozycja ${zamowienieId}`),
  }));
}

export function inicjalizujGraniceBezHistorii(db, kanal, doDnia, klasyfikacja) {
  wymagajKlasyfikacji(klasyfikacja);
  if (!klasyfikacja.raporty.has(kanal)) throw new Error('Nieznany kanał raportowy');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doDnia) || new Date(doDnia + 'T00:00:00Z').toISOString().slice(0,10) !== doDnia) throw new Error('Niepoprawny dzień granicy');
  if ([...klasyfikacja.konta.values()].includes(kanal)) throw new Error('Kanał ma skonfigurowaną historię; wymaga pomiaru granicy');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (granice(db).has(kanal)) throw new Error('Granica już istnieje; inicjalizacja odmawia nadpisania');
    if (db.prepare('SELECT COUNT(*) AS ile FROM sprzedaz_historyczna').get().ile > 0) throw new Error('Baza zawiera historię; granica wymaga pomiaru');
    const wiersze = db.prepare('SELECT ' + KOLUMNY_KLASYFIKACJI.join(', ') + ', utworzone_at FROM zamowienia').all();
    for (const w of wiersze) {
      if (kanalOms(w, klasyfikacja) !== kanal) continue;
      const dzien=dzienWarszawa(w.utworzone_at);
      if (!dzien || dzien <= doDnia) throw new Error('Granica musi poprzedzać pierwszy dzień sprzedaży OMS');
    }
    db.prepare('INSERT INTO granice_historii (kanal,do_dnia,zrodlo,uwaga) VALUES (?,?,?,?)').run(kanal,doDnia,'oms-bez-historii','Jawna jednorazowa inicjalizacja');
    db.exec('COMMIT');
  } catch(e) {db.exec('ROLLBACK');throw e;}
}

function sprawdzGraniceBezHistorii(db, klasyfikacja) {
  const kanaly = new Set(db.prepare("SELECT kanal FROM granice_historii WHERE zrodlo = 'oms-bez-historii'").all().map(w => w.kanal));
  if (!kanaly.size) return;
  for (const w of historiaWOknie(db, '0000-01-01', '9999-12-31')) {
    const kanal = kanalHistoryczny(w, klasyfikacja);
    if (kanaly.has(kanal)) {
      const e = new Error(`Kanał ${kanal} ma granicę oms-bez-historii, ale zawiera zaimportowaną historię. Wymagany pomiar i jawne uzgodnienie granicy.`);
      e.dlaOperatora = true;
      throw e;
    }
  }
}

const JAK_ZALOZYC_GRANICE = ' Granicę kanału bez zaimportowanej historii zakłada polecenie na serwerze OMS:'
  + ' sudo sh /opt/oms/aktualizuj.sh compose exec -T oms node scripts/produkcja-pierwszy-start.mjs --granice'
  + ' (instrukcja instalacji, sekcja 9 „Integracje po kolei”; dzień granicy liczy samo: dzień przed datą z linii PREFIKS_OD kanału albo wczoraj).'
  + ' Kanał z zaimportowaną historią (OMS_HISTORIA_KLASYFIKACJA) to polecenie pomija — jego granicę trzeba ustalić pomiarem.'
  + ' Sprawdź też, czy po zmianie raportu nie pozostała osierocona granica starego identyfikatora.';
