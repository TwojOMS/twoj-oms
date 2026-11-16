import type {DatabaseSync} from 'node:sqlite';

/** Pola stanów na koncie kanału (bufor, próg skoku, krok „Stany” Woo) pokazujemy dopiero,
 * gdy stany magazynowe choć raz były włączone. Do tej chwili ekrany konfiguratorów są takie jak bez stanów. */
export function stanyKiedysWlaczone(db:DatabaseSync):boolean{
 try{return db.prepare('SELECT 1 FROM magazyn_przelaczenia WHERE wlaczone = 1 LIMIT 1').get()!==undefined;}
 catch{return false;}
}
