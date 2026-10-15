// TEKST WIADOMOSCI Z CENTRUM WIADOMOSCI ALLEGRO → zwykly tekst.
//
// ⚠️⚠️ ALLEGRO ODDAJE `text` Z ENCJAMI HTML. Pomiar na kopii produkcji 14.10.2026: 30 z 85
// wiadomosci w lustrze ma `&oacute;`, jedna `&Oacute;`, szesc `&quot;`, do tego 170 razy `&zwnj;`.
// Litery spoza Latin-1 (ą, ę, ł, ś, ź, ż, ć, ń) przychodza jako zwykle znaki, wiec zepsute
// wygladalo WYLACZNIE „ó/Ó" — zgloszenie wlasciciela „problem z polskimi znakami Ó" (PRZ-074).
// Szablon EJS ucieka `&` drugi raz i na ekranie stalo dosłownie „&Oacute;".
//
// ⚠️ LUSTRO ZOSTAJE SUROWE — rozwijamy przy ODCZYCIE (oms/db/allegro-watki.js). Dzieki temu
// naprawa obejmuje tez wiersze juz zapisane, bez migracji i bez ponownego pobierania z Allegro
// (poller pyta o tresc tylko przy zmianie daty watku, wiec stare wiadomosci nie wrocilyby same).
//
// ⚠️ ROZROZNIAMY WIELKOSC LITER w nazwie encji: `&Oacute;` to „Ó", `&oacute;` to „ó".
// Rozwijacz z domena/wzor-z-produktu.js robi `toLowerCase()` — tu zamienilby „Ó" w „ó".
//
// ⚠️ JEDEN PRZEBIEG, nie petla: „&amp;lt;" ma zostac tekstem „&lt;", nie znacznikiem.

const ENCJE = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
  ['zwnj', '‌'], ['zwj', '‍'],
  // Latin-1, ktore realnie trafia do polskiej korespondencji. Reszte lapie postac liczbowa.
  ['oacute', 'ó'], ['Oacute', 'Ó'],
  ['eacute', 'é'], ['Eacute', 'É'], ['aacute', 'á'], ['Aacute', 'Á'],
  ['uuml', 'ü'], ['Uuml', 'Ü'], ['ouml', 'ö'], ['Ouml', 'Ö'], ['auml', 'ä'], ['Auml', 'Ä'],
  ['szlig', 'ß'], ['deg', '°'], ['times', '×'], ['sect', '§'], ['copy', '©'], ['reg', '®'],
  ['laquo', '«'], ['raquo', '»'],
  ['ndash', '–'], ['mdash', '—'], ['hellip', '…'], ['euro', '€'], ['bull', '•'],
  ['bdquo', '„'], ['ldquo', '“'], ['rdquo', '”'], ['lsquo', '‘'], ['rsquo', '’'],
]);

/** Tekst wiadomosci Allegro z encjami → tekst do pokazania. `null`/`undefined` → `null`. */
export function tekstZAllegro(surowy) {
  if (surowy === null || surowy === undefined) return null;
  return String(surowy).replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/gu, (calosc, tresc) => {
    if (tresc[0] !== '#') return ENCJE.get(tresc) ?? calosc;
    const kod = tresc[1] === 'x' || tresc[1] === 'X'
      ? Number.parseInt(tresc.slice(2), 16)
      : Number.parseInt(tresc.slice(1), 10);
    if (!(kod >= 1 && kod <= 0x10FFFF) || (kod >= 0xD800 && kod <= 0xDFFF)) return calosc;
    return String.fromCodePoint(kod);
  });
}
