// PRZ-160 P3b.03 (punkt 19) — import produktów z JEDNEGO kanału: plan („Sprawdź") i wykonanie („Importuj").
//
// Plan liczy się z lustra `produkty_sklepowe` po odczycie katalogu tego kanału i NICZEGO nie zapisuje.
// Wykonanie liczy plan jeszcze raz W TRANSAKCJI (lustro mogło się zmienić między kliknięciami) i robi tylko
// to, co wybrany typ pozwala: wiąże po SKU, tworzy karty, przepisuje treść. Pola ręczne chroni
// `karty_zrodla_pol` (`zapiszTrescWoo`, `pobierzTrescOfertAllegro`) — ten plik ich nie omija.
import { kartaZeSku, szukajkaKartDoImportu, utworzKarte, powiazProdukt } from '../../../oms/db/magazyn.js';
import { kartaZProduktu, powodPominiecia } from '../../../domena/karta-z-produktu.js';
import { zapiszTrescWoo } from './woo-tresc-kart.js';
import { kolejka } from './allegro-tresc-kart.js';

// Kolejność = kolejność na ekranie. `wiaze` — łączy wiersz z kartą o tym samym SKU; `tworzy` — zakłada kartę,
// gdy takiej nie ma; `aktualizuje` — przepisuje treść do kart już powiązanych.
export const TYPY_IMPORTU = Object.freeze([
  { klucz: 'powiaz', nazwa: 'Produkty są już w magazynie — tylko powiąż je z tym kanałem',
    opis: 'Łączy po SKU z istniejącymi kartami. Nie tworzy kart i nie zmienia ich treści.',
    wiaze: true, tworzy: false, aktualizuje: false },
  { klucz: 'czesc', nazwa: 'Część produktów jest w magazynie — powiąż istniejące i utwórz brakujące',
    opis: 'Łączy po SKU, a dla produktów bez karty zakłada nową. Treści istniejących kart nie zmienia.',
    wiaze: true, tworzy: true, aktualizuje: false },
  { klucz: 'pelny', nazwa: 'Pobierz nowe i zaktualizuj istniejące',
    opis: 'Łączy, zakłada brakujące karty i przepisuje treść z kanału. Pola wpisane ręcznie zostają.',
    wiaze: true, tworzy: true, aktualizuje: true },
  { klucz: 'aktualizuj', nazwa: 'Tylko zaktualizuj wcześniej zaimportowane',
    opis: 'Przepisuje treść do kart już powiązanych z tym kanałem. Nowych nie łączy i nie zakłada.',
    wiaze: false, tworzy: false, aktualizuje: true },
  { klucz: 'nowe', nazwa: 'Tylko pobierz nowe (bez aktualizacji)',
    opis: 'Zakłada karty dla produktów, których w magazynie nie ma. Istniejących kart nie rusza.',
    wiaze: false, tworzy: true, aktualizuje: false },
]);

export const typImportu = (klucz) => TYPY_IMPORTU.find((t) => t.klucz === klucz) ?? null;

const POWOD_BEZ_KARTY = 'nie ma karty z tym SKU — powiąż ręcznie albo wybierz typ, który tworzy karty';
const POWOD_NIEZAIMPORTOWANY = 'nie był wcześniej zaimportowany — ten typ tylko aktualizuje powiązane';
const POWOD_JEST_KARTA = 'karta z tym SKU już jest — ten typ tylko zakłada nowe';
const POWOD_KILKA_KART = 'kilka kart z tym SKU — powiąż ręcznie';

// Wiersze lustra WYŁĄCZNIE wybranego kanału. To zawężenie jest treścią „część": drugi kanał zostaje nietknięty.
const wierszeKanalu = (db, kanal) => db.prepare('SELECT * FROM produkty_sklepowe WHERE kanal = ? AND zniknal_at IS NULL ORDER BY id').all(kanal);

/**
 * Plan importu jednego kanału. Czyta, nie zapisuje.
 * @param {object} db
 * @param {{kanal: string, typ: object, kanalyZrodlowe: string[], allegro: boolean,
 *   tresc?: Array<{id: number}>}} p — `tresc`: treść Woo z odczytu „Sprawdź" (id wiersza lustra)
 */
export function planImportu(db, { kanal, typ, kanalyZrodlowe, allegro, tresc = [] }) {
  const powiaz = [];
  const utworz = [];
  const pominiete = [];
  const doAktualizacji = new Set();
  const nowychSku = new Set();
  const zTrescia = new Set(tresc.map((t) => t.id));
  let juzPowiazane = 0;
  const kartaDoImportu = szukajkaKartDoImportu(db);

  for (const w of wierszeKanalu(db, kanal)) {
    if (w.karta_id !== null && w.karta_id !== undefined) {
      juzPowiazane += 1;
      if (typ.aktualizuje && !allegro && zTrescia.has(w.id)) doAktualizacji.add(w.karta_id);
      continue;
    }
    if (!typ.wiaze && !typ.tworzy) { pominiete.push({ id: w.id, nazwa: w.nazwa, powod: POWOD_NIEZAIMPORTOWANY }); continue; }
    const sku = String(w.sku_sklepu ?? '').trim();
    // Drugi wiersz z SKU, dla którego ten import zakłada kartę: wiąże się z nią (każdy typ, który tworzy — to nie
    // jest „istniejąca karta"). Wykonanie bierze jej id z mapy `nowychKart` (karta powstaje dopiero w wykonaniu).
    if (sku && nowychSku.has(sku)) { powiaz.push({ id: w.id, sku, zNowejKarty: true }); continue; }
    // P4.03 (punkt 24): karta po `karty_produktow.sku` albo po powiązanym lustrze innego kanału — tylko jedna.
    const znaleziona = kartaDoImportu(sku);
    if (znaleziona?.kilka) { pominiete.push({ id: w.id, nazwa: w.nazwa, powod: POWOD_KILKA_KART }); continue; }
    const karta = znaleziona?.karta;
    if (karta) {
      if (!typ.wiaze) { pominiete.push({ id: w.id, nazwa: w.nazwa, powod: POWOD_JEST_KARTA }); continue; }
      powiaz.push({ id: w.id, sku, kartaId: karta.id });
      if (typ.aktualizuje && (allegro || zTrescia.has(w.id))) doAktualizacji.add(karta.id);
      continue;
    }
    if (!typ.tworzy) { pominiete.push({ id: w.id, nazwa: w.nazwa, powod: POWOD_BEZ_KARTY }); continue; }
    const powod = powodPominiecia(w, kanalyZrodlowe);
    if (powod) { pominiete.push({ id: w.id, nazwa: w.nazwa, powod }); continue; }
    utworz.push(w);
    if (sku) nowychSku.add(sku);
  }
  // Allegro: treść bierze przebieg „Pobierz treść i zdjęcia ofert" — jego kolejka mówi, które karty dostaną treść.
  if (typ.aktualizuje && allegro) for (const o of kolejka(db, [kanal])) doAktualizacji.add(o.karta_id);

  const powody = new Map();
  for (const p of pominiete) powody.set(p.powod, (powody.get(p.powod) ?? 0) + 1);
  return {
    powiaz, utworz, pominiete, juzPowiazane,
    powody: [...powody].map(([powod, ile]) => ({ powod, ile })),
    liczby: { powiaze: powiaz.length, utworzy: utworz.length, zaktualizuje: doAktualizacji.size, pominie: pominiete.length },
  };
}

/**
 * Wykonanie importu jednego kanału. Wiązanie, karty i treść Woo — w jednej transakcji; treść Allegro rusza
 * po niej w tle (`trescAllegro.start`), zawężona do tego konta (i do nowych kart przy typach bez aktualizacji).
 * @returns {{liczby: object, powody: Array, juzPowiazane: number, nowe: number[], trescAllegro: 'ruszyla'|'zajeta'|'niedostepna'|null}}
 */
export function wykonajImport(db, { kanal, typ, kanalyZrodlowe, allegro, tresc = [], trescAllegro = null, teraz = () => new Date().toISOString() }) {
  const at = teraz();
  const nowe = [];
  let plan;
  db.exec('BEGIN IMMEDIATE');
  try {
    plan = planImportu(db, { kanal, typ, kanalyZrodlowe, allegro, tresc });
    // Najpierw karty, potem wiązanie: wiersz `zNowejKarty` czeka na kartę założoną przez pierwszy wiersz z tym SKU.
    const wierszeNowych = new Set();
    const nowychKart = new Map();
    for (const w of plan.utworz) {
      const sku = String(w.sku_sklepu ?? '').trim();
      // P4.03: nowa karta dostaje SKU wiersza, jeśli żadna karta go nie ma — drugi kanał znajdzie ją po SKU.
      const karta = kartaZProduktu(w);
      if (sku && !kartaZeSku(db, sku)) karta.sku = sku;
      const id = utworzKarte(db, karta, { at });
      powiazProdukt(db, w.id, id);
      nowe.push(id);
      wierszeNowych.add(w.id);
      if (sku) nowychKart.set(sku, id);
    }
    for (const p of plan.powiaz) {
      const kartaId = p.zNowejKarty ? nowychKart.get(p.sku) : p.kartaId;
      if (kartaId === undefined) throw new Error(`import: brak karty dla SKU „${p.sku}" z planu — import wycofany`);
      powiazProdukt(db, p.id, kartaId);
    }
    if (!allegro) {
      for (const t of tresc) {
        if (typ.aktualizuje || wierszeNowych.has(t.id)) zapiszTrescWoo(db, t, t.id, at);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  let stanTresci = null;
  if (allegro && trescAllegro) {
    const zakres = typ.aktualizuje ? (plan.liczby.zaktualizuje > 0 ? { kanaly: [kanal] } : null)
      : (nowe.length ? { kanaly: [kanal], karty: nowe } : null);
    // „zajeta" tylko, gdy przebieg treści naprawdę trwa; konto bez odczytu ofert to „niedostepna".
    if (zakres && trescAllegro.gotowy?.() === false) stanTresci = 'niedostepna';
    else if (zakres) stanTresci = trescAllegro.start(zakres)?.wystartowal ? 'ruszyla' : (trescAllegro.stan?.().trwa ? 'zajeta' : 'niedostepna');
  }
  return { liczby: plan.liczby, powody: plan.powody, juzPowiazane: plan.juzPowiazane, nowe, trescAllegro: stanTresci };
}
