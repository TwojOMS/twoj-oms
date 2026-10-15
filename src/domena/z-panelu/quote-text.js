import { quoteValidity } from './quote-validity.js';
import { fmtDaySlownie } from './dates.js';
import { kwotaEkspresu } from './ekspres-kwota.js';

// Nazwa pozycji „przygotowanie projektu" — JEDNO miejsce dla maila, oferty w sklepie
// i zamówienia w OMS-ie. Rozjazd znaczyłby, że klient widzi w sklepie inną nazwę niż
// w mailu, który zaakceptował. Ta sama zasada, co przy WYSYLKA_NAZWA.
export const PROJEKT_NAZWA = 'przygotowanie projektu';

// Naglowek tabeli czasu realizacji. UMOWA z src/mail/mail-html.js — po tej linii mail
// wie, ze nastepne „opis - kwota" to wiersze tabeli, a nie zwykle zdania.
export const NAGLOWEK_REALIZACJA = 'Czas realizacji:';

// Nazwa pozycji wysylki — musi byc identyczna z WYSYLKA_NAZWA w shop/offer-payload.js,
// bo klient widzi ja i w mailu, i w sklepie.
export const WYSYLKA_NAZWA_LINII = 'wysyłka kurierem DPD';

function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

export function formatPLN(x) {
  const r = round2(x);
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(2).replace('.', ',');
}

export function quoteTotals(rows, shipping, projekt = 0) {
  const itemsBrutto = rows.reduce((s, r) => s + r.qty * r.price, 0);
  const totalBrutto = round2(itemsBrutto + Number(shipping) + Number(projekt || 0));
  const totalNetto = round2(totalBrutto / 1.23);
  return { itemsBrutto: round2(itemsBrutto), totalBrutto, totalNetto };
}

// Suma zapisanej wyceny (card.quote) albo null, gdy wycena niekompletna.
// Pusta wartosc NIE jest zerem: JSON nie przenosi NaN (build-quote zapisuje
// parseFloat('') jako null), a Number(null)=0 zamienilaby niedokonczona pozycje
// w darmowa. Dlatego kompletnosc sprawdzamy jawnie.
export function quoteTotalOf(quote) {
  if (!quote || !Array.isArray(quote.items) || !quote.items.length) return null;
  const liczba = (v) => (v == null || v === '' ? NaN : Number(v));
  const rows = quote.items.map((i) => ({ qty: liczba(i.qty), price: liczba(i.price) }));
  if (!rows.every((r) => Number.isFinite(r.qty) && Number.isFinite(r.price))) return null;
  const shipping = quote.shipping == null ? 0 : liczba(quote.shipping);
  if (!Number.isFinite(shipping)) return null;
  // Wyceny sprzed 19.08.2026 nie maja pola `projekt` — brak znaczy zero, ale SMIEC
  // uniewaznia wycene tak samo jak smiec w cenie. `liczba('')` daje NaN, nie 0.
  const projekt = quote.projekt == null ? 0 : liczba(quote.projekt);
  if (!Number.isFinite(projekt)) return null;
  return quoteTotals(rows, shipping, projekt);
}

// Sam korpus wyceny: pozycje, wysyłka, linia o projekcie, suma — bez powitania,
// nagłówka i akapitów. Ten sam blok wchodzi do maila z wyceną i do przypomnienia
// o jej ważności; wspólna funkcja gwarantuje, że kwoty się nie rozjadą.
export function quoteBodyLines({ rows, shipping, projekt = 0, settings }) {
  const lines = rows.map((r) => `${r.qty}x ${r.name} - ${formatPLN(r.price)}zł brutto/szt`);
  const ship = Number(shipping);
  const proj = Number(projekt || 0);
  // ⚠️ KOLEJNOSC: produkty → przygotowanie projektu → wysylka → razem (decyzja właściciela
  // 19.08.2026). Wczesniej linia o projekcie stala POD wysylka i byla czystym tekstem
  // z ustawien — teraz jest pozycja z wlasna kwota, wiec musi stac przy pozostalych.
  // ⚠️ JEDEN KSZTALT DLA WSZYSTKICH DODATKOW: „nazwa - wartosc". Do 19.08.2026 wersje bez
  // kwoty byly osobnymi zdaniami („wysylka gratis", „przygotowanie projektu w cenie") i przez
  // to WYPADALY Z TABELY w mailu HTML — szly przez cala szerokosc, bez prawej kolumny.
  // Teraz „w cenie" i „gratis" stoja po prawej dokladnie tam, gdzie kwota.
  lines.push(`${PROJEKT_NAZWA} - ${proj > 0 ? `${formatPLN(proj)}zł brutto` : (String(settings.quoteProjectLine ?? '').trim() || 'w cenie')}`);
  lines.push(`${WYSYLKA_NAZWA_LINII} - ${ship > 0 ? `${formatPLN(ship)}zł brutto` : 'gratis'}`);
  const { totalBrutto, totalNetto } = quoteTotals(rows, ship, proj);
  lines.push(`Razem: ${formatPLN(totalBrutto)}zł (${formatPLN(totalNetto)}zł netto)`);
  return lines;
}

/**
 * Podstawienia w opcji „przelew tradycyjny".
 *
 * Znacznik, dla którego nie ma wartości, zabiera ZE SOBĄ CAŁĄ LINIĘ — „tytuł przelewu:"
 * bez adresu albo „nr konta:" bez numeru to instrukcja, której klient nie może wykonać,
 * a wyglądająca jak nasza pomyłka.
 */
function podstawWPrzelewie(tekst, { settings, email, totalBrutto }) {
  const konto = String(settings?.quoteBankLines ?? '').trim();
  const adres = String(email ?? '').trim();
  const kwota = `${formatPLN(totalBrutto)}zł`;

  // ⚠️ CAŁY DOPISEK O EKSPRESIE SIEDZI W ZNACZNIKU, razem z nawiasami. Gdyby nawiasy stały
  // w tekście z /settings, wycena bez czytelnej dopłaty zostawiłaby w mailu puste „()".
  const doplata = kwotaEkspresu(settings?.quoteExpressPrice);
  const ekspres = doplata == null ? '' : ` (z realizacją ekspresową: ${formatPLN(round2(totalBrutto + doplata))}zł)`;

  const out = [];
  for (const linia of String(tekst ?? '').split('\n')) {
    if (linia.includes('{{email}}') && !adres) continue;
    if (linia.includes('{{konto}}')) {
      if (!konto) continue;
      // Dane konta bywają wielolinijkowe (nazwa + bank, numer) — wchodzą jako osobne linie,
      // żeby numer dało się przepisać z osobnego wiersza.
      out.push(...konto.split('\n').map((l) => linia.replace('{{konto}}', l).trimEnd()));
      continue;
    }
    out.push(linia.replaceAll('{{email}}', adres).replaceAll('{{kwota}}', kwota).replaceAll('{{ekspres}}', ekspres));
  }
  return out.join('\n');
}

/**
 * Jedna opcja płatności jako blok linii: „N. Tytuł" + treść + opcjonalny przycisk.
 *
 * ⚠️ NUMER BIERZE SIĘ Z KOLEJNOŚCI, NIE Z USTAWIEŃ. Pierwsza linia z /settings oddaje sam
 * TYTUŁ — jej numer jest ignorowany. Gdy oferta w sklepie nie powstała (awaria sklepu przy
 * wysyłce), całe pudełko 1 znika, a proforma i przelew stają się 1. i 2. Pudełko „zamówienie
 * w sklepie" bez przycisku obiecywałoby drogę, której nie ma, a dziura w numeracji kazałaby
 * klientowi szukać opcji, której w mailu nie ma.
 */
function blokOpcji(nr, tekstOpcji, { etykieta = null, link = null } = {}) {
  const linie = String(tekstOpcji ?? '').split('\n').map((l) => l.trimEnd()).filter((l, i, all) => l !== '' || i < all.length - 1);
  if (!linie.length || !linie.some((l) => l.trim())) return [];
  const [pierwsza, ...reszta] = linie;
  // Numer z ustawień („1. ") zdejmujemy — zostaje sam tytuł, a numer nadaje kolejność.
  const tytul = pierwsza.replace(/^\s*\d{1,2}\.\s*/, '').trim();
  const out = [`${nr}. ${tytul}`, ...reszta];
  if (link && String(link).trim()) {
    out.push(`${String(etykieta ?? '').trim() || 'Przejdź dalej'}:`);
    out.push(String(link).trim());
  }
  return out;
}

export function buildQuoteText({ rows, shipping, projekt = 0, linkOferty = null, linkProformy = null, email = null, wyslanoAt = null, settings }) {
  if (!settings) throw new Error('buildQuoteText: brak ustawień.');
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Wycena musi mieć co najmniej jedną pozycję.');
  const ship = Number(shipping);
  if (!Number.isFinite(ship) || ship < 0) throw new Error('Nieprawidłowa kwota wysyłki.');
  const proj = Number(projekt || 0);
  if (!Number.isFinite(proj) || proj < 0) throw new Error('Nieprawidłowa kwota za przygotowanie projektu.');
  const clean = rows.map((r, i) => {
    const qty = Number(r.qty);
    const price = Number(r.price);
    const name = String(r.name ?? '').trim();
    if (!name) throw new Error(`Pozycja ${i + 1}: brak nazwy produktu.`);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error(`Pozycja ${i + 1}: ilość musi być liczbą całkowitą > 0.`);
    if (!Number.isFinite(price) || price < 0) throw new Error(`Pozycja ${i + 1}: cena musi być liczbą ≥ 0.`);
    return { qty, name, price };
  });

  const { totalBrutto, totalNetto } = quoteTotals(clean, ship, proj);

  const lines = [];
  const push = (s) => { if (String(s ?? '').trim()) lines.push(s); }; // pusty akapit z ustawień znika bez śladu
  push(settings.quoteGreeting);
  // Zdanie wstępne stoi w TEJ SAMEJ linii logicznej co powitanie (pojedyncze łamanie →
  // <br> w HTML), więc czyta się jako jeden akapit, a nie dwa oderwane zdania.
  push(settings.quoteIntro);
  lines.push('');
  push(settings.quoteHeader);
  lines.push(...quoteBodyLines({ rows: clean, shipping: ship, projekt: proj, settings }));
  // WAŻNOŚĆ — tuż pod „Razem", bez pustej linii: to zdanie o TEJ tabeli, nie osobna sekcja.
  // Liczymy tą samą funkcją, co przypomnienie o ważności (domain/quote-validity.js), żeby
  // data w mailu i data, po której panel proponuje przypomnienie, nie mogły się rozjechać.
  const waznosc = String(settings.quoteValidityLine ?? '').trim();
  if (waznosc) {
    const dni = Number(settings.quoteValidDays);
    const val = quoteValidity({ sentAt: wyslanoAt ?? new Date().toISOString(), validDays: dni });
    // Bez czytelnej daty NIE piszemy nic — „ważna 30 dni — do " z urwanym końcem byłoby
    // gorsze niż brak tej linii.
    const doKiedy = val ? fmtDaySlownie(val.expiresOn) : '';
    if (doKiedy) lines.push(waznosc.replaceAll('{{dni}}', String(dni)).replaceAll('{{do}}', doKiedy));
  }
  // ⚠️ CZAS REALIZACJI JAKO TABELA, nie dwa akapity. Naglowek `NAGLOWEK_REALIZACJA` jest
  // UMOWA z renderMailHtml: to po nim mail poznaje, ze kolejne linie „opis - kwota" ma zlozyc
  // w dwie kolumny. W plain-textcie czyta sie tak samo jak dotad.
  const opcje = [
    [settings.quoteRealizationPara, settings.quoteRealizationPrice],
    [settings.quoteExpressPara, settings.quoteExpressPrice],
  ].filter(([opis]) => String(opis ?? '').trim());
  if (opcje.length) {
    lines.push('');
    lines.push(NAGLOWEK_REALIZACJA);
    for (const [opis, kwota] of opcje) {
      lines.push(String(kwota ?? '').trim() ? `${opis} - ${String(kwota).trim()}` : String(opis));
    }
    if (String(settings.quoteRealizationNote ?? '').trim()) lines.push(settings.quoteRealizationNote);
  }
  // ═══ ZAMÓWIENIE — trzy drogi zapłaty jako ponumerowane pudełka (makieta 2026-08-21,
  // akceptacja właściciela 22.08). Do 22.08.2026 był tu jeden akapit `quotePrepayPara`, w którym
  // przycisk „Akceptuję wycenę" stał osobno, na samym końcu maila, pod podpisem.
  //
  // ⚠️ PRZYCISK PRZENIÓSŁ SIĘ Z KOŃCA MAILA DO OPCJI 1 — świadome uchylenie reguły „przycisk
  // ostatnią rzeczą, którą klient widzi". Reguła miała sens, gdy przycisk był w mailu JEDYNĄ
  // rzeczą do kliknięcia; teraz za nim stoją jeszcze dwie inne drogi zapłaty i sekcja o
  // zwrotach, a przycisk oderwany od opisu, którego dotyczy, pytałby „przejść do czego?".
  const opcjeZamowienia = [
    [settings.quoteOption1, { etykieta: settings.quoteAcceptLabel, link: linkOferty }],
    [settings.quoteOption2, { etykieta: settings.quoteProformaLabel, link: linkProformy }],
    [podstawWPrzelewie(settings.quoteOption3, { settings, email, totalBrutto })],
  ];
  const bloki = [];
  for (const [tekstOpcji, przycisk] of opcjeZamowienia) {
    // ⚠️ OPCJA BEZ SWOJEJ DROGI ZNIKA W CAŁOŚCI. Pierwsze dwie mają sens wyłącznie z linkiem:
    // pudełko „zamówienie w sklepie" bez przycisku obiecuje klientowi drogę, której nie ma.
    // Trzecia (przelew) linku nie potrzebuje i stoi zawsze.
    if (przycisk && !String(przycisk.link ?? '').trim()) continue;
    const blok = blokOpcji(bloki.length + 1, tekstOpcji, przycisk ?? {});
    if (blok.length) bloki.push(blok);
  }
  if (bloki.length) {
    lines.push('');
    push(settings.quoteOrderHeader);
    push(settings.quoteOrderIntro);
    for (const blok of bloki) { lines.push(''); lines.push(...blok); }
  }

  // ═══ ZWROTY — sekcja nowa (22.08.2026). Do tej pory informacja o braku prawa odstąpienia
  // padała dopiero w mailu z danymi do przelewu i na stronie akceptacji projektu, czyli PO
  // decyzji o zakupie.
  if (String(settings.quoteReturnsText ?? '').trim()) {
    lines.push('');
    push(settings.quoteReturnsHeader);
    push(settings.quoteReturnsText);
  }

  if (String(settings.quoteSignature ?? '').trim()) { lines.push(''); lines.push(settings.quoteSignature); }

  return { text: lines.join('\n'), totalBrutto, totalNetto };
}

export function composeItemName({ rodzaj, nazwa, rozmiar } = {}) {
  return [rodzaj, nazwa, rozmiar]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .join(' ');
}
