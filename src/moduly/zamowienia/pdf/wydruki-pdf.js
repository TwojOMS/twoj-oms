import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { bladOperatora } from '../../../domena/bledy.js';

// Wydruki WEWNETRZNE z menu „Wydruki" (PRZ-084): „Lista produktów" (jednego zamowienia albo
// zbiorcza do zaznaczonych) i „Zestawienie zamówień" (na wzor „order-shipping" z Apilo).
// Kartki dla pakujacego, nie dla klienta — dlatego bez danych sprzedawcy i bez stopki
// „nie jest faktura" ze specyfikacji, za to z numerem strony „X/Y" na kazdej kartce
// (rozsypany plik ma sie dac poskladac).
//
// ⚠️ TEN MODUL TYLKO RYSUJE. Wiersze listy sklada domain/lista-produktow.js, dane zestawienia
// domain/zestawienie-zamowien.js — kwoty przychodza juz policzone przez funkcje specyfikacji.
//
// ⚠️ Fonty: TE SAME pliki DejaVu, co specyfikacja (pdf/fonty). Wbudowana Helvetica nie ma
// polskich znakow i pdfkit gubi je PO CICHU — kazdy napis idzie przez zwykly()/gruby().

const KATALOG = path.dirname(fileURLToPath(import.meta.url));
const FONT = 'DejaVu';
const FONT_GRUBY = 'DejaVu-Bold';
const PLIKI_FONTOW = {
  [FONT]: path.join(KATALOG, 'fonty', 'DejaVuSans.ttf'),
  [FONT_GRUBY]: path.join(KATALOG, 'fonty', 'DejaVuSans-Bold.ttf'),
};

const MARGINES = 36;
const A4_SZER = 595.28;
const L = MARGINES;
const R = A4_SZER - MARGINES;
const CZARNY = '#1a1a1a';
const SZARY_TEKST = '#666666';
const SZARY_TLO = '#eeeeee';
const SZARY_LINIA = '#999999';
const REZERWA_STOPKI = 24;

const zwykly = (doc, r = 9, kolor = CZARNY) => doc.font(FONT).fontSize(r).fillColor(kolor);
const gruby = (doc, r = 9, kolor = CZARNY) => doc.font(FONT_GRUBY).fontSize(r).fillColor(kolor);
const dolnaGranica = (doc) => doc.page.height - MARGINES - REZERWA_STOPKI;
const kwota = (zl) => (zl == null || zl === '' ? '' : `${zl} PLN`);

/** „1 zamówienie", „3 zamówienia", „5 zamówień", „22 zamówienia", „12 zamówień". */
export function ileZamowien(n) {
  const d = n % 10;
  const s = n % 100;
  if (n === 1) return '1 zamówienie';
  if (d >= 2 && d <= 4 && !(s >= 12 && s <= 14)) return `${n} zamówienia`;
  return `${n} zamówień`;
}

function noweDoc(tytul) {
  const doc = new PDFDocument({
    size: 'A4',
    // Strony w pamieci do `end()` — numer „str. X/Y" znamy dopiero po narysowaniu calosci.
    bufferPages: true,
    margins: {
      top: MARGINES, bottom: MARGINES, left: MARGINES, right: MARGINES,
    },
    info: { Title: tytul, Author: 'Twój OMS' },
  });
  for (const [nazwa, plik] of Object.entries(PLIKI_FONTOW)) doc.registerFont(nazwa, plik);
  doc.font(FONT);
  return doc;
}

// Stopka na KAZDEJ stronie, po narysowaniu calosci (ta sama konstrukcja i ten sam powod, co
// w specyfikacja-pdf.js: przebieg po stronach, ktore naprawde powstaly, nie pamietanie
// o stopce przy kazdym `addPage()`).
function bajty(doc, tytul, wydrukowano) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i += 1) {
    doc.switchToPage(i);
    const dolny = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    zwykly(doc, 7.5, SZARY_TEKST).text(
      `${tytul}${wydrukowano ? ` · wydrukowano ${wydrukowano}` : ''}`,
      L, doc.page.height - 28, { lineBreak: false },
    );
    const strona = `str. ${i - start + 1}/${count}`;
    doc.text(strona, R - doc.widthOfString(strona), doc.page.height - 28, { lineBreak: false });
    doc.page.margins.bottom = dolny;
  }
  doc.end();
  const kawalki = [];
  for (let k = doc.read(); k !== null; k = doc.read()) kawalki.push(k);
  return Buffer.concat(kawalki);
}

/**
 * Wiersz tabeli o kolumnach z zawijaniem. Wysokosc LICZONA (`heightOfString`) dla kazdej
 * komorki — nazwa produktu i lista zamowien potrafia zajac kilka linii. Zwraca nowe `y`.
 * `kol`: `{ x, w, align, gruby }`; `wartosci`: napisy w kolejnosci kolumn.
 */
function wysokoscWiersza(doc, kolumny, wartosci, rozmiar) {
  let maks = 0;
  kolumny.forEach((k, i) => {
    (k.gruby ? gruby : zwykly)(doc, rozmiar);
    maks = Math.max(maks, doc.heightOfString(String(wartosci[i] ?? ''), { width: k.w - 6 }));
  });
  return maks + 7;
}

function rysujWiersz(doc, y, kolumny, wartosci, { rozmiar = 9, tlo = null, naglowek = false } = {}) {
  const wys = wysokoscWiersza(doc, kolumny, wartosci, rozmiar);
  if (tlo) doc.rect(L, y, R - L, wys).fillColor(tlo).fill();
  kolumny.forEach((k, i) => {
    (naglowek || k.gruby ? gruby : zwykly)(doc, rozmiar);
    doc.text(String(wartosci[i] ?? ''), k.x + 3, y + 3.5, { width: k.w - 6, align: k.align ?? 'left' });
  });
  doc.lineWidth(0.5).strokeColor(SZARY_LINIA);
  doc.rect(L, y, R - L, wys).stroke();
  for (const k of kolumny.slice(1)) doc.moveTo(k.x, y).lineTo(k.x, y + wys).stroke();
  return y + wys;
}

// ───────────────────────────── Lista produktów ─────────────────────────────

const KOL_LISTY_WIELU = [
  { klucz: 'ptaszek', x: L, w: 22 },
  { klucz: 'ilosc', x: L + 22, w: 42, align: 'right', gruby: true },
  { klucz: 'nazwa', x: L + 64, w: 205 },
  { klucz: 'sku', x: L + 269, w: 92 },
  { klucz: 'zamowienia', x: L + 361, w: R - (L + 361) },
];
const KOL_LISTY_JEDNEGO = [
  { klucz: 'ptaszek', x: L, w: 22 },
  { klucz: 'ilosc', x: L + 22, w: 42, align: 'right', gruby: true },
  { klucz: 'nazwa', x: L + 64, w: 300 },
  { klucz: 'sku', x: L + 364, w: R - (L + 364) },
];
const NAGLOWKI_LISTY = {
  ptaszek: '✓', ilosc: 'Ilość', nazwa: 'Produkt', sku: 'SKU', zamowienia: 'W zamówieniach',
};

/** „WO261000002 ×2, WO261000004" — krotnosc tylko, gdy wieksza niz 1. */
export function opisZamowienWiersza(zamowienia = []) {
  return zamowienia.map((x) => (x.ilosc > 1 ? `${x.numer} ×${x.ilosc}` : x.numer)).join(', ');
}

function pustePole(doc, x, y) {
  doc.lineWidth(0.8).strokeColor(CZARNY).rect(x + 6, y + 4, 9, 9).stroke();
}

/**
 * Lista produktow jako PDF. Wejscie: ksztalt `listaProduktowZbiorcza` (domain/lista-produktow.js)
 * — `numery`, `wiersze` (`ilosc`, `nazwa`, `sku`, `zamowienia`), `razemPozycji`, `razemSztuk`.
 * Przy JEDNYM zamowieniu kolumna „W zamówieniach" znika (bylaby ta sama w kazdym wierszu).
 * ⚠️ Zadnej kwoty i zadnych danych klienta — wejscie ich nie niesie.
 */
export async function zbudujListeProduktowPdf(lista, { wydrukowano = '' } = {}) {
  const numery = lista?.numery ?? [];
  if (!numery.length) throw bladOperatora('Brak zamówień do listy produktów.');
  const jedno = numery.length === 1;
  const kolumny = jedno ? KOL_LISTY_JEDNEGO : KOL_LISTY_WIELU;
  const tytul = jedno ? `Lista produktów — zamówienie ${numery[0]}` : `Lista produktów — ${ileZamowien(numery.length)}`;
  const doc = noweDoc(tytul);

  gruby(doc, 16).text('Lista produktów', L, MARGINES);
  let y = doc.y + 2;
  zwykly(doc, 9.5);
  const podtytul = jedno ? `Zamówienie nr ${numery[0]}` : `Zamówienia (${numery.length}): ${numery.join(', ')}`;
  doc.text(podtytul, L, y, { width: R - L });
  y = doc.y + 10;

  const naglowek = (yy) => rysujWiersz(doc, yy, kolumny, kolumny.map((k) => NAGLOWKI_LISTY[k.klucz]), { tlo: SZARY_TLO, naglowek: true });
  const wiersze = lista?.wiersze ?? [];
  if (!wiersze.length) {
    zwykly(doc, 10).text(
      jedno ? 'To zamówienie nie ma produktów do spakowania.' : 'Zaznaczone zamówienia nie mają produktów do spakowania.',
      L, y, { width: R - L },
    );
    return bajty(doc, tytul, wydrukowano);
  }

  y = naglowek(y);
  for (const w of wiersze) {
    const wartosci = kolumny.map((k) => ({
      ptaszek: '', ilosc: w.ilosc, nazwa: w.nazwa, sku: w.sku ?? '', zamowienia: opisZamowienWiersza(w.zamowienia),
    })[k.klucz]);
    if (y + wysokoscWiersza(doc, kolumny, wartosci, 10) > dolnaGranica(doc)) {
      doc.addPage();
      y = naglowek(MARGINES);
    }
    const yWiersza = y;
    y = rysujWiersz(doc, y, kolumny, wartosci, { rozmiar: 10 });
    pustePole(doc, L, yWiersza);
  }

  if (y + 20 > dolnaGranica(doc)) { doc.addPage(); y = MARGINES; }
  gruby(doc, 10).text(`Razem pozycji: ${lista.razemPozycji} · sztuk: ${lista.razemSztuk}`, L, y + 8, { width: R - L, align: 'right' });
  return bajty(doc, tytul, wydrukowano);
}

// ───────────────────────────── Zestawienie zamówień ─────────────────────────────

const KOL_ZESTAWIENIA = [
  { klucz: 'lp', x: L, w: 26 },
  { klucz: 'nazwa', x: L + 26, w: 232 },
  { klucz: 'sku', x: L + 258, w: 82 },
  { klucz: 'ilosc', x: L + 340, w: 40, align: 'right' },
  { klucz: 'cena', x: L + 380, w: 64, align: 'right' },
  { klucz: 'suma', x: L + 444, w: R - (L + 444), align: 'right' },
];
const NAGLOWKI_ZESTAWIENIA = ['Lp.', 'Nazwa', 'SKU', 'Ilość', 'Cena', 'Suma'];

function naglowekZamowienia(z) {
  return [
    z.kanal,
    z.numerWKanale,
    z.platnosc ? `Płatność: ${z.platnosc}` : '',
    z.dataZamowienia ? `Data zamówienia: ${z.dataZamowienia}` : '',
    `Faktura: ${z.fakturaWybrana ? 'Tak' : 'Nie'}`,
  ].filter(Boolean).join(' | ');
}

function rysujZamowienie(doc, z, lp, yStart) {
  let y = yStart;
  const opis = naglowekZamowienia(z);
  const glowa = `${lp}.  ${z.numer}`;
  // Glowa bloku + dane wysylki + naglowek tabeli + pierwszy wiersz musza stac RAZEM —
  // samotny numer zamowienia na dole strony to kartka, ktorej nikt nie dopasuje do paczki.
  zwykly(doc, 8.5);
  const wysOpisu = doc.heightOfString(opis, { width: R - L - 8 });
  const wysWysylki = doc.heightOfString(`Dane wysyłki: ${z.wysylka.join(' | ')}`, { width: R - L - 8 });
  if (y + 20 + wysOpisu + wysWysylki + 50 > dolnaGranica(doc)) { doc.addPage(); y = MARGINES; }

  const yBloku = y;
  gruby(doc, 12).text(glowa, L + 4, y + 4, { lineBreak: false });
  y += 21;
  zwykly(doc, 8.5).text(opis, L + 4, y, { width: R - L - 8 });
  y = doc.y + 3;
  gruby(doc, 8.5).text('Dane wysyłki: ', L + 4, y, { continued: true });
  zwykly(doc, 8.5).text(z.wysylka.join(' | ') || '—', { width: R - L - 8 });
  y = doc.y + 4;
  doc.lineWidth(0.8).strokeColor(SZARY_LINIA).rect(L, yBloku, R - L, y - yBloku).stroke();

  const naglowek = (yy) => rysujWiersz(doc, yy, KOL_ZESTAWIENIA, NAGLOWKI_ZESTAWIENIA, { tlo: SZARY_TLO, naglowek: true, rozmiar: 8.5 });
  y = naglowek(y);
  z.pozycje.forEach((p, i) => {
    const wartosci = [`${i + 1}.`, p.nazwa, p.sku || '-', `${p.ilosc}`, kwota(p.cenaZl), kwota(p.wartoscZl)];
    if (y + wysokoscWiersza(doc, KOL_ZESTAWIENIA, wartosci, 8.5) > dolnaGranica(doc)) {
      doc.addPage();
      zwykly(doc, 8, SZARY_TEKST).text(`${z.numer} — ciąg dalszy`, L, MARGINES, { lineBreak: false });
      y = naglowek(MARGINES + 14);
    }
    y = rysujWiersz(doc, y, KOL_ZESTAWIENIA, wartosci, { rozmiar: 8.5 });
  });

  // Kwota i uwagi klienta — wysokosc uwag LICZONA, klient potrafi wkleic akapit.
  zwykly(doc, 8.5);
  const uwagi = z.uwagiKlienta ? `Uwagi do zamówienia: ${z.uwagiKlienta}` : '';
  const wysUwag = uwagi ? doc.heightOfString(uwagi, { width: 330 }) : 0;
  const wysStopki = Math.max(wysUwag, 12) + 10;
  if (y + wysStopki > dolnaGranica(doc)) {
    doc.addPage();
    zwykly(doc, 8, SZARY_TEKST).text(`${z.numer} — ciąg dalszy`, L, MARGINES, { lineBreak: false });
    y = MARGINES + 14;
  }
  if (uwagi) zwykly(doc, 8.5).text(uwagi, L + 4, y + 5, { width: 330 });
  const napisKwoty = `Kwota: ${kwota(z.razemZl)}`;
  gruby(doc, 9.5).text(napisKwoty, R - 4 - doc.widthOfString(napisKwoty), y + 5, { lineBreak: false });
  doc.lineWidth(0.5).strokeColor(SZARY_LINIA).rect(L, y, R - L, wysStopki).stroke();
  return y + wysStopki + 16;
}

/**
 * Zestawienie zamowien — bloki jeden pod drugim, ciagiem (jak w Apilo), NIE strona na
 * zamowienie. Wejscie: lista ksztaltow `daneZestawienia` (domain/zestawienie-zamowien.js).
 */
export async function zbudujZestawieniePdf(listaDanych = [], { wydrukowano = '' } = {}) {
  if (!Array.isArray(listaDanych) || !listaDanych.length) {
    throw bladOperatora('Brak zamówień do zestawienia.');
  }
  const tytul = listaDanych.length === 1
    ? `Zestawienie zamówień — ${listaDanych[0].numer}`
    : `Zestawienie zamówień — ${ileZamowien(listaDanych.length)}`;
  const doc = noweDoc(tytul);
  let y = MARGINES;
  listaDanych.forEach((z, i) => { y = rysujZamowienie(doc, z, i + 1, y); });
  return bajty(doc, tytul, wydrukowano);
}
