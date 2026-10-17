// GENERATOR SKU — regula czysta. Zadnej bazy, zadnego HTTP: tutaj rozstrzyga sie WYLACZNIE,
// jaki numer PROPONUJEMY dla ktorej karty i ktora propozycja jest kolizja.
//
// PO CO TO ISTNIEJE (zmierzone na produkcji 2026-08-12): 965 kart bez SKU. Numer nadany
// tutaj pojedzie w Zadaniu 15 do produkcyjnych sklepow i stanie sie TOZSAMOSCIA produktu —
// zly albo zdublowany numer to nie literowka na ekranie, tylko numer wpisany do cudzego
// produktu.
//
// ⚠️⚠️ KOLIZJA MA BYC WIDOCZNA, ZANIM COKOLWIEK SIE ZAPISZE, i to wobec OBU zbiorow naraz:
// naszych numerow (`karty.sku`) ORAZ numerow, ktore ZYJA JUZ w sklepach
// (`produkty_sklepowe.sku_sklepu` — 218 sztuk, 184 na sklepie B i 115 na sklepie A). Ograniczenie
// `UNIQUE` na kolumnie jest OSTATNIA linia obrony, nie pierwsza: wywalony zapis z bazy to
// komunikat, ktorego czlowiek nie zrozumie, a przy 965 wierszach nie dowie sie nawet, ktory
// numer zawinil.
//
// ⚠️⚠️ TEN MODUL NICZEGO NIE NADAJE. Oddaje PROPOZYCJE dla czlowieka, ktory kliknie — ta sama
// zasada, co przy `domain/dopasowanie-ofert.js` (podpowiedz niczego nie wiaze).
//
// ⚠️ POWTARZALNOSC JEST WYMAGANIEM, NIE MILA CECHA. Ten sam zbior wejsciowy i ten sam wzorzec
// maja dac ten sam wynik — stad jawne sortowanie nizej i zero losowania. Bez tego dwa podglady
// tego samego zaznaczenia pokazywalyby dwa rozne komplety numerow (kolejnosc wierszy z bazy
// zalezy od planu zapytania), a czlowiek nie mialby jak zauwazyc, ktory z nich zatwierdza.

// ——— ALFABET NUMERU ——————————————————————————————————————————————————————————
//
// ⚠️ WIELKIE LITERY ASCII, CYFRY I MYSLNIK — I NIC WIECEJ. To nie jest ostroznosc na wyrost:
// numer jedzie do WooCommerce i na Allegro jako `sku`, laduje w adresach, w eksportach CSV
// i w feedzie do Google. Numery, ktore juz tam zyja, mieszcza sie w tym samym alfabecie
// (`PC-KLOSZ-168`, `PD10`), wiec nasze nowe beda z nimi jednorodne.
//
// ⚠️ SKLADANIE ZNAKOW ZDEJMUJEMY, ALE „ł" NIE MA POSTACI ROZLOZONEJ — NFD go nie rusza, wiec
// „Ściany żółte łąki" bez osobnej reguly dalaby „SCIANY-ZOTE-AKI". Klasa `\p{M}` zamiast
// zakresu wpisanego znakami: znaki diakrytyczne sa same w sobie NIEWIDOCZNE i w edytorze
// doklejaja sie do sasiedniego nawiasu (ta sama postac, co w domain/dopasowanie-ofert.js).
function bezOgonkow(tekst) {
  return tekst.normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/ł/gu, 'l').replace(/Ł/gu, 'L');
}

/**
 * Napis → czlon numeru: wielkie litery ASCII, cyfry, myslnik. Reszta znika, a ciagi
 * niedozwolonych znakow zwijaja sie do JEDNEGO myslnika („Klosze i abażury" → „KLOSZE-I-ABAZURY").
 *
 * ⚠️ `toUpperCase`, a nie `toLocaleUpperCase`: ta druga jest zalezna od ustawien systemu
 * (tureckie „i" → „İ"), czyli ta sama karta dostawalaby inny numer na innym serwerze.
 */
function czlonNumeru(tekst) {
  return bezOgonkow(String(tekst ?? ''))
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

// Czlon dla karty, ktora kategorii glownej nie ma. ⚠️ MUSI BYC NAZWANY, a nie pusty: numer
// „--001" wyglada jak usterka, a `-001` gubi informacje, ze kategorii po prostu nie wybrano.
// 152 karty nie mialy kategorii glownej w dniu pomiaru, wiec to jest droga typowa.
const BEZ_KATEGORII = 'BEZ-KATEGORII';

// ——— WZORZEC ————————————————————————————————————————————————————————————————
//
// Pola, ktore wzorzec zna. ⚠️ ZAMKNIETA LISTA: pole spoza niej ODMAWIA calosci, zamiast
// wyladowac w numerze jako literalne „{NAZWA}". Numer z klamra w srodku pojechalby do sklepu
// i zostal tozsamoscia produktu — a wtedy poprawka wymaga ruszenia produktu w sklepie,
// nie u nas.
const POLA_WZORCA = Object.freeze(['kategoria', 'nnn']);
const POLE_W_KLAMRACH = /\{([^{}]*)\}/gu;

/** Numer porzadkowy w postaci tekstowej: trzy cyfry, a od tysiaca — tyle, ile trzeba. */
const numerPorzadkowy = (n) => String(n).padStart(3, '0');

/**
 * Sprawdza wzorzec i oddaje funkcje skladajaca numer. Rzuca ZDANIEM DLA CZLOWIEKA — trasa
 * pokazuje ten komunikat wprost, wiec nie ma drugiej kopii tej reguly w warstwie HTTP.
 *
 * @param {string} wzorzec surowa tresc pola formularza
 * @param {boolean} wieleKart czy numerujemy wiecej niz jedna karte
 */
function zbudujSkladacz(wzorzec, wieleKart) {
  const surowy = String(wzorzec ?? '').trim();
  if (!surowy) {
    throw new Error('Nie podałeś wzorca numeru. Wpisz np. „LMP-{kategoria}-{nnn}" — '
      + '{kategoria} podstawi kategorię główną karty, a {nnn} kolejny numer.');
  }

  for (const [, pole] of surowy.matchAll(POLE_W_KLAMRACH)) {
    if (!POLA_WZORCA.includes(pole)) {
      throw new Error(`Wzorzec zna wyłącznie {kategoria} i {nnn} — „{${pole}}" nie znam. `
        + 'Numer z nierozpoznanym polem pojechałby do sklepu razem z klamrami.');
    }
  }

  // ⚠️⚠️ WZORZEC BEZ {nnn} NIE MA JAK ODROZNIC DWOCH KART — a numer musi byc jeden na karte.
  // Odmawiamy PRZED policzeniem czegokolwiek: podglad pokazujacy tysiac razy ten sam numer
  // byłby zaproszeniem do kliknięcia „zapisz".
  if (wieleKart && !surowy.includes('{nnn}')) {
    throw new Error('Wzorzec bez {nnn} dałby wszystkim zaznaczonym kartom TEN SAM numer. '
      + 'Dopisz {nnn} — to on rozróżnia kolejne karty.');
  }

  // Sprawdzamy na PUSTEJ kategorii i pierwszym numerze, czy z wzorca w ogole cokolwiek
  // zostaje: „###" po odsianiu znakow spoza alfabetu numeru jest napisem pustym, a pusty
  // numer nie jest numerem.
  const skladaj = (kategoria, n) => czlonNumeru(
    surowy.replaceAll('{kategoria}', kategoria).replaceAll('{nnn}', numerPorzadkowy(n)),
  );
  if (!skladaj(BEZ_KATEGORII, 1)) {
    throw new Error(`Wzorzec „${surowy}" nie daje ani jednego znaku, który sklep przyjmie `
      + 'jako SKU. Użyj liter, cyfr i myślnika.');
  }
  return skladaj;
}

// ——— ZAJETE NUMERY ——————————————————————————————————————————————————————————
//
// ⚠️ POROWNUJEMY BEZ WZGLEDU NA WIELKOSC LITER, choc `UNIQUE` w SQLite jest czuly (BINARY).
// I to jest cala roznica: sklep, ktory ma „pd10", odrzuci nasze „PD10" jako duplikat, a nasza
// baza przepuscilaby oba jako rozne. Ostrozniej znaczy tutaj: WIECEJ wykrytych kolizji,
// nigdy mniej.
const kluczNumeru = (sku) => String(sku ?? '').trim().toUpperCase();

/**
 * Zajete numery → mapa `klucz → opis zrodla`.
 *
 * Przyjmuje `Map` (numer → skad), zwykly `Set`/tablice napisow albo tablice `{sku, opis}`.
 * Opis sluzy WYLACZNIE komunikatowi o kolizji: „numer zajety" bez odpowiedzi na pytanie
 * PRZEZ CO nie daje sie z niczym zrobic.
 */
function indeksZajetych(zajete) {
  const indeks = new Map();
  if (!zajete) return indeks;
  const dodaj = (sku, opis) => {
    const klucz = kluczNumeru(sku);
    // Pierwszy wpis wygrywa — zrodlo pokazane czlowiekowi ma byc powtarzalne, a nie zalezne
    // od tego, ktora tabela przyszla pozniej.
    if (klucz && !indeks.has(klucz)) indeks.set(klucz, opis ?? null);
  };
  if (zajete instanceof Map) for (const [sku, opis] of zajete) dodaj(sku, opis);
  else for (const p of zajete) (typeof p === 'string' ? dodaj(p, null) : dodaj(p?.sku, p?.opis));
  return indeks;
}

const OPIS_KOLIZJI = (sku, skad) => `Numer „${sku}" jest już zajęty${skad ? ` — ${skad}` : ''}. `
  + 'Zmień wzorzec albo popraw ten numer ręcznie na karcie produktu.';

// ——— PROPOZYCJE —————————————————————————————————————————————————————————————

/** Karta, ktora numeru jeszcze NIE MA. Napis z samych spacji to brak numeru, a nie numer. */
const bezSku = (w) => !String(w?.sku ?? '').trim();

/**
 * Propozycje numerow dla podanych kart.
 *
 * @param {Array} karty wiersze tabeli `karty` (pole kategorii: `kategoria_glowna`)
 * @param {string} wzorzec np. `LMP-{kategoria}-{nnn}`
 * @param {Map|Set|Array} zajete numery juz zyjace — NASZE i te ze sklepow
 * @returns {Array<{id, nazwa, sku, kolizja: string|null}>}
 *
 * ⚠️⚠️ KARTA, KTORA SKU JUZ MA, NIE DOSTAJE NOWEGO — nigdy, i to jest cala tresc tej reguly.
 * Numer raz nadany jedzie do sklepu i staje sie tozsamoscia produktu; ciche przenumerowanie
 * jest najgorsza rzecza, jaka ten ekran moze zrobic. Zmiana numeru JUZ NADANEGO zostaje na
 * karcie jednego produktu, gdzie czlowiek widzi dokladnie, co podmienia (`kartaZeSku` sprawdza
 * tam zajetosc przed zapisem).
 *
 * ⚠️ NUMER ZAJETY JEST PRZESKAKIWANY, nie proponowany drugi raz — i to wlasnie dzieki temu
 * DRUGI przebieg generatora doklada numery zamiast zaczynac od jedynki i odbijac sie o bazę.
 * Kolizje wraca tylko wtedy, gdy przeskoczyc NIE MA JAK (wzorzec bez `{nnn}`).
 */
export function proponujSku(karty, wzorzec, zajete) {
  // ⚠️ ODRESZTOWANIE PO `id` PRZED CZYMKOLWIEK INNYM: formularz potrafi przyniesc te sama
  // karte dwa razy (dwa pola wyboru o tej samej wartosci), a wtedy jeden wiersz dostalby DWA
  // numery — drugi zapis odbilby sie o barierę „ma juz SKU" i wrocil jako nieaktualny,
  // czyli ekran meldowalby problem, ktorego zrodlem bylby sam formularz.
  const poId = new Map();
  for (const w of karty ?? []) if (w && !poId.has(w.id)) poId.set(w.id, w);

  // ⚠️ SORTOWANIE JAWNE — po nazwie, tak jak na liscie i na ekranie powiazan, a `id` domyka
  // remis. To ono daje POWTARZALNOSC: kolejnosc wierszy z bazy zalezy od planu zapytania,
  // a od kolejnosci zalezy, ktora karta dostanie numer 001.
  const doNumeru = [...poId.values()].filter(bezSku).sort(
    (a, b) => String(a.nazwa ?? '').localeCompare(String(b.nazwa ?? ''), 'pl') || (a.id - b.id),
  );

  // Wzorzec sprawdzamy TAKZE dla pustego zbioru — literowka ma odmowic, a nie oddac pusto:
  // „nie ma czego numerowac" i „nie rozumiem wzorca" to dwie rozne odpowiedzi.
  const skladaj = zbudujSkladacz(wzorzec, doNumeru.length > 1);
  if (!doNumeru.length) return [];

  const indeks = indeksZajetych(zajete);
  // Numery WYDANE w tym przebiegu dokladamy do zajetych na biezaco: bez tego dwie kategorie
  // schodzace sie do tego samego czlonu wydalyby ten sam numer dwa razy.
  const wydane = new Set();
  const zajety = (sku) => indeks.has(kluczNumeru(sku)) || wydane.has(kluczNumeru(sku));

  // Licznik JEDEN NA CZLON KATEGORII (a nie jeden na caly przebieg): „Lampy stołowe" i „Kinkiety"
  // maja swoje wlasne ciagi, tak jak numeruje sie katalog papierowy. Klucz liczony PO
  // odsianiu znakow, wiec „Klosze i abażury" i „klosze-i-abazury" to jeden ciag, a nie dwa
  // rownolegle, ktore zaraz zaczna sie zderzac.
  const liczniki = new Map();
  const propozycje = [];

  for (const karta of doNumeru) {
    const kategoria = czlonNumeru(karta.kategoria_glowna) || BEZ_KATEGORII;

    let sku = null;
    let kolizja = null;
    let n = liczniki.get(kategoria) ?? 1;
    // Petla ZAWSZE sie konczy: zbior zajetych jest skonczony, wiec najdalej po `zajete.size`
    // krokach trafia na numer wolny. Przy wzorcu bez `{nnn}` numer sie nie zmienia — stad
    // warunek `wzorzecStaly` nizej, ktory zamyka ja po pierwszym obrocie.
    for (;;) {
      sku = skladaj(kategoria, n);
      const nastepny = skladaj(kategoria, n + 1);
      if (!zajety(sku)) break;
      // ⚠️ WZORZEC, KTORY SIE NIE ZMIENIA (bez `{nnn}`), nie ma jak przeskoczyc zajetego
      // numeru. Pozycja wraca OZNACZONA — nigdy po cichu pominieta i nigdy zapisana.
      if (nastepny === sku) {
        kolizja = OPIS_KOLIZJI(sku, indeks.get(kluczNumeru(sku)));
        break;
      }
      n += 1;
    }

    liczniki.set(kategoria, n + 1);
    // ⚠️ NUMER KOLIZYJNY TEZ TRAFIA DO WYDANYCH: dwie pozycje z tym samym numerem musza byc
    // dwiema kolizjami, a nie jedna kolizja i jednym „wolnym" numerem.
    wydane.add(kluczNumeru(sku));
    propozycje.push({ id: karta.id, nazwa: karta.nazwa, sku, kolizja });
  }

  return propozycje;
}
