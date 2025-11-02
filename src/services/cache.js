/**
 * src/services/cache.js
 * Configuração e interface para o cache IndexedDB (Dexie.js).
 * Compatível com execução direta em navegador (GitHub Pages, Firebase Hosting etc.)
 */

// ✅ Importação corrigida do Dexie — versão estável e compatível com ESM
import Dexie from "https://esm.sh/dexie@3.2.4";

// Duração do cache local (6 horas)
export const CACHE_DURATION_MS = 6 * 60 * 60 * 1000;

// Inicialização do banco IndexedDB com Dexie
export const idb = new Dexie('InventoryDB');

idb.version(3).stores({
    // Índices primários e secundários
    patrimonio: 'id, Tombamento, *Unidade, *Tipo, *Estado',
    giap: '++_id, TOMBAMENTO, *Unidade',
    metadata: 'key' // Para armazenar metadados, como a data do último fetch
});

/**
 * Verifica se o cache local expirou.
 * @returns {Promise<boolean>} True se expirou ou não existe.
 */
export async function isCacheStale() {
    try {
        const metadata = await idb.metadata.get('lastFetch');
        return !metadata || (Date.now() - metadata.timestamp > CACHE_DURATION_MS);
    } catch (error) {
        console.error("Erro ao verificar validade do cache:", error);
        return true; // Se algo der errado, força atualização
    }
}

/**
 * Atualiza o cache local com novos dados.
 * @param {Array<object>} freshPatrimonio - Dados do inventário do Firebase.
 * @param {Array<object>} freshGiapData - Dados do GIAP.
 */
export async function updateLocalCache(freshPatrimonio = [], freshGiapData = []) {
    try {
        await idb.transaction('rw', idb.patrimonio, idb.giap, idb.metadata, async () => {
            await idb.patrimonio.clear();
            await idb.giap.clear();
            if (freshPatrimonio.length) await idb.patrimonio.bulkAdd(freshPatrimonio);
            if (freshGiapData.length) await idb.giap.bulkAdd(freshGiapData);
            await idb.metadata.put({ key: 'lastFetch', timestamp: Date.now() });
        });
    } catch (error) {
        console.error("Erro ao atualizar o cache local:", error);
    }
}

/**
 * Carrega todos os dados do cache.
 * @returns {Promise<[Array<object>, Array<object>]>} [patrimonioFullList, giapInventory]
 */
export async function loadFromCache() {
    try {
        const patrimonio = await idb.patrimonio.toArray();
        const giap = await idb.giap.toArray();
        return [patrimonio, giap];
    } catch (error) {
        console.error("Erro ao carregar dados do cache:", error);
        return [[], []];
    }
}
