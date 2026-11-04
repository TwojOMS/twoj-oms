// PRZ-150.01: klient kreatora Woo dla sklepu przykładowego piaskownicy (tryb proba, adres atrapy z konfiguracji
// kanałów). Adres atrapy (domena .invalid) nie istnieje w sieci, więc prawdziwy klient kończył kreator komunikatem
// „Nie udało się odnaleźć sklepu”. Ta atrapa odpowiada bez sieci: klucze w formacie ck_…/cs_… przechodzą, metody
// wysyłki i bramki płatności są zmyślone, w tym samym kształcie co z createWooClient (src/oms/woo/client.js).
export function klientSklepuPrzykladowego(d:{ck:string;cs:string}){
 const kluczeOk=/^ck_\S+$/.test(d.ck)&&/^cs_\S+$/.test(d.cs);
 const odmowa=async()=>{
  const e=new Error('Sklep przykładowy nie obsługuje tej operacji. Nic nie zostało wysłane.');
  e.name='WooOperacjaPrzykladowa';throw e;
 };
 return {
  // Poller ma pusty wynik jak w createWooClient; pozostałe operacje jawnie odmawiają, bez zapisu.
  pobierzZamowienia:async(_o:{modifiedAfter?:string|null;page?:number}={})=>({zamowienia:[],stron:1}),
  pobierzZamowieniaZakresu:odmowa,pobierzWszystkieProdukty:odmowa,pobierzWarianty:odmowa,
  pobierzMiniatury:odmowa,ustawienieSklepu:odmowa,pobierzProdukt:odmowa,zapiszProdukt:odmowa,
  dodajNotatke:odmowa,ustawStatus:odmowa,
  sprawdzPolaczenie:async()=>kluczeOk?{ok:true}:{ok:false,powod:'klucze'},
  pobierzMetodyWysylki:async()=>[
   {strefa:'Polska',instanceId:1,tytul:'Kurier',metodaWoo:'flat_rate',wlaczona:true},
   {strefa:'Polska',instanceId:2,tytul:'Paczkomat',metodaWoo:'flat_rate',wlaczona:true},
   {strefa:'Pozostałe lokalizacje',instanceId:3,tytul:'Odbiór osobisty',metodaWoo:'local_pickup',wlaczona:true},
  ],
  pobierzBramkiPlatnosci:async()=>[
   {id:'cod',tytul:'Płatność przy odbiorze',nazwaWoo:'Pobranie',wlaczona:true},
   {id:'bacs',tytul:'Przelew bankowy',nazwaWoo:'Przelew',wlaczona:true},
  ],
 };
}
