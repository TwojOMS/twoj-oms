import {UPRAWNIENIA_NOWEGO_POLACZENIA} from '../../oms/allegro/oauth-code.ts';

export type SrodowiskoInstrukcji='produkcja'|'sandbox';

/** Adresy panelu deweloperskiego Allegro — jedyne miejsce w kodzie. */
export const ADRESY_PANELU_DEVELOPERA:Readonly<Record<SrodowiskoInstrukcji,string>>=Object.freeze({
 produkcja:'apps.developer.allegro.pl',
 sandbox:'apps.developer.allegro.pl.allegrosandbox.pl',
});

/** Opisy po polsku; brak opisu dla uprawnienia ze stałej łamie test. */
export const OPISY_UPRAWNIEN:Readonly<Record<string,string>>=Object.freeze({
 'allegro:api:orders:read':'zamówienia — odczyt',
 'allegro:api:orders:write':'zamówienia — zmiana statusów',
 'allegro:api:sale:offers:read':'oferty — odczyt',
 'allegro:api:shipments:read':'przesyłki — odczyt',
 'allegro:api:shipments:write':'przesyłki — nadawanie i etykiety',
 'allegro:api:messaging':'wiadomości od kupujących',
 'allegro:api:disputes':'dyskusje i reklamacje — odczyt',
 'allegro:api:profile:read':'profil konta — login i numer konta',
});

export const CEL_APLIKACJI='Twój OMS łączy się z Allegro przez aplikację Twojej firmy. Zakładasz ją raz; potem podłączysz nią jedno albo kilka kont Allegro.';
export const TYP_APLIKACJI='Aplikacja będzie działać w środowisku bez dostępu do przeglądarki albo klawiatury';


/** Uprawnienia do wyświetlenia — zawsze z tej samej stałej, którą prosi o nie Device Flow. */
export function uprawnieniaDoZaznaczenia(){
 return UPRAWNIENIA_NOWEGO_POLACZENIA.map(nazwa=>({nazwa,opis:OPISY_UPRAWNIEN[nazwa]??''}));
}

/** Kroki instrukcji jako zwykłe teksty; kod w widoku wstawia nazwy techniczne w <code>. */
export function krokiInstrukcji(s:SrodowiskoInstrukcji){
 const adres=ADRESY_PANELU_DEVELOPERA[s];
 return [
  {tekst:'Zaloguj się na allegro.pl kontem firmy i otwórz',kod:adres,po:s==='sandbox'?'(to adres środowiska testowego Allegro Sandbox).':'. Na koncie produkcyjnym Allegro wymaga włączonego logowania dwustopniowego.'},
  {tekst:'Dodaj nową aplikację.'},
  {tekst:'Nazwa — Allegro pokaże ją przy wyrażaniu zgody, np. „OMS Pracownia Półcień”. Opis jest nieobowiązkowy.'},
  {tekst:'Typ aplikacji — zaznacz:',cytat:TYP_APLIKACJI,po:'. Typu nie da się później zmienić. Adresu przekierowania nie podajesz.'},
  {tekst:'W sekcji Uprawnienia zaznacz wszystkie z listy poniżej.',lista:true,po:'W istniejącej aplikacji uprawnienia zmienisz w Zarządzanie aplikacjami → edycja.'},
  {tekst:'Zaakceptuj regulamin REST API i zatwierdź formularz.'},
  {tekst:'Skopiuj Client ID i Client Secret z karty aplikacji i wklej poniżej.'},
 ];
}
