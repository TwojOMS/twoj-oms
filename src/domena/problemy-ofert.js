import { kwotaDziesietna } from './cena-kanalu.js';

const OPISY = Object.freeze({
  'wiele-produktow': 'Znaleziono wiele produktów w katalogu — wybierz właściwy produkt.',
  'parameter-mismatch': 'Parametry oferty nie zgadzają się z produktem w katalogu.',
  duplikat: 'Znaleziono więcej niż jedną ofertę — wybierz właściwą ofertę.',
  walidacja: 'Oferta nie przeszła walidacji — sprawdź jej dane.',
  zakonczona: 'Oferta jest zakończona — wymaga wznowienia.',
  'brak-w-allegro': 'Allegro nie zwraca tej oferty — sprawdź ją w panelu Allegro.',
  'bez-potwierdzenia': 'Brak potwierdzenia przyjęcia oferty przez Allegro.',
  aktywacja: 'Nie udało się zakończyć aktywacji oferty.',
  komenda: 'Nie udało się wykonać polecenia zmiany oferty.',
  karta: 'Sprawdź dane karty produktu.',
  cena: 'Zmiana ceny przekracza próg — czeka na potwierdzenie.',
});

const kwota = gr => `${kwotaDziesietna(gr).replace('.', ',')} zł`;
const dzis = o => o.odczytCenaGr ?? o.wyslanaCenaGr ?? null;

const AKCJE_KANALOW = Object.freeze({
  allegro: Object.freeze({ wznow: true, cena: true }),
  erli: Object.freeze({ wznow: false, cena: true }),
});

/** Powody do wyświetlenia, w kolejności zapisanej przez pętlę. */
export function powodyProblemu(o) {
  const powody = (o.problemy ?? []).map(p => {
    if (p?.kod === 'cena' && o.cenaDoPotwierdzeniaGr != null) {
      const obecna = dzis(o);
      return `Nowa cena ${kwota(o.cenaDoPotwierdzeniaGr)}${obecna == null ? '' : ` (dziś ${kwota(obecna)})`} — zmiana ponad próg`;
    }
    if (typeof p?.tekst === 'string' && p.tekst.trim()) return p.tekst;
    return Object.hasOwn(OPISY, p?.kod) ? OPISY[p.kod] : `Problem: ${p?.kod ?? 'nieznany'}`;
  });
  if (!powody.length && o.stan === 'blad') return [o.blad || 'Błąd komunikacji z kanałem'];
  return powody;
}

/** Dane akcji; rozłączone konto i już zapisany zamiar nie dostają kolejnego przycisku. */
export function akcjeProblemu(o, typ) {
  const zakonczona = (o.problemy ?? []).find(p => p?.kod === 'zakonczona');
  const akcje = Object.hasOwn(AKCJE_KANALOW, typ) ? AKCJE_KANALOW[typ] : null;
  return {
    wznow: akcje?.wznow && zakonczona && !o.wyslanePola?.wznow
      ? {} : null,
    cena: akcje?.cena && o.cenaDoPotwierdzeniaGr != null && o.wyslanePola?.cenaPotwierdzonaGr !== o.cenaDoPotwierdzeniaGr
      ? { nowaGr: o.cenaDoPotwierdzeniaGr, dzisGr: dzis(o) } : null,
  };
}
