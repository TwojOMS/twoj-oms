// SLOWNIK METOD PLATNOSCI — regula dzialajaca PRZY ODCZYCIE (audyt 22.08.2026).
//
// Metoda platnosci przychodzi ze sklepu jako WOLNY TEKST (`payment_method_title`), wiec
// baza trzyma „BLIK" i „Blik" jako dwa byty i trzy rozne „przelewy". Normalizacja siedzi
// w JEDNEJ czystej funkcji i obowiazuje przy odczycie (filtry, opcje pola wyboru) — surowa
// wartosc w bazie zostaje nietknieta, dzieki czemu regula obejmuje wstecznie wszystkie
// zamowienia bez backfillu, a karta dalej pokazuje doslownie to, co przyslal sklep.
// Ten sam wzorzec, co „status wyliczany z faktow".
//
// ⚠️ NIEZNANA BRAMKA PRZECHODZI BEZ SKLEJANIA. Sklep doklada bramki bez pytania nas
// o zdanie (uzasadnienie przy metodyPlatnosciWBazie), wiec kubelek „inne" ukrywalby nowa
// bramke az do recznego przegladu. Przepustka pokazuje ja pod wlasna nazwa od pierwszego
// zamowienia.
//
// ⚠️ KOLEJNOSC REGUL JEST TRESCIA: „Przelewy24" zawiera slowo „przelew", wiec p24 musi
// stac PRZED przelewem — inaczej bramka online wpada do przelewow tradycyjnych i saldo
// „ile przyszlo przelewem" klamie.

const KANONICZNE = [
  { klucz: 'przelewy24', etykieta: 'Przelewy24', wzorce: ['przelewy24', 'p24'] },
  { klucz: 'przelew', etykieta: 'Przelew', wzorce: ['przelew'] },
  { klucz: 'blik', etykieta: 'BLIK', wzorce: ['blik'] },
  { klucz: 'pobranie', etykieta: 'Za pobraniem', wzorce: ['pobran'] },
  { klucz: 'allegro', etykieta: 'Allegro (płatność online)', wzorce: ['allegro'] },
  { klucz: 'payu', etykieta: 'PayU', wzorce: ['payu'] },
  { klucz: 'apple_pay', etykieta: 'Apple Pay', wzorce: ['apple'] },
  { klucz: 'karta', etykieta: 'Karta', wzorce: ['karta', 'card'] },
  { klucz: 'gotowka', etykieta: 'Gotówka', wzorce: ['gotowka', 'gotówka'] },
];

// Pusta metoda NIE znika — dostaje jawny kubelek. Na produkcji to 11 wplat na 3194,56 zl
// (drugie miejsce po sumie): niewidoczne w filtrze wygladaloby jak „mniej pieniedzy",
// a nie jak „brak etykiety".
const NIEOKRESLONA = { klucz: 'nieokreslona', etykieta: 'Nieokreślona' };

export function normalizujMetode(surowa) {
  const s = String(surowa ?? '').trim();
  if (!s) return { ...NIEOKRESLONA };
  const male = s.toLowerCase();
  for (const k of KANONICZNE) {
    if (k.klucz === male) return { klucz: k.klucz, etykieta: k.etykieta };
    if (k.wzorce.some((w) => male.includes(w))) return { klucz: k.klucz, etykieta: k.etykieta };
  }
  if (male === NIEOKRESLONA.klucz) return { ...NIEOKRESLONA };
  // Przepustka: nieznana bramka pod wlasna nazwa (klucz = doslowna wartosc po trim).
  return { klucz: s, etykieta: s };
}

/**
 * Opcje pola wyboru filtra — z SUROWYCH wartosci z bazy (metodyPlatnosciWBazie), sklejone
 * normalizacja w unikalne kubelki i posortowane po etykiecie po polsku. Lista dalej „idzie
 * z bazy": kubelek istnieje tylko wtedy, gdy ma za soba choc jedno zamowienie.
 */
export function opcjeMetodPlatnosci(surowe) {
  const kubelki = new Map();
  for (const s of surowe ?? []) {
    const n = normalizujMetode(s);
    if (!kubelki.has(n.klucz)) kubelki.set(n.klucz, n);
  }
  return [...kubelki.values()].sort((a, b) => a.etykieta.localeCompare(b.etykieta, 'pl'));
}

// Opcje pola wyboru na formularzu wplaty recznej (karta zamowienia). Etykiety ida do bazy
// WPROST — surowa kolumna ma zostac czytelna dla czlowieka, a normalizacja i tak skleja je
// z odpowiednikami ze sklepow. Kazda pozycja MUSI normalizowac sie do klucza kanonicznego
// (pilnuje tego test) — wpis-przepustka oznaczalby literowke w tej liscie.
export const METODY_WPLATY_RECZNEJ = ['Przelew', 'BLIK', 'Gotówka', 'Karta', 'Za pobraniem'];
