/** Adapter dla starszych konsumentów tablic/map. Odczyt zawsze pyta dostawcę;
 * nie wolno zapisywać do tych kolekcji ani zamrażać ich przez Object.freeze. */
export function listaNaZadanie<T>(pobierz:()=>readonly T[]):T[]{
 return new Proxy([] as T[],{
  get:(_t,k)=>Reflect.get(pobierz(),k),
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
