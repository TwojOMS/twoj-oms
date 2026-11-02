export type KategoriaIntegracji = 'sklepy' | 'wysylka' | 'faktury' | 'poczta' | 'reklamy';
export type DostepnoscIntegracji = 'dostepna' | 'przez_konfiguracje' | 'planowana';

export interface IntegracjaKatalogu {
  id: string;
  nazwa: string;
  kategoria: KategoriaIntegracji;
  opis: string;
  logo: string;
  dostepnosc: DostepnoscIntegracji;
  href: string | null;
}

export const KATALOG_INTEGRACJI: IntegracjaKatalogu[] = [
  { id: 'allegro', nazwa: 'Allegro', kategoria: 'sklepy', opis: 'Pobieraj zamówienia z konta Allegro.', logo: '/integracje/allegro.svg', dostepnosc: 'dostepna', href: '/ustawienia/integracje' },
  { id: 'woocommerce', nazwa: 'WooCommerce', kategoria: 'sklepy', opis: 'Pobieraj zamówienia ze sklepu WooCommerce.', logo: '/integracje/woocommerce.png', dostepnosc: 'przez_konfiguracje', href: '/ustawienia/integracje' },
  { id: 'shoper', nazwa: 'Shoper', kategoria: 'sklepy', opis: 'Połączenie ze sklepem Shoper.', logo: '/integracje/shoper.svg', dostepnosc: 'planowana', href: null },
  { id: 'empik', nazwa: 'Empik', kategoria: 'sklepy', opis: 'Połączenie z Empik Marketplace.', logo: '/integracje/empik.png', dostepnosc: 'planowana', href: null },
  { id: 'erli', nazwa: 'ERLI', kategoria: 'sklepy', opis: 'Połączenie z marketplace ERLI.', logo: '/integracje/erli.png', dostepnosc: 'planowana', href: null },
  { id: 'etsy', nazwa: 'Etsy', kategoria: 'sklepy', opis: 'Połączenie z marketplace Etsy.', logo: '/integracje/etsy.svg', dostepnosc: 'planowana', href: null },
  { id: 'dpd', nazwa: 'DPD', kategoria: 'wysylka', opis: 'Nadaj przesyłki przez DPD.', logo: '/integracje/dpd.svg', dostepnosc: 'dostepna', href: '/ustawienia/integracje/dpd' },
  { id: 'inpost', nazwa: 'InPost', kategoria: 'wysylka', opis: 'Nadaj przesyłki przez InPost.', logo: '/integracje/inpost.svg', dostepnosc: 'dostepna', href: '/ustawienia/integracje/inpost' },
  { id: 'wza', nazwa: 'Wysyłam z Allegro', kategoria: 'wysylka', opis: 'Nadaj przesyłki z wykorzystaniem powiązanego konta Allegro.', logo: '/integracje/allegro.svg', dostepnosc: 'dostepna', href: '/ustawienia/integracje' },
  { id: 'gls', nazwa: 'GLS', kategoria: 'wysylka', opis: 'Połączenie z kurierem GLS.', logo: '/integracje/gls.png', dostepnosc: 'planowana', href: null },
  { id: 'infakt', nazwa: 'inFakt', kategoria: 'faktury', opis: 'Połącz konto inFakt do wystawiania faktur.', logo: '/integracje/infakt.png', dostepnosc: 'dostepna', href: '/ustawienia/integracje/infakt' },
  { id: 'fakturownia', nazwa: 'Fakturownia', kategoria: 'faktury', opis: 'Połączenie z programem Fakturownia.', logo: '/integracje/fakturownia.svg', dostepnosc: 'planowana', href: null },
  { id: 'ksef', nazwa: 'KSeF', kategoria: 'faktury', opis: 'Skonfiguruj połączenie do pobierania faktur kosztowych.', logo: '/integracje/ksef.jpg', dostepnosc: 'dostepna', href: '/ustawienia/integracje/ksef' },
  { id: 'gus', nazwa: 'GUS', kategoria: 'faktury', opis: 'Pobieraj dane firmy po numerze NIP.', logo: '/integracje/gus.svg', dostepnosc: 'dostepna', href: '/ustawienia/integracje/gus' },
  { id: 'smtp', nazwa: 'Poczta wychodząca (SMTP)', kategoria: 'poczta', opis: 'Skonfiguruj wysyłanie wiadomości e-mail.', logo: '/integracje/smtp.svg', dostepnosc: 'dostepna', href: '/ustawienia/integracje/poczta' },
  { id: 'meta', nazwa: 'Meta Ads', kategoria: 'reklamy', opis: 'Odczytuj statystyki kampanii Meta.', logo: '/integracje/meta.png', dostepnosc: 'przez_konfiguracje', href: '/ustawienia/integracje/reklamy' },
  { id: 'ga4', nazwa: 'Google Analytics 4', kategoria: 'reklamy', opis: 'Odczytuj statystyki Google Analytics 4.', logo: '/integracje/ga4.svg', dostepnosc: 'przez_konfiguracje', href: '/ustawienia/integracje/reklamy' },
  { id: 'google_ads', nazwa: 'Google Ads', kategoria: 'reklamy', opis: 'Odczytuj statystyki kampanii Google Ads.', logo: '/integracje/google-ads.svg', dostepnosc: 'przez_konfiguracje', href: '/ustawienia/integracje/reklamy' },
];

function normalizuj(tekst: string): string {
  return tekst.toLocaleLowerCase('pl').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').trim();
}

export function filtrujIntegracje({ szukaj = '', kategoria = '', planowane = true }: { szukaj?: string; kategoria?: string; planowane?: boolean } = {}): IntegracjaKatalogu[] {
  const fraza = normalizuj(szukaj);
  return KATALOG_INTEGRACJI.filter((usluga) =>
    (planowane || usluga.dostepnosc !== 'planowana') &&
    (!kategoria || usluga.kategoria === kategoria) &&
    (!fraza || normalizuj(`${usluga.nazwa} ${usluga.opis}`).includes(fraza)),
  );
}
