/**
 * src/state/globalStore.js
 * Gerenciador de estado central da aplicação.
 * Qualquer alteração de dados deve passar pela função setState.
 */

const initialState = {
    // Dados Principais
    patrimonioFullList: [],
    giapInventory: [],
    historicoFullList: [],
    padroesConciliacao: [],
    
    // Configurações de Edição
    unitMapping: {},
    reconciledUnits: [],
    customGiapUnits: [],

    // Estado da UI
    isLoggedIn: false,
    authReady: false,
    initialLoadComplete: false,
    statusMessage: 'Iniciando sistema...',
};

let state = { ...initialState };
const listeners = [];

/**
 * Adiciona uma função a ser chamada sempre que o estado mudar.
 * @param {function} callback - Função que recebe o estado atual.
 */
export function subscribe(callback) {
    listeners.push(callback);
    callback(state); // Chama imediatamente para carregar o estado inicial
}

/**
 * Atualiza o estado da aplicação e notifica todos os listeners.
 * @param {object} newState - Objeto contendo as propriedades a serem atualizadas.
 */
export function setState(newState) {
    state = { ...state, ...newState };
    listeners.forEach(callback => callback(state));
    console.debug('Estado atualizado:', newState);
}

/**
 * Retorna o estado atual.
 * @returns {object}
 */
export function getState() {
    return state;
}

/**
 * Reseta o estado (ex: no logout).
 */
export function resetState() {
    state = { ...initialState };
    listeners.forEach(callback => callback(state));
}
