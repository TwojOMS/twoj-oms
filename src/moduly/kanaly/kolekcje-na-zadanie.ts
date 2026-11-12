/** Adapter dla starszych konsumentów tablic/map. Odczyt zawsze pyta dostawcę;
 * nie wolno zapisywać do tych kolekcji ani zamrażać ich przez Object.freeze. */
const MUTUJACE:ReadonlySet<PropertyKey>=new Set(['push','pop','shift','unshift','splice','sort','reverse','fill','copyWithin']);
export function listaNaZadanie<T>(pobierz:()=>readonly T[]):T[]{
 // PRZ-157.12b: metody odczytu (iterator, filter, map…) działają na jednej migawce — inaczej każdy indeks pytał
 // dostawcę od nowa, a zagnieżdżone listy (kompozycja → atrapy → raporty) mnożyły zapytania do bazy.
 return new Proxy([] as T[],{
  get:(_t,k)=>{const a=pobierz();const v=Reflect.get(a,k);return typeof v==='function'&&!MUTUJACE.has(k)?v.bind(a):v;},
  has:(_t,k)=>Reflect.has(pobierz(),k),
  ownKeys:()=>Reflect.ownKeys(pobierz()),
  getOwnPropertyDescriptor:(_t,k)=>Reflect.getOwnPropertyDescriptor(pobierz(),k),
  set:()=>{throw new Error('Lista kanałów jest tylko do odczytu.');},
 });
}
export function mapaNaZadanie<T>(klucze:()=>string[],pobierz:(klucz:string)=>T):Record<string,T>{
 return new Proxy({} as Record<string,T>,{
  get:(_t,k)=>typeof k==='string'&&klucze().includes(k)?pobierz(k):undefined,
  has:(_t,k)=>typeof k==='string'&&klucze().includes(k),
  ownKeys:()=>klucze(),
  getOwnPropertyDescriptor:(_t,k)=>typeof k==='string'&&klucze().includes(k)?{enumerable:true,configurable:true}:undefined,
  set:()=>{throw new Error('Mapa kanałów jest tylko do odczytu.');},
 });
}
