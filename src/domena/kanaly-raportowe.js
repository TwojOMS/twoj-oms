// Jedna mapa kanalow raportowych na OBIE EPOKI: historie z Apilo i biezaca sprzedaz z OMS-u.
//
// ⚠️ POWÓD ISTNIENIA: te same reguły żyłyby w DWÓCH miejscach i mówiły o tym samym innym
// językiem — konta i tagi Apilo w zewnętrznych raportach, kolumna `sklep`
// w `moduly/api-panelu/trasy/api-sprzedaz.js`. Dwie definicje kanału to dwie różne odpowiedzi na pytanie
// „ile sprzedaliśmy przez Allegro".
//
// ⚠️ TO NIE JEST TEN SAM SŁOWNIK CO W `api-sprzedaz.js` I NIE WOLNO ICH UJEDNOLICAĆ. Tamten
// endpoint oddaje 'SKLEP', 'SKLEP_INDYWIDUALNE' i 'ALLEGRO' CELOWO innymi nazwami, żeby
// zewnętrzny konsument raportów nie mógł ich zsumować z kanałami liczonymi z Apilo. Ten słownik
// jest WEWNĘTRZNY — nie wychodzi żadnym endpointem.

// Historia ma tylko klucz raportowy. Jawny typ wygrywa z nazwą; dla kanałów bez
// definicji zachowujemy dawny prefiks (również dla archiwalnych kont Allegro).
export function czyKanalRaportowyAllegro(klucz, definicje) {
  const definicja = definicje?.find((d) => d.raport === klucz);
  if (definicja) return definicja.typ === 'allegro';
  return klucz.startsWith('ALLEGRO_');
}

function odmowa(tresc) {
  const e = new Error(tresc);
  e.dlaOperatora = true;
  return e;
}

function tagi(w) {
  if (Array.isArray(w.tagi)) return w.tagi;
  try {
    const t = JSON.parse(w.tagi_json ?? '[]');
    return Array.isArray(t) ? t : [];
  } catch {
    // Uszkodzony JSON znaczy „nie wiemy, jakie tagi" — a nie „nie ma tagow". Traktujemy
    // jak brak i zostawiamy to ostrzezeniu o zamowieniach bez tagu.
    return [];
  }
}

/**
 * Kanal zamowienia z HISTORII (Apilo). Pierwsze trafienie wygrywa, kolejnosc jest istotna:
 *
 *  1. DROPSHIPPING przed B2B — adres klienta hurtowego zamawia W DWOCH ROLACH naraz
 *     (zbiorcze z tagiem `drop` i hurt z tagiem `b2b`). Rozstrzyga TAG, nie mail i nie konto.
 *  2. Tag `tagGdd` przed B2B i przed regulami kontowymi — klient z tym tagiem moze zamawiac
 *     z konta zwyklej sprzedazy, wiec bez tej reguly jego zlecenia wsiakaja w Indywidualne albo w B2B.
 *  3. INDYWIDUALNE przed sklepem — zamowienia z panelu ofert wpadaja do tego samego
 *     WooCommerce co detal i bez reguly liczylyby sie jako sprzedaz sklepowa.
 *
 * ⚠️⚠️ KONTO RECZNE TO `RECZNE`, A NIE `INDYWIDUALNE` — i to nie jest
 * szczegół nazewniczy. Mapa „INDYWIDUALNE = konto ręczne LUB pozycja zaślepki" sklejałaby
 * DWIE ROZŁĄCZNE POPULACJE o dwóch różnych granicach:
 *   • zamowienia z panelu ofert: konto sklepu + pozycja zaslepki → w OMS-ie `indywidualne = 1`,
 *     z wlasna granica historii;
 *   • zamowienia reczne: osobne konto → w OMS-ie `sklep = 'reczne'`, z inna granica historii.
 * Sklejone w jeden kanal dalyby „ten sam pieniadz po dwoch stronach granicy w dwoch roznych
 * kanalach": zaleznie od przyjetej granicy znikałyby albo dublowały się kwoty liczone w tysiącach złotych.
 * ZADNA data nie bylaby poprawna — dlatego kanaly sa dwa.
 */
export function kanalHistoryczny(w, klasyfikacja) {
  wymagajKlasyfikacji(klasyfikacja);
  const t = tagi(w);
  if (klasyfikacja.tagDrop !== null && t.includes(klasyfikacja.tagDrop)) return 'DROPSHIPPING';
  if (klasyfikacja.tagGdd !== null && t.includes(klasyfikacja.tagGdd)) return 'GDD';
  if (
    klasyfikacja.kontaB2b.has(w.platform_account_id) ||
    (klasyfikacja.tagB2b !== null && t.includes(klasyfikacja.tagB2b))
  )
    return 'B2B';
  if (
    (w.pozycje ?? []).some((p) =>
      klasyfikacja.prefiksyIndywidualne.some((prefiks) => String(p.original_code ?? '').startsWith(prefiks)),
    )
  ) {
    return 'INDYWIDUALNE';
  }
  const zKonta = klasyfikacja.konta.get(w.platform_account_id);
  // ⚠️ PRZERYWA, a nie wpada do worka „pozostale". Worek jest kanalem LICZONYM, wiec ciche
  // wrzucenie tam czegokolwiek zawyzyloby sprzedaz — i nikt by tego nie zakwestionowal.
  if (!zKonta) throw odmowa(`Raport nie zna tego zamowienia: nieznane konto Apilo: ${w.platform_account_id}.`);
  return zKonta;
}

/** Kanal zamowienia z OMS-u. Ta sama zasada pierwszego trafienia. */
export function kanalOms(w, klasyfikacja) {
  wymagajKlasyfikacji(klasyfikacja);
  if (w.indywidualne) return 'INDYWIDUALNE';
  // ⚠️⚠️ B2B WCHODZI Z KOLUMNY `zamowienia.b2b` — bez niej kanał B2B byłby po
  // granicy z Apilo PUSTY, bo OMS nie miałby czym oznaczyć hurtu. Znacznik podstawia sie z bazy
  // stalych klientow przy zakladaniu zamowienia i od tej chwili rozstrzyga ZAMÓWIENIE.
  //
  // ⚠️ KOLUMNA, A NIE ODCZYT TYPU KLIENTA Z BAZY — kanały liczą się
  // PRZY ODCZYCIE, więc reguła pytająca bazę klientów przepisywałaby historię
  // wstecz: w dniu wdrożenia zamówienia tych klientów przeskoczyłyby z „Reczne" do „B2B"
  // takze w miesiacach ZAMKNIETYCH, a kazda pozniejsza zmiana typu klienta robilaby to znowu,
  // po cichu. Kolumna usuwa cala te klase problemow zamiast ja obslugiwac — i jest zgodna
  // z reszta panelu, gdzie dane klienta sa MIGAWKA (klient_json, dostawa_json, chce_fakture).
  //
  // ⚠️ DROPSHIPPING WYGRYWA Z B2B i kolejnosc tych dwoch linii jest o pieniadze — dokladnie
  // tak samo, jak w `kanalHistoryczny` wyzej, gdzie tag `drop` wygrywa z tagiem `b2b`. Klient
  // rozliczany zbiorczo zamawia W DWOCH ROLACH: zbiorczo do klienta koncowego (okres
  // rozliczeniowy, jedna faktura na koniec miesiaca) i hurtowo do wlasnej siedziby. Gdyby B2B
  // wygrywalo, zamowienia zbiorcze wypadlyby z DROPSHIPPINGU i saldo okresu przestaloby sie
  // zgadzac z raportem.
  //
  // ⚠️ WYLACZNIE dla `sklep = 'reczne'`. Sprzedaz przez sklep ma wlasny kanal
  // z konfiguracji sklepow i to on mowi, SKAD przyszly pieniadze; `B2B` w tym slowniku znaczy „sprzedaz
  // hurtowa poza sklepem" (w historii importu: konto hurtowe / tag b2b). Sklejenie ich dawaloby dwa
  // kanaly opisujace ten sam pieniadz — patrz naglowek tego pliku.
  if (w.sklep === 'reczne') {
    if (w.okres_rozliczeniowy_id) return 'DROPSHIPPING';
    return w.b2b ? 'B2B' : 'RECZNE';
  }
  const zeSklepu = klasyfikacja.sklepy.get(w.sklep);
  // Numer zamówienia (nie dane klienta) + wskazówka, co sprawdzić — komunikat trafia na ekran panelu.
  if (!zeSklepu) {
    const numer = w.numer ? ` ${w.numer}` : '';
    throw odmowa(
      `Raport nie zna tego zamówienia${numer}: nieznany sklep OMS: ${w.sklep}. Tego klucza sklepu nie ma w konfiguracji kanałów — sprawdź OMS_KANALY (Ustawienia → Integracje → Moje połączenia).`,
    );
  }
  return zeSklepu;
}

export function wymagajKlasyfikacji(c) {
  const id = (x) => Number.isSafeInteger(x) && x >= 0;
  const raport = (x) => typeof x === 'string' && /^[A-Z][A-Z0-9_]*$/.test(x);
  const poprawna =
    c &&
    c.sklepy instanceof Map &&
    c.konta instanceof Map &&
    c.raporty instanceof Set &&
    c.kontaB2b instanceof Set &&
    Array.isArray(c.prefiksyIndywidualne) &&
    ['tagDrop', 'tagGdd', 'tagB2b'].every((k) => c[k] === null || id(c[k])) &&
    [...c.sklepy].every(([k, v]) => typeof k === 'string' && k.length > 0 && raport(v) && c.raporty.has(v)) &&
    [...c.konta].every(
      ([k, v]) => id(k) && raport(v) && c.raporty.has(v) && !['SKLEP', 'SKLEP_INDYWIDUALNE', 'ALLEGRO'].includes(v),
    ) &&
    [...c.raporty].every(raport) &&
    [...c.kontaB2b].every((k) => id(k) && c.konta.get(k) === 'B2B') &&
    c.prefiksyIndywidualne.every((p) => typeof p === 'string' && p.trim() === p && p.length > 1 && p.endsWith('|')) &&
    new Set(c.prefiksyIndywidualne).size === c.prefiksyIndywidualne.length;
  if (!poprawna) throw new TypeError('Raport wymaga jawnej klasyfikacji kanałów.');
  const tagi = [c.tagDrop, c.tagGdd, c.tagB2b].filter((v) => v !== null);
  if (new Set(tagi).size !== tagi.length)
    throw new TypeError('Raport wymaga jawnej klasyfikacji kanałów: tagi muszą być różne.');
  return c;
}
