// Jedna mapa kanalow raportowych na OBIE EPOKI: historie z Apilo i biezaca sprzedaz z OMS-u.
//
// ⚠️ POWOD ISTNIENIA: te same reguly zyly dotad w DWOCH miejscach i mowily o tym samym innym
// jezykiem — konta i tagi Apilo w zewnetrznym repo raportow wlasciciela (`klasyfikacja.mjs`), kolumna `sklep`
// w web/routes/api-sprzedaz.js. Dwie definicje kanalu to dwie rozne odpowiedzi na pytanie
// „ile sprzedalismy przez Allegro".
//
// ⚠️ TO NIE JEST TEN SAM SLOWNIK CO W `api-sprzedaz.js` I NIE WOLNO ICH UJEDNOLICAC. Tamten
// endpoint oddaje 'SKLEP', 'SKLEP_INDYWIDUALNE' i 'ALLEGRO' CELOWO innymi nazwami, zeby
// konsument w repo `raporty` nie mogl ich zsumowac z kanalami liczonymi z Apilo. Ten slownik
// jest WEWNETRZNY — nie wychodzi zadnym endpointem.

// Historia ma tylko klucz raportowy. Jawny typ wygrywa z nazwą; dla kanałów bez
// definicji zachowujemy dawny prefiks (również dla archiwalnych kont Allegro).
export function czyKanalRaportowyAllegro(klucz, definicje) {
  const definicja = definicje?.find(d => d.raport === klucz);
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
    // jak brak i zostawiamy to ostrzezeniu o zamowieniach bez tagu (Zadanie 10).
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
 * ⚠️⚠️ KONTO RECZNE TO `RECZNE`, A NIE `INDYWIDUALNE` — i to jest poprawka po pomiarze
 * na danych produkcyjnych, nie szczegol nazewniczy. Pierwotna mapa mowila „INDYWIDUALNE =
 * konto reczne LUB pozycja zaslepki", a to sa DWIE ROZLACZNE POPULACJE o dwoch roznych granicach:
 *   • zamowienia z panelu ofert: konto sklepu + pozycja zaslepki → w OMS-ie `indywidualne = 1`,
 *     z wlasna granica historii;
 *   • zamowienia reczne: osobne konto → w OMS-ie `sklep = 'reczne'`, z inna granica historii
 *     (kilkaset zamowien, rzad setek tysiecy zl).
 * Sklejone w jeden kanal daly „ten sam pieniadz po dwoch stronach granicy w dwoch roznych
 * kanalach": zaleznie od przyjetej granicy znikaly albo dublowaly sie kwoty rzedu tysiecy zl.
 * ZADNA data nie byla poprawna — dlatego kanaly sa dwa.
 */
export function kanalHistoryczny(w, klasyfikacja) {
  wymagajKlasyfikacji(klasyfikacja);
  const t = tagi(w);
  if (klasyfikacja.tagDrop !== null && t.includes(klasyfikacja.tagDrop)) return 'DROPSHIPPING';
  if (klasyfikacja.tagGdd !== null && t.includes(klasyfikacja.tagGdd)) return 'GDD';
  if (klasyfikacja.kontaB2b.has(w.platform_account_id) || (klasyfikacja.tagB2b !== null && t.includes(klasyfikacja.tagB2b))) return 'B2B';
  if ((w.pozycje ?? []).some((p) => klasyfikacja.prefiksyIndywidualne.some(prefiks => String(p.original_code ?? '').startsWith(prefiks)))) {
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
  // ⚠️⚠️ B2B WCHODZI Z KOLUMNY `zamowienia.b2b` (21.08.2026) — do tego dnia kanal B2B byl po
  // granicy z Apilo PUSTY, bo OMS nie mial czym oznaczyc hurtu. Znacznik podstawia sie z bazy
  // stalych klientow przy zakladaniu zamowienia i od tej chwili rozstrzyga ZAMOWIENIE.
  //
  // ⚠️ KOLUMNA, A NIE ODCZYT TYPU KLIENTA Z BAZY — i to jest decyzja odwracajaca pierwszy
  // plan tej funkcji (docs/superpowers/plans/2026-08-21-oms-baza-stalych-klientow.md, cz. II.5).
  // Kanaly licza sie PRZY ODCZYCIE, wiec regula pytajaca baze klientow przepisywalaby historie
  // wstecz: w dniu wdrozenia zamowienia tych klientow przeskoczylyby z „Reczne" do „B2B"
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
  // ⚠️ WYLACZNIE dla `sklep = 'reczne'`. Sprzedaz przez sklep B ma wlasny kanal
  // SKLEP_B i to on mowi, SKAD przyszly pieniadze; `B2B` w tym slowniku znaczy „sprzedaz
  // hurtowa poza sklepem" (w historii importu: konto hurtowe / tag b2b). Sklejenie ich dawaloby dwa
  // kanaly opisujace ten sam pieniadz — patrz naglowek tego pliku.
  if (w.sklep === 'reczne') {
    if (w.okres_rozliczeniowy_id) return 'DROPSHIPPING';
    return w.b2b ? 'B2B' : 'RECZNE';
  }
  const zeSklepu = klasyfikacja.sklepy.get(w.sklep);
  if (!zeSklepu) throw odmowa(`Raport nie zna tego zamówienia: nieznany sklep OMS: ${w.sklep}.`);
  return zeSklepu;
}

export function wymagajKlasyfikacji(c) {
  const id = x => Number.isSafeInteger(x) && x >= 0;
  const raport = x => typeof x === 'string' && /^[A-Z][A-Z0-9_]*$/.test(x);
  const poprawna = c && c.sklepy instanceof Map && c.konta instanceof Map && c.raporty instanceof Set
    && c.kontaB2b instanceof Set && Array.isArray(c.prefiksyIndywidualne)
    && ['tagDrop','tagGdd','tagB2b'].every(k => c[k] === null || id(c[k]))
    && [...c.sklepy].every(([k,v]) => typeof k === 'string' && k.length > 0 && raport(v) && c.raporty.has(v))
    && [...c.konta].every(([k,v]) => id(k) && raport(v) && c.raporty.has(v) && !['SKLEP','SKLEP_INDYWIDUALNE','ALLEGRO'].includes(v))
    && [...c.raporty].every(raport)
    && [...c.kontaB2b].every(k => id(k) && c.konta.get(k) === 'B2B')
    && c.prefiksyIndywidualne.every(p => typeof p === 'string' && p.trim() === p && p.length > 1 && p.endsWith('|'))
    && new Set(c.prefiksyIndywidualne).size === c.prefiksyIndywidualne.length;
  if (!poprawna) throw new TypeError('Raport wymaga jawnej klasyfikacji kanałów.');
  const tagi = [c.tagDrop,c.tagGdd,c.tagB2b].filter(v => v !== null);
  if (new Set(tagi).size !== tagi.length) throw new TypeError('Raport wymaga jawnej klasyfikacji kanałów: tagi muszą być różne.');
  return c;
}
