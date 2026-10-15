// Oprawa HTML maili z panelu — marka wyłącznie z jawnych argumentów użytkownika.
// Treść pozostaje plain-textem zatwierdzonym przez człowieka;
// tu tylko ją opakowujemy: wordmark, akapity, tabela wyceny, stopka z ustawień.
// Mail idzie jako multipart/alternative — plain text zostaje nietknięty jako fallback.
//
// Font celowo systemowy (Helvetica/Arial): klienci pocztowi nie ładują webfontów.
// Style wyłącznie inline (Outlook/Gmail wycinają <style> w <head>).

export const KOLOR = {
  tlo: '#F7F3EC',      // Płótno
  karta: '#FFFDFA',
  ramka: '#E4DDD1',
  linia: '#EFE9DD',
  tekst: '#2E2A26',    // Grafit
  muted: '#6D675F',
  // Stal. Kolor rejestru PRO — od 21/22.08.2026 NIE „wyłącznie" wycen: tym samym akcentem
  // idą nagłówki sekcji i kreska sumy w potwierdzeniu przyjęcia zamówienia
  // (potwierdzenie-html.js) oraz w trzech mailach o pieniądzach (wiadomosc-html.js).
  akcent: '#3E5566',
};
export const FONT = 'Helvetica, Arial, sans-serif';

// Czcionka o STAŁEJ SZEROKOŚCI dla wartości, które klient PRZEPISUJE do banku (numer
// rachunku). W czcionce proporcjonalnej cyfry zlewają się w jeden ciąg.
//
// ⚠️ STAŁA, NIE TRZECIA KOPIA LITERAŁU (sprzątanie po recenzji całości gałęzi, 22.08.2026):
// ten sam napis stał wprost w `liniaPudelka` niżej i w tabeli przelewu w wiadomosc-html.js.
export const MONO = "font-family:Consolas,'Courier New',monospace;";

/**
 * NAGŁÓWEK SEKCJI w mailu składanym z modelu — wersaliki, rozstrzelenie, kolor akcentu.
 *
 * ⚠️ JEDNA FUNKCJA NA DWA RENDERERY (22.08.2026): potwierdzenie przyjęcia zamówienia
 * (potwierdzenie-html.js) i trzy maile o pieniądzach (wiadomosc-html.js) miały ją przepisaną
 * znak w znak, każdy u siebie. Dwie kopie tego samego stylu rozjeżdżają się przy pierwszej
 * poprawce palety — a klient dostaje wtedy dwa różne papiery firmowe z jednego panelu.
 *
 * ⚠️⚠️ TRZECIA, PODOBNA WERSJA ZOSTAJE OSOBNO i to jest świadome: nagłówek sekcji w
 * `renderMailHtml` (maile z wyceną) ma INNE rozstrzelenie (2px zamiast 1px), inne marginesy
 * i dodatkowo OBCINA dwukropek z końca linii — bo tam nagłówek nie przychodzi z modelu, tylko
 * jest ROZPOZNAWANY we wpisanym przez człowieka tekście („Dane do przelewu:"). Sklejenie
 * obu zmieniłoby wygląd maili z wyceną, które chodzą na produkcji od tygodni.
 */
export const naglowekSekcji = (tekst) => `<p style="margin:20px 0 6px;font-family:${FONT};font-size:12px;`
  + `font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${KOLOR.akcent};">${esc(tekst)}</p>`;

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Po esc() — URL-e w treści (link do sklepu) muszą być klikalne. Escapowanie najpierw:
// &amp; w href jest POPRAWNYM zapisem & w atrybucie HTML.
function linkify(escaped) {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:${KOLOR.akcent};">${u}</a>`);
}

// Kanoniczne linie wyceny (format buildQuoteText) — rozpoznawane zachowawczo:
// nie pasuje = zwykły akapit, nic nie znika.
const RE_POZYCJA = /^(\d+)x (.+) - ([\d.,]+zł) brutto\/szt$/;
// Dodatki — JEDEN wzorzec „nazwa - wartość", bez względu na to, czy po prawej stoi kwota
// („25zł brutto"), czy słowo („gratis", „w cenie"). Wartość zawsze idzie do własnej komórki,
// wyrównanej do prawej tak samo jak cena produktu.
//
// ⚠️ ZGŁOSZENIE WŁAŚCICIELA (19.08.2026): przy kwocie wiersz wyglądał poprawnie, ale „gratis"
// i „w cenie" były osobnym typem wiersza rozciągniętym na obie kolumny — czyli WYPADAŁY
// z tabeli dokładnie wtedy, gdy nic nie kosztowały. Jeden wzorzec likwiduje ten rozjazd
// u źródła: nie ma już wariantu „bez kwoty", jest wariant „inna wartość po prawej".
const RE_DODATEK = /^(przygotowanie projektu|wysyłka kurierem DPD) - (.+)$/;
const RE_RAZEM = /^Razem: ([\d.,]+zł)(?: \((.+ netto)\))?$/;
// Linia bedaca WYLACZNIE adresem. Razem z linia zakonczona dwukropkiem tuz nad nia tworzy
// PRZYCISK (patrz koniec `buildQuoteText`). Rozpoznanie po SASIEDZTWIE, nie po tresci
// etykiety — dzieki temu dziala takze po zmianie napisu w /settings.
//
// ⚠️ Sam adres w akapicie ma zostac zwyklym linkiem. Bez wymogu linii z dwukropkiem
// KAZDY adres w mailu (np. w danych do przelewu) zamienialby sie w wielki przycisk.
const RE_SAM_ADRES = /^https?:\/\/\S+$/;
// TABELA CZASU REALIZACJI (zgloszenie właściciela 19.08.2026). Osobna tabela, wlasny naglowek —
// otwiera ja dokladnie ta linia (stala NAGLOWEK_REALIZACJA w quote/quote-text.js), a zamyka
// pierwsza linia, ktora nie wyglada jak „opis - kwota". Bez naglowka nie ruszamy niczego:
// wzorzec „cos - cos" trafialby w zwykle zdania z myslnikiem.
const NAGLOWEK_REALIZACJA = 'Czas realizacji:';
const RE_OPCJA = /^(.+?) - (\+?[\d.,]+\s?zł)$/;

// NAGLOWEK SEKCJI (ZAMOWIENIE, ZWROTY, „Dane do przelewu") — krotka linia zakonczona
// dwukropkiem, PONAD ktora stoi pusta linia.
//
// ⚠️ OBA WARUNKI SA KONIECZNE. Bez wymogu pustej linii nad soba wzorzec lapie zdanie
// „Możesz też przelać należność bezpośrednio na nasze konto:" WEWNATRZ pudelka przelewu
// i robi z niego naglowek sekcji w srodku opcji. Bez ograniczenia dlugosci lapie kazde
// dluzsze zdanie konczace sie dwukropkiem, ktore ktos kiedys wpisze w /settings —
// i wypisuje cale zdanie klienta WERSALIKAMI.
//
// ⚠️ Osobny limit LICZBY SLOW tu stal i zostal ZDJETY: weryfikacja mutacyjna pokazala, ze
// przy limicie 42 znakow nie robi nic ponad to, co juz robi dlugosc, a odcinal poprawne
// naglowki w rodzaju „Dane do wysyłki i faktury:". Regula, ktorej nie da sie zlamac testem,
// jest reguła zbedna.
const RE_NAGLOWEK_SEKCJI = /^[^\s].{0,40}:$/;

// PUDELKO OPCJI PLATNOSCI: pierwsza linia grupy „N. Tytul" (patrz blokOpcji w quote-text.js).
const RE_OPCJA_NR = /^(\d{1,2})\.\s+(.+)$/;

// Linia bedaca samym numerem konta — co najmniej 20 znakow bedacych cyframi i spacjami.
// Renderujemy ja czcionka o stalej szerokosci, zeby dalo sie ja przepisac do przelewu.
const RE_NUMER_KONTA = /^[\d][\d ]{18,}[\d]$/;

const td = (extra = '') => `padding:8px 2px;border-bottom:1px solid ${KOLOR.linia};font-family:${FONT};font-size:14px;color:${KOLOR.tekst};${extra}`;

function quoteTableHtml(rows) {
  const out = ['<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px 0 14px;">'];
  for (const r of rows) {
    if (r.typ === 'pozycja') {
      out.push(`<tr><td style="${td()}">${r.qty}× ${r.nazwa}</td><td align="right" style="${td('white-space:nowrap;')}">${r.cena}/szt</td></tr>`);
    } else if (r.typ === 'opcja') {
      out.push(`<tr><td style="${td()}">${r.opis}</td><td align="right" style="${td('white-space:nowrap;')}">${r.kwota}</td></tr>`);
    } else if (r.typ === 'dodatek') {
      out.push(`<tr><td style="${td()}">${r.nazwa}</td><td align="right" style="${td('white-space:nowrap;')}">${r.cena}</td></tr>`);
    } else { // razem
      const netto = r.netto ? `<br><span style="font-weight:normal;font-size:12px;color:${KOLOR.muted};">${r.netto}</span>` : '';
      out.push(`<tr><td style="${td(`border-bottom:0;border-top:2px solid ${KOLOR.akcent};font-weight:bold;padding-top:10px;`)}">Razem</td>`
        + `<td align="right" style="${td(`border-bottom:0;border-top:2px solid ${KOLOR.akcent};font-weight:bold;padding-top:10px;white-space:nowrap;`)}">${r.kwota}${netto}</td></tr>`);
    }
  }
  out.push('</table>');
  return out.join('');
}

// Treść → bloki: grupy linii tabelarycznych (min. 1 pozycja) jako tabela,
// reszta jako akapity (pusta linia rozdziela, pojedyncze łamanie = <br>).
function textToBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const maPozycje = lines.some((l) => RE_POZYCJA.test(l.trim()));
  const blocks = [];
  let para = [];
  let table = [];
  const flushPara = () => { if (para.length) { blocks.push({ typ: 'p', linie: para }); para = []; } };
  const flushTable = () => { if (table.length) { blocks.push({ typ: 'tabela', rows: table }); table = []; } };

  // Tabela czasu realizacji zyje wlasnym trybem: wlacza ja naglowek, wylacza pierwsza
  // linia niepasujaca do „opis - kwota".
  let wRealizacji = false;

  // Linia zakonczona dwukropkiem, tuz nad pierwsza pozycja wyceny, to NAGLOWEK tabeli
  // („Wycena:") — nie akapit. Rozpoznajemy ja po SASIEDZTWIE, a nie po tresci, zeby
  // dzialalo takze wtedy, gdy ktos zmieni ten napis w /settings.
  const naglowkiTabeli = new Set();
  for (let i = 0; i < lines.length - 1; i += 1) {
    const tu = lines[i].trim();
    const dalej = lines[i + 1].trim();
    if (tu.endsWith(':') && RE_POZYCJA.test(dalej)) naglowkiTabeli.add(i);
  }

  // Indeks linii z adresem → etykieta z linii nad nia. `!RE_POZYCJA.test(nad)` nie jest tu
  // potrzebne (pozycja nie konczy sie dwukropkiem), ale naglowek tabeli JUZ sie konczy —
  // dlatego rozstrzyga to, co stoi PONIZEJ: adres robi przycisk, pozycja robi naglowek.
  const przyciski = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    const nad = lines[i - 1].trim();
    const tu = lines[i].trim();
    if (RE_SAM_ADRES.test(tu) && nad.endsWith(':')) przyciski.set(i, nad.slice(0, -1).trim());
  }

  // NAGLOWKI SEKCJI (ZAMOWIENIE, ZWROTY, „Dane do przelewu"). Rozpoznanie po POLOZENIU
  // i DLUGOSCI, nie po tresci — inaczej kazda zmiana napisu w /settings gubilaby naglowek.
  const naglowkiSekcji = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const tu = lines[i].trim();
    if (!RE_NAGLOWEK_SEKCJI.test(tu)) continue;
    // Linia z etykieta przycisku takze konczy sie dwukropkiem — rozstrzyga to, co pod nia.
    //
    // ⚠️ Ta garda jest dzis NADMIAROWA i to jest swiadome: petla nizej pomija etykiete
    // przycisku (`przyciski.has(nr + 1)`) ZANIM dojdzie do sprawdzenia naglowkow sekcji,
    // wiec mutacja zdejmujaca ten warunek przezywa jako rownowazna. Zostaje, bo chroni
    // przed zmiana KOLEJNOSCI galezi w petli — a ta kolejnosc nie jest niczym wymuszona.
    if (przyciski.has(i + 1)) continue;
    const nad = i === 0 ? '' : lines[i - 1].trim();
    if (i === 0 || nad === '') naglowkiSekcji.add(i);
  }

  for (const [nr, raw] of lines.entries()) {
    const l = raw.trim();
    let m;
    if (przyciski.has(nr)) {
      flushPara();
      flushTable();
      blocks.push({ typ: 'przycisk', etykieta: esc(przyciski.get(nr)), url: esc(l) });
      continue;
    }
    // Etykieta przycisku nie moze zostac takze akapitem — pomijamy ja tutaj.
    if (przyciski.has(nr + 1)) { flushPara(); continue; }
    if (naglowkiTabeli.has(nr)) {
      flushPara();
      blocks.push({ typ: 'naglowek', tekst: esc(l) });
      continue;
    }
    // ⚠️ NAGLOWEK REALIZACJI SPRAWDZAMY PRZED naglowkiem sekcji, choc oba by tu pasowaly:
    // tylko ta galaz WLACZA tryb tabeli. Odwrotna kolejnosc zostawilaby wiersze
    // „opis - kwota" zwyklymi akapitami i tabela czasu realizacji zniknelaby z maila.
    if (l === NAGLOWEK_REALIZACJA) {
      flushPara();
      flushTable();
      wRealizacji = true;
      blocks.push({ typ: 'naglowek', tekst: esc(l) });
      continue;
    }
    if (wRealizacji) {
      if ((m = l.match(RE_OPCJA))) {
        table.push({ typ: 'opcja', opis: esc(m[1]), kwota: esc(m[2]) });
        continue;
      }
      // koniec tabeli realizacji — reszta linii wraca do zwyklego trybu
      flushTable();
      wRealizacji = false;
    }
    if (naglowkiSekcji.has(nr)) {
      flushPara();
      flushTable();
      blocks.push({ typ: 'naglowek', tekst: esc(l) });
      continue;
    }
    if (maPozycje && (m = l.match(RE_POZYCJA))) {
      flushPara();
      table.push({ typ: 'pozycja', qty: m[1], nazwa: esc(m[2]), cena: esc(m[3]) });
    } else if (maPozycje && table.length && (m = l.match(RE_DODATEK))) {
      table.push({ typ: 'dodatek', nazwa: esc(m[1]), cena: esc(m[2]) });
    } else if (maPozycje && table.length && (m = l.match(RE_RAZEM))) {
      table.push({ typ: 'razem', kwota: esc(m[1]), netto: m[2] ? esc(m[2]) : '' });
      flushTable();
    } else if (l === '') {
      flushPara();
      // pusta linia wewnątrz niedomkniętej tabeli — tabela czeka na Razem, nic nie rób
    } else {
      para.push(linkify(esc(l)));
    }
  }
  flushPara();
  flushTable();
  return wydzielPudelka(blocks);
}

/**
 * Akapit zaczynajacy sie od „N. Tytul" to PUDELKO OPCJI PLATNOSCI, a stojacy tuz za nim
 * przycisk nalezy DO NIEGO, nie obok.
 *
 * ⚠️ Robimy to po zlozeniu blokow, a nie w petli wyzej, z jednego powodu: petla i tak juz
 * rozbija grupe na akapit + przycisk (etykieta przycisku domyka akapit), wiec skladanie ich
 * z powrotem w jednym miejscu jest krotsze i nie dotyka zadnej z istniejacych sciezek.
 * Mail bez ponumerowanych opcji (projekt, dane do przelewu, przypomnienie) przechodzi tedy
 * bez zmian — zaden jego akapit nie zaczyna sie od „N. ".
 */
function wydzielPudelka(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const m = b.typ === 'p' && b.linie.length ? b.linie[0].match(RE_OPCJA_NR) : null;
    if (!m) { out.push(b); continue; }
    const nastepny = blocks[i + 1];
    const przycisk = nastepny?.typ === 'przycisk' ? nastepny : null;
    if (przycisk) i += 1;
    out.push({ typ: 'pudelko', nr: m[1], tytul: m[2], linie: b.linie.slice(1), przycisk });
  }
  return out;
}

/**
 * KOPERTA MAILA — wordmark, karta, stopka. Wspólna dla WSZYSTKICH maili panelu.
 *
 * ⚠️ WYJĘTA Z `renderMailHtml` BEZ ZMIANY ANI ZNAKU (21.08.2026), przy okazji drugiego maila
 * o zupełnie innej treści (potwierdzenie przyjęcia zamówienia — src/mail/potwierdzenie-html.js).
 * Powód jest ten sam, co zawsze przy wyjmowaniu wspólnego kawałka: druga kopia koperty
 * rozjechałaby się z tą przy pierwszej zmianie stopki albo palety, a klient dostawałby dwa
 * różne „papiery firmowe" z jednego panelu.
 *
 * `body` to GOTOWY HTML treści — koperta go nie escapuje i nie interpretuje. Escapowanie
 * należy do renderera treści, bo tylko on wie, co jest daną, a co znacznikiem.
 */
export function kopertaMaila({ body, footer = '', naglowek = '' } = {}) {
  const marka = String(naglowek ?? '').trim();
  const naglowekHtml = marka
    ? `<tr><td align="center" style="padding:20px 24px 14px;border-bottom:1px solid ${KOLOR.linia};font-family:${FONT};font-size:14px;font-weight:bold;letter-spacing:1px;color:${KOLOR.akcent};">${esc(marka)}</td></tr>`
    : '';
  const footerLines = String(footer ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const footerHtml = footerLines.length
    ? `<tr><td class="mail-footer" style="border-top:1px solid ${KOLOR.linia};padding:14px 26px 20px;font-family:${FONT};font-size:12px;color:${KOLOR.muted};line-height:1.65;">${footerLines.map((l) => linkify(esc(l))).join('<br>')}</td></tr>`
    : '';

  return `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:${KOLOR.tlo};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${KOLOR.tlo};"><tr><td align="center" style="padding:28px 12px 36px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:${KOLOR.karta};border:1px solid ${KOLOR.ramka};border-radius:8px;">
${naglowekHtml}
<tr><td style="padding:22px 26px 8px;">${body}</td></tr>
${footerHtml}
</table>
</td></tr></table>
</body></html>`;
}

// Przycisk. PIERWSZY w mailu jest wypelniony, KAZDY KOLEJNY obrysowany — rozstrzyga
// KOLEJNOSC, nie tresc etykiety. Dwa jednakowo mocne przyciski obok siebie kaza klientowi
// zgadywac, ktory jest „ten wlasciwy"; obrys mowi „to druga droga do tego samego".
function przyciskHtml(b, glowny) {
  const styl = glowny
    ? `background-color:${KOLOR.akcent};color:#ffffff;font-size:15px;padding:12px 22px;`
    : `background-color:${KOLOR.karta};color:${KOLOR.akcent};border:1px solid ${KOLOR.akcent};font-size:14px;padding:10px 18px;`;
  return `<p style="margin:14px 0 2px;"><a href="${b.url}" style="display:inline-block;${styl}font-family:${FONT};font-weight:bold;text-decoration:none;border-radius:6px;">${b.etykieta}</a></p>`;
}

// Linia tresci pudelka. Numer konta dostaje czcionke o stalej szerokosci — klient ma go
// przepisac do przelewu, a w proporcjonalnej czcionce cyfry zlewaja sie w jeden ciag.
function liniaPudelka(l) {
  return RE_NUMER_KONTA.test(l.replace(/<[^>]*>/g, '').trim())
    ? `<span style="${MONO}">${l}</span>`
    : l;
}

function pudelkoHtml(b, glowny) {
  const tresc = b.linie.length
    ? `<p style="margin:0 0 ${b.przycisk ? '10' : '0'}px;font-family:${FONT};font-size:14px;line-height:1.6;color:${KOLOR.tekst};">${b.linie.map(liniaPudelka).join('<br>')}</p>`
    : '';
  const przycisk = b.przycisk ? przyciskHtml(b.przycisk, glowny).replace('margin:14px 0 2px;', 'margin:0;') : '';
  const numer = `<span style="display:inline-block;width:22px;height:22px;line-height:22px;border-radius:50%;background-color:${KOLOR.akcent};color:#ffffff;font-size:12px;text-align:center;margin-right:8px;">${b.nr}</span>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4EFE6;border:1px solid ${KOLOR.ramka};border-radius:8px;margin:0 0 12px;">`
    + '<tr><td style="padding:16px 18px 15px;">'
    + `<p style="margin:0 0 6px;font-family:${FONT};font-size:15px;font-weight:bold;color:${KOLOR.tekst};">${numer}${b.tytul}</p>`
    + tresc + przycisk
    + '</td></tr></table>';
}

export function renderMailHtml({ text, footer = '', naglowek = '' } = {}) {
  const blocks = textToBlocks(text);
  // Licznik przycisków na CAŁY mail — pierwszy wypełniony, kolejne obrysowane, niezależnie
  // od tego, czy stoją w pudełku, czy luzem.
  let ilePrzyciskow = 0;
  const body = blocks.map((b) => {
    if (b.typ === 'tabela') return quoteTableHtml(b.rows);
    if (b.typ === 'pudelko') {
      const glowny = b.przycisk ? (ilePrzyciskow += 1) === 1 : false;
      return pudelkoHtml(b, glowny);
    }
    if (b.typ === 'przycisk') {
      return przyciskHtml(b, (ilePrzyciskow += 1) === 1);
    }
    if (b.typ === 'naglowek') {
      // Nagłówek sekcji w rejestrze PRO: wersaliki, rozstrzelenie, kolor akcentu — tak samo
      // jak eyebrow na stronie oferty, żeby mail i sklep czytały się jak jedno miejsce.
      //
      // ⚠️ CELOWO NIE `naglowekSekcji` Z GÓRY TEGO PLIKU (sprawdzone przy sprzątaniu 22.08.2026):
      // tamta funkcja ma rozstrzelenie 1px i inne marginesy, a tutaj nagłówek jest ROZPOZNANY
      // we wpisanym przez człowieka tekście, więc dochodzi jeszcze obcięcie dwukropka z końca.
      // Podmiana na wspólną wersję zmieniłaby wygląd maili z wyceną, które chodzą na produkcji.
      return `<p style="margin:22px 0 2px;font-family:${FONT};font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${KOLOR.akcent};">${b.tekst.replace(/:$/, '')}</p>`;
    }
    return `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.6;color:${KOLOR.tekst};">${b.linie.join('<br>')}</p>`;
  }).join('');

  return kopertaMaila({ body, footer, naglowek });
}
