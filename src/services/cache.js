/**
 * src/services/cache.js
 * Configuração e interface para o cache IndexedDB (Dexie.js).
 */

// Biblioteca Dexie (IndexadoDB)
// CORREÇÃO: A importação correta é a 'default export' (a classe Dexie), 
// e não uma 'named export' chamada 'idb'.
import Dexie from "https://unpkg.com/dexie@latest/dist/dexie.js";

// A linha abaixo foi removida pois 'Dexie' já é o nome da classe importada.
// const Dexie = dexieDB;

export const CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 horas

export const idb = new Dexie('InventoryDB');
idb.version(3).stores({
    // Indices primários (id, TOMBAMENTO) e secundários (*Unidade, *Tipo)
    patrimonio: 'id, Tombamento, *Unidade, *Tipo, *Estado',
    giap: '++_id, TOMBAMENTO, *Unidade',
    metadata: 'key' // Para armazenar a data do último fetch
});

/**
 * Verifica se o cache local expirou.
 * @returns {Promise<boolean>} True se expirou ou não existe.
 */
export async function isCacheStale() {
    const metadata = await idb.metadata.get('lastFetch');
    return !metadata || (Date.now() - metadata.timestamp > CACHE_DURATION_MS);
}

/**
 * Atualiza o cache com novos dados.
 * @param {Array<object>} freshPatrimonio - Dados do inventário do Firebase.
 * @param {Array<object>} freshGiapData - Dados do GIAP.
 */
export async function updateLocalCache(freshPatrimonio, freshGiapData) {
    await idb.transaction('rw', idb.patrimonio, idb.giap, idb.metadata, async () => {
        await idb.patrimonio.clear();
        await idb.giap.clear();
        await idb.patrimonio.bulkAdd(freshPatrimonio);
        await idb.giap.bulkAdd(freshGiapData);
        await idb.metadata.put({ key: 'lastFetch', timestamp: Date.now() });
    });
}

/**
 * Carrega todos os dados do cache.
 * @returns {Promise<[Array<object>, Array<object>]>} [patrimonioFullList, giapInventory]
 */
export async function loadFromCache() {
    return Promise.all([
        idb.patrimonio.toArray(),
        idb.giap.toArray()
    ]);
}
