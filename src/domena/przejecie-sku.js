// PRZEJECIE NUMERU ZE SKLEPU — regula czysta. Zadnej bazy, zadnego HTTP: tutaj rozstrzyga sie
// WYLACZNIE, ktora karta moze PRZEJAC numer, ktory jej produkt ma juz w sklepie, a ktora
// takiej odpowiedzi nie ma i musi trafic do czlowieka.
//
// PO CO TO ISTNIEJE (zmierzone na produkcji 2026-08-12): 278 kart — czwarta czesc katalogu —
// nie ma NASZEGO numeru, a ich produkt ma WLASNY numer w sklepie („PC-KLOSZ-168",
// „PD10"). Generator SKU (`domain/sku-generator.js`) ich nie przejmuje i nie ma jak: on WYDAJE
// numery nowe i poprawnie omija zajete. Zostaje wiec ROZBIEZNOSC — rejestr milczy, sklep ma
// numer. To nie jest kosmetyka:
//
// ⚠️⚠️ GDYBY POTEM POJECHAL ZAPIS (`domain/zapis-do-sklepu.js`), NADPISALBY NUMER BEDACY
// TOZSAMOSCIA PRODUKTU. Numer w sklepie laduje w adresach, eksportach, feedzie do Google
// i na Allegro — podmieniony nie da sie „cofnac przyciskiem".
//
// ⚠️⚠️ TEN MODUL NICZEGO NIE NADAJE. Oddaje PROPOZYCJE dla czlowieka, ktory kliknie — ta sama
// zasada, co w `sku-generator.js` i `dopasowanie-ofert.js`.
//
// ⚠️⚠️ I NICZEGO NIE WYMYSLA. Kazdy numer stad POCHODZI ZE SKLEPU; modul nie sklada ani jednego
// znaku. Tym rozni sie od generatora i dlatego jest osobnym ekranem.

/**
 * Klucz porownania numerow.
 *
 * ⚠️ WIELKIE LITERY, choc `UNIQUE` na `karty.sku` jest w SQLite czuly (BINARY). I to jest cala
 * roznica: „PD10" przejete z jednego sklepu i „pd10" z drugiego przejda przez nasza kolumne
 * jako DWA rozne numery, a w sklepie beda JEDNYM — czyli zapis odbilby sie o duplikat
 * dopiero na produkcji. Ta sama regula stoi w `sku-generator.js` i `db/magazyn.js`.
 */
const kluczNumeru = (sku) => String(sku ?? '').trim().toUpperCase();

/** Numer ze sklepu bez otoczki. Sam napis z odstepow to BRAK numeru, a nie numer. */
const numerSklepu = (sku) => String(sku ?? '').trim();

/** Karta, ktora NASZEGO numeru jeszcze nie ma. Napis z samych spacji to brak numeru. */
const bezSku = (w) => !String(w?.sku ?? '').trim();

/** Zrodlo numeru tak, jak zobaczy je czlowiek: kanal i nazwa produktu w tym kanale. */
const opisZrodla = (p) => `${p?.kanal ?? '(bez kanału)'} — „${p?.nazwa ?? '(bez nazwy)'}"`;

/**
 * Zajete numery → mapa `klucz → opis zrodla`. Przyjmuje `Map`, `Set`, tablice napisow albo
 * tablice `{sku, opis}` — ten sam ksztalt, co w `sku-generator.js`, bo obie regule karmi
 * TA SAMA funkcja bazy (`zajeteSku`).
 */
function indeksZajetych(zajete) {
  const indeks = new Map();
  if (!zajete) return indeks;
  const dodaj = (sku, opis) => {
    const klucz = kluczNumeru(sku);
    // Pierwszy wpis wygrywa — zrodlo pokazane czlowiekowi ma byc powtarzalne.
    if (klucz && !indeks.has(klucz)) indeks.set(klucz, opis ?? null);
  };
  if (zajete instanceof Map) for (const [sku, opis] of zajete) dodaj(sku, opis);
  else for (const p of zajete) (typeof p === 'string' ? dodaj(p, null) : dodaj(p?.sku, p?.opis));
  return indeks;
}

const OPIS_ROZBIEZNOSCI = (zrodla) => 'Produkty tej karty mają w sklepach różne numery: '
  + `${zrodla.map((z) => `„${z.sku}" (${z.opis})`).join(', ')}. `
  + 'Nie wybieram za Ciebie — który z nich jest numerem tej karty, wie wyłącznie człowiek. '
  + 'Wpisz go na karcie produktu albo popraw numer w sklepie.';

const OPIS_KOLIZJI = (sku, skad) => `Numer „${sku}" jest już zajęty${skad ? ` — ${skad}` : ''}. `
  + 'Nie przejmę go: w rejestrze powstałby drugi wiersz z tym samym numerem, a w sklepie '
  + 'jest to tożsamość jednego produktu.';

const OPIS_SPORU = (sku, nazwa) => `Numer „${sku}" chce przejąć także karta „${nazwa}". `
  + 'Dwie karty z jednym numerem sklep odrzuci jako duplikat — rozstrzygnij, która go ma.';

/**
 * Propozycje PRZEJECIA numerow ze sklepu.
 *
 * @param {Array} karty wiersze tabeli `karty` (potrzebne: `id`, `nazwa`, `sku`)
 * @param {Array} produkty wiersze lustra `produkty_sklepowe` z `karta_id`, `kanal`, `nazwa`,
 *   `sku_sklepu` — WSZYSTKIE produkty tych kart, takze te bez numeru
 * @param {Map|Set|Array} zajete numery zajete GDZIE INDZIEJ — nasze (`karty.sku`) i te ze
 *   sklepow, ale BEZ produktow tych kart (patrz `zajeteSku(db, { pomijajProduktyKart })`)
 * @returns {Array<{id, nazwa, sku: string|null, zrodlo: string|null, uwaga: string|null, zla: boolean}>}
 *
 * ⚠️⚠️ KARTA, KTORA NUMER JUZ MA, NIE DOSTAJE NOWEGO — nigdy. Ta sama regula, co w generatorze:
 * numer raz nadany jest tozsamoscia produktu, a ciche przenumerowanie jest najgorsza rzecza,
 * jaka ten ekran moze zrobic. Zmiana numeru JUZ NADANEGO zostaje na karcie jednego produktu.
 *
 * ⚠️⚠️ KARTA POWIAZANA Z PRODUKTAMI O ROZNYCH NUMERACH NIE MA JEDNEJ POPRAWNEJ ODPOWIEDZI.
 * Wraca OZNACZONA, z wszystkimi numerami w uwadze — nigdy z numerem wybranym za czlowieka
 * i nigdy po cichu pominieta.
 *
 * ⚠️ KARTA, KTOREJ PRODUKTY NUMERU NIE MAJA, W OGOLE TU NIE WRACA. Nie ma czego przejmowac,
 * a pozycja „—" na liscie 278 wierszy byla by szumem; od nadawania numerow NOWYCH jest
 * generator SKU.
 */
export function przejeciaZeSklepu(karty, produkty, zajete) {
  // ⚠️ ODRESZTOWANIE PO `id` PRZED CZYMKOLWIEK INNYM: formularz potrafi przyniesc te sama karte
  // dwa razy (dwa pola wyboru o tej samej wartosci), a wtedy jeden wiersz dostalby DWIE pozycje
  // i sam ze soba wszedl w spor o numer.
  const poId = new Map();
  for (const w of karty ?? []) if (w && !poId.has(w.id)) poId.set(w.id, w);

  // Numery ze sklepu per karta. `Map` po kluczu karty, bo `karta_id` bierze sie z lustra.
  const zrodla = new Map();
  for (const p of produkty ?? []) {
    const sku = numerSklepu(p?.sku_sklepu);
    if (!sku || !poId.has(p?.karta_id)) continue;
    if (!zrodla.has(p.karta_id)) zrodla.set(p.karta_id, []);
    zrodla.get(p.karta_id).push({ sku, opis: opisZrodla(p) });
  }

  // ⚠️ SORTOWANIE JAWNE — po nazwie, tak jak na liscie, generatorze i ekranie powiazan;
  // `id` domyka remis. To ono daje POWTARZALNOSC: kolejnosc wierszy z bazy zalezy od planu
  // zapytania, a czlowiek ma zobaczyc przy zatwierdzeniu ten sam ekran, co przy podgladzie.
  const doPrzejecia = [...poId.values()].filter(
    (w) => bezSku(w) && (zrodla.get(w.id) ?? []).length,
  ).sort(
    (a, b) => String(a.nazwa ?? '').localeCompare(String(b.nazwa ?? ''), 'pl') || (a.id - b.id),
  );

  const indeks = indeksZajetych(zajete);

  // KROK 1: co kazda karta mialaby przejac. Spor miedzy kartami rozstrzyga sie dopiero potem,
  // bo do jego opisania trzeba znac OBIE strony.
  const wstepne = doPrzejecia.map((karta) => {
    const moje = zrodla.get(karta.id);
    // ⚠️ ROZNE POSTACIE TEGO SAMEGO NUMERU TEZ SA ROZBIEZNOSCIA („PD10" vs „pd10"): dla sklepu
    // to jeden numer, dla naszej kolumny dwa, a ktory jest prawda — wie wylacznie czlowiek.
    const rozne = [...new Set(moje.map((z) => z.sku))];
    if (rozne.length > 1) {
      return {
        karta, sku: null, zrodlo: null, uwaga: OPIS_ROZBIEZNOSCI(moje),
        zla: true, rodzaj: 'rozbieznosc',
      };
    }
    const [{ sku, opis }] = moje;
    const skad = indeks.get(kluczNumeru(sku));
    if (skad !== undefined) {
      return {
        karta, sku: null, zrodlo: opis, uwaga: OPIS_KOLIZJI(sku, skad),
        zla: true, rodzaj: 'kolizja',
      };
    }
    return { karta, sku, zrodlo: opis, uwaga: null, zla: false, rodzaj: 'gotowe' };
  });

  // KROK 2: dwie karty po TEN SAM numer. ⚠️ OBIE pozycje wracaja oznaczone, a nie jedna „wolna"
  // i jedna kolizyjna: przy dwoch kandydatach nie ma powodu, dla ktorego akurat pierwszy
  // alfabetycznie mialby byc tym wlasciwym.
  const poKluczu = new Map();
  for (const p of wstepne) {
    if (!p.sku) continue;
    const klucz = kluczNumeru(p.sku);
    if (!poKluczu.has(klucz)) poKluczu.set(klucz, []);
    poKluczu.get(klucz).push(p);
  }
  for (const grupa of poKluczu.values()) {
    if (grupa.length < 2) continue;
    for (const p of grupa) {
      const inny = grupa.find((x) => x !== p);
      p.uwaga = OPIS_SPORU(p.sku, inny.karta.nazwa);
      p.sku = null;
      p.zla = true;
      p.rodzaj = 'kolizja';
    }
  }

  return wstepne.map(({ karta, sku, zrodlo, uwaga, zla, rodzaj }) => ({
    id: karta.id, nazwa: karta.nazwa, sku, zrodlo, uwaga, zla, rodzaj,
  }));
}
