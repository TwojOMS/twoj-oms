import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

// Generator PDF-a „Potwierdzenia wywozu towarów" (art. 42 ust. 4 ustawy o VAT) — dokument
// do podpisu przez NABYWCE, wysylany razem z faktura WDT i odsylany podpisany. Uklad
// kalkuje specyfikacja-pdf.js (te same stale, fonty i pomocnicze zwykly()/gruby()), bo
// klient dostaje oba dokumenty w jednej paczce.
//
// ⚠️ TEN MODUL TYLKO RYSUJE — dane sklada domain/oswiadczenie-wywozu.js. Zadnych kwot:
// dokument jest ILOSCIOWY (uzasadnienie przy modelu).
//
// ⚠️ Fonty: wylacznie DejaVu przez zwykly()/gruby() — wbudowane fonty PDF nie maja
// polskich znakow i psuja sie BEZ ostrzezenia (ta sama pulapka, co w specyfikacji).

const KATALOG = path.dirname(fileURLToPath(import.meta.url));
const FONT = 'DejaVu';
const FONT_GRUBY = 'DejaVu-Bold';
const PLIKI_FONTOW = {
  [FONT]: path.join(KATALOG, 'fonty', 'DejaVuSans.ttf'),
  [FONT_GRUBY]: path.join(KATALOG, 'fonty', 'DejaVuSans-Bold.ttf'),
};

const A4_SZER = 595.28;
const MARGINES = 40;
const L = MARGINES;
const R = A4_SZER - MARGINES;
const PRAWA_KOLUMNA = 320;

const CZARNY = '#1a1a1a';
const SZARY_TEKST = '#666666';
const SZARY_PASEK = '#c9c9c9';
const SZARY_WIERSZ = '#eeeeee';
const SZARY_LINIA = '#cccccc';

// Lamanie strony: ponizej tej linii tabela przechodzi na strone kontynuacji. Blok podpisow
// potrzebuje ~200 pt — pilnuje tego `zapewnijMiejsce`.
const DOL_TRESCI = 780;

const KOLUMNY = {
  lp: { x: L, w: 30, align: 'right' },
  nazwa: { x: 86, w: 360, align: 'left' },
  ilosc: { x: 470, w: R - 470, align: 'right' },
};

function zwykly(doc, rozmiar = 9, kolor = CZARNY) {
  return doc.font(FONT).fontSize(rozmiar).fillColor(kolor);
}

function gruby(doc, rozmiar = 9, kolor = CZARNY) {
  return doc.font(FONT_GRUBY).fontSize(rozmiar).fillColor(kolor);
}

function linia(doc, y) {
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(SZARY_LINIA).stroke();
}

// Naglowek sekcji — identyczny z specyfikacja-pdf.js (szary pasek + kapitaliki).
function naglowekSekcji(doc, x, y, tekst) {
  const DUZA = 12;
  const MALA = 9;
  doc.rect(x, y + 4, 28, 6).fillColor(SZARY_PASEK).fill();
  const napis = String(tekst);
  zwykly(doc, DUZA).text(napis.slice(0, 1).toUpperCase(), x + 34, y, { lineBreak: false });
  const szerPierwszej = doc.widthOfString(napis.slice(0, 1).toUpperCase());
  zwykly(doc, MALA).text(
    napis.slice(1).toUpperCase(),
    x + 34 + szerPierwszej,
    y + (DUZA - MALA) * 0.72,
    { lineBreak: false },
  );
  return y + DUZA + 8;
}

function blokSekcja(doc, x, y, szerokosc, tytul, linieTekstu) {
  let biezace = naglowekSekcji(doc, x, y, tytul);
  zwykly(doc, 9);
  for (const l of linieTekstu) {
    doc.text(l, x, biezace, { width: szerokosc });
    biezace += Math.max(doc.heightOfString(l, { width: szerokosc }), 12) + 1;
  }
  return biezace;
}

function komorka(doc, tekst, kol, y) {
  const napis = String(tekst ?? '');
  const szer = doc.widthOfString(napis);
  const x = kol.align === 'right' ? kol.x + kol.w - szer : kol.x;
  doc.text(napis, x, y, { lineBreak: false });
}

function naglowekTabeli(doc, y) {
  gruby(doc, 8.5);
  doc.text('Lp.', KOLUMNY.lp.x, y, { width: KOLUMNY.lp.w, align: 'right', lineBreak: false });
  doc.text('Nazwa towaru', KOLUMNY.nazwa.x, y, { width: KOLUMNY.nazwa.w, lineBreak: false });
  doc.text('Ilość', KOLUMNY.ilosc.x, y, { width: KOLUMNY.ilosc.w, align: 'right', lineBreak: false });
  const dol = y + 14;
  linia(doc, dol);
  return dol + 6;
}

// Stopka na kazdej stronie — bez niej strona kontynuacji to anonimowa kartka z towarem,
// a dokument bez tego zdania nie mowi, CZYM jest (ta sama zasada, co w specyfikacji).
function stopka(doc, numerZamowienia, nazwaSprzedawcy) {
  const dolny = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  zwykly(doc, 8, SZARY_TEKST).text(
    `Dowód, o którym mowa w art. 42 ust. 4 ustawy o VAT (WDT) — zamówienie nr ${numerZamowienia}.`,
    L,
    doc.page.height - 50,
    { width: R - L },
  );
  zwykly(doc, 8, SZARY_TEKST).text(
    `Wystawiono w panelu zamówień${nazwaSprzedawcy ? ` ${nazwaSprzedawcy}` : ''}`,
    L,
    doc.page.height - 36,
    { width: R - L, lineBreak: false },
  );
  doc.page.margins.bottom = dolny;
}

function stopkaNaKazdejStronie(doc, numerZamowienia, nazwaSprzedawcy) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i += 1) {
    doc.switchToPage(i);
    stopka(doc, numerZamowienia, nazwaSprzedawcy);
  }
}

function nowaStronaKontynuacji(doc, model, stan) {
  doc.addPage();
  stan.strona += 1;
  const y = MARGINES;
  gruby(doc, 9).text(
    `Potwierdzenie wywozu towarów — zamówienie nr ${model.zamowienieNumer} — str. ${stan.strona}`,
    L,
    y,
    { width: R - L, lineBreak: false },
  );
  linia(doc, y + 13);
  return y + 20;
}

// Miejsce na blok, ktory NIE MOZE zostac przelamany (podpisy): gdy go brakuje, blok
// zaczyna sie na nowej stronie kontynuacji.
function zapewnijMiejsce(doc, model, stan, y, potrzebne) {
  return y + potrzebne > DOL_TRESCI ? nowaStronaKontynuacji(doc, model, stan) : y;
}

// Linia do recznego uzupelnienia: etykieta + kropki do prawej krawedzi.
function poleDoWypelnienia(doc, y, etykieta, { odX = L, doX = R } = {}) {
  zwykly(doc, 9.5);
  doc.text(etykieta, odX, y, { lineBreak: false });
  const zaEtykieta = odX + doc.widthOfString(etykieta) + 6;
  doc.moveTo(zaEtykieta, y + 10).lineTo(doX, y + 10).lineWidth(0.5).strokeColor(SZARY_LINIA)
    .dash(2, { space: 2 }).stroke().undash();
  return y + 22;
}

/**
 * Bajty gotowego PDF-a „Potwierdzenia wywozu towarów" — wejscie WYLACZNIE z
 * `modelOswiadczenia` (domain/oswiadczenie-wywozu.js).
 */
export function zbudujOswiadczenieWywozuPdf(model) {
  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: true,
    margins: {
      top: MARGINES, bottom: MARGINES, left: MARGINES, right: MARGINES,
    },
    info: { Title: `Potwierdzenie wywozu — zamówienie ${model.zamowienieNumer}`, Author: model.sprzedawca?.nazwa ?? 'Twój OMS' },
  });
  for (const [nazwa, plik] of Object.entries(PLIKI_FONTOW)) doc.registerFont(nazwa, plik);
  doc.font(FONT);

  const stan = { strona: 1 };
  let y = 48;
  gruby(doc, 16).text('Potwierdzenie wywozu towarów', L, y, { width: R - L, align: 'center' });
  y += 24;
  zwykly(doc, 9.5, SZARY_TEKST).text(
    'wewnątrzwspólnotowa dostawa towarów — dowód z art. 42 ust. 4 ustawy o VAT',
    L,
    y,
    { width: R - L, align: 'center' },
  );
  y += 26;

  zwykly(doc, 10).text(`Zamówienie nr ${model.zamowienieNumer}`, L, y, { width: 260, lineBreak: false });
  gruby(doc, 10).text(
    model.fakturaNumer ? `Faktura nr ${model.fakturaNumer}` : 'Faktura: (numer uzupełnić po wystawieniu)',
    PRAWA_KOLUMNA,
    y,
    { width: R - PRAWA_KOLUMNA, align: 'right', lineBreak: false },
  );
  y += 16;
  if (model.dzis) {
    zwykly(doc, 9, SZARY_TEKST).text(`Wystawiono: ${model.dzis}`, L, y, { lineBreak: false });
    y += 14;
  }
  linia(doc, y);
  y += 12;

  const dolSprzedawcy = blokSekcja(doc, L, y, PRAWA_KOLUMNA - L - 20, 'Dostawca', [
    model.sprzedawca.nazwa, ...model.sprzedawca.adres, `NIP: ${model.sprzedawca.nip}`,
  ]);
  const dolNabywcy = blokSekcja(doc, PRAWA_KOLUMNA, y, R - PRAWA_KOLUMNA, 'Nabywca', [
    model.nabywca.nazwa, ...model.nabywca.adres, `NIP: ${model.nabywca.nip}`,
  ]);
  y = Math.max(dolSprzedawcy, dolNabywcy) + 14;

  y = naglowekSekcji(doc, L, y, 'Towary objęte dostawą');
  y += 2;
  y = naglowekTabeli(doc, y);
  model.pozycje.forEach((p, i) => {
    zwykly(doc, 9);
    const wysNazwy = doc.heightOfString(String(p.nazwa ?? ''), { width: KOLUMNY.nazwa.w });
    const wys = Math.max(wysNazwy, 11) + 8;
    if (y + wys > DOL_TRESCI) {
      y = nowaStronaKontynuacji(doc, model, stan);
      y = naglowekTabeli(doc, y);
    }
    if (i % 2 === 1) {
      doc.rect(L, y - 3, R - L, wys).fillColor(SZARY_WIERSZ).fill();
    }
    zwykly(doc, 9);
    komorka(doc, `${p.lp}.`, KOLUMNY.lp, y);
    doc.text(String(p.nazwa ?? ''), KOLUMNY.nazwa.x, y, { width: KOLUMNY.nazwa.w });
    komorka(doc, p.ilosc, KOLUMNY.ilosc, y);
    y += wys;
  });
  linia(doc, y + 2);
  y += 16;

  // Blok oswiadczenia w CALOSCI na jednej stronie — przelamany w polowie bylby dokumentem,
  // ktorego podpis stoi na kartce bez tresci oswiadczenia.
  y = zapewnijMiejsce(doc, model, stan, y, 210);
  y = naglowekSekcji(doc, L, y, 'Oświadczenie nabywcy');
  y += 2;
  zwykly(doc, 9.5);
  const oswiadczenie = `Potwierdzam, że towary wymienione powyżej zostały wywiezione z terytorium `
    + `Polski i przyjęte na terytorium ${model.panstwo} (państwa członkowskiego innego niż `
    + 'Polska). Adres, pod który przewieziono towary — adres nabywcy powyżej, chyba że wskazano inny:';
  doc.text(oswiadczenie, L, y, { width: R - L });
  y += doc.heightOfString(oswiadczenie, { width: R - L }) + 8;

  y = poleDoWypelnienia(doc, y, 'Inny adres dostarczenia (jeśli dotyczy):');
  y = poleDoWypelnienia(doc, y, 'Miejsce i data przyjęcia towarów:');
  y = poleDoWypelnienia(doc, y, 'Rodzaj środka transportu:', { doX: PRAWA_KOLUMNA - 20 });
  y = poleDoWypelnienia(doc, y - 22, 'Nr rejestracyjny:', { odX: PRAWA_KOLUMNA, doX: R });
  y += 16;
  y = poleDoWypelnienia(doc, y, 'Data i czytelny podpis nabywcy:', { doX: PRAWA_KOLUMNA - 20 });

  stopkaNaKazdejStronie(doc, model.zamowienieNumer, model.sprzedawca?.nazwa);
  doc.end();
  const kawalki = [];
  for (let k = doc.read(); k !== null; k = doc.read()) kawalki.push(k);
  return Buffer.concat(kawalki);
}
