const PROMPTY = Object.freeze({
  ga4: `Pracujesz w mojej instalacji TwójOMS. Przeczytaj lokalne instrukcje projektu w docs/oms/REKLAMY-PODLACZENIE.md i sprawdź istniejącą konfigurację integracji reklam. Pomóż mi podłączyć moją właściwość GA4 do odczytu statystyk kampanii Google Ads. Wskaż dokładnie, jakie kroki mam wykonać w Google Analytics i Google Cloud: włączenie Data API, dostęp konta usługowego tylko do odczytu oraz powiązanie właściwości z moim kontem Google Ads. Skonfiguruj bezpieczne przechowywanie klucza poza repo i bazą zamówień, przypisz właściwość do właściwego kanału OMS, uruchom test odczytu i pokaż okres pierwszych danych. Nie proś o wklejenie klucza w rozmowie ani nie zapisuj go w logach. Nie zmieniaj kampanii ani budżetów.`,
  google_ads: `Pracujesz w mojej instalacji TwójOMS. Przeczytaj lokalne instrukcje projektu w docs/oms/REKLAMY-PODLACZENIE.md i sprawdź, czy działa już odczyt Google przez GA4. Google Ads API jest opcjonalnym rozszerzeniem. Oceń, czy moje konto może uzyskać produkcyjny dostęp do Google Ads API, w tym token dewelopera i OAuth. Jeśli tak, poprowadź mnie przez nadanie wyłącznie odczytu, zapisz poświadczenia poza repo, bazą zamówień i rozmową oraz sprawdź na moim koncie odczyt statusu, budżetu i konwersji. Jeśli dostęp nie jest jeszcze możliwy, pozostaw raport GA4 i pokaż w panelu pola czekające na Ads API. Nie zmieniaj reklam ani budżetów.`,
  meta: `Pracujesz w mojej instalacji TwójOMS. Przeczytaj lokalną instrukcję docs/oms/REKLAMY-PODLACZENIE.md i sprawdź aktualny stan połączeń. Poprowadź mnie przez utworzenie dostępu Meta tylko do odczytu statystyk mojego konta reklamowego. Zapisz token poza repo i rozmową, w sekretach serwera poza bazą zamówień. Jeśli panel działa tylko przez HTTP, nie wpisuj tokenu w formularzu. Przypisz konto do właściwego kanału OMS i wykonaj test kampanii oraz dziennych insights. Rozróżnij brak emisji od braku uprawnień i powiedz, czy mam dostęp do zdarzeń zakupu. Nie twórz ani nie zmieniaj reklam lub budżetów.`,
});

export function promptReklam(typ) {
  if (!Object.hasOwn(PROMPTY, typ)) {
    throw new TypeError(`Nieznane źródło reklam: ${String(typ)}`);
  }
  return PROMPTY[typ];
}
