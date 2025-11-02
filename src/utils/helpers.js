/**
 * src/utils/helpers.js
 * Funções utilitárias comuns: notificação, normalização de string, debounce e manipulação de moeda.
 */

/**
 * Exibe uma notificação flutuante (toast).
 * @param {string} message - A mensagem a ser exibida.
 * @param {'info'|'success'|'error'|'warning'} type - O tipo de notificação.
 * @param {number} duration - Duração em milissegundos.
 */
export function showNotification(message, type = 'info', duration = 3000) {
    const notification = document.createElement('div');
    notification.className = `notification-toast ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => notification.classList.add('show'), 10);
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 500);
    }, duration);
}

/**
 * Mostra uma tela de carregamento sobre toda a página.
 * @param {string} message - Mensagem a ser exibida no overlay.
 */
export function showOverlay(message) {
    const overlay = document.getElementById('full-page-overlay');
    const overlayMessage = document.getElementById('overlay-message');
    if (overlay && overlayMessage) {
        overlayMessage.textContent = message;
        overlay.classList.remove('hidden');
    }
}

/**
 * Esconde a tela de carregamento.
 */
export function hideOverlay() {
    const overlay = document.getElementById('full-page-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
    }
}

/**
 * Normaliza uma string (remove acentos, espaços extras e converte para minúsculas).
 * @param {string} str 
 * @returns {string}
 */
export const normalizeStr = (str) => (str || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/**
 * Cria uma versão "debounced" de uma função (atrasa sua execução).
 * @param {function} func - A função a ser executada.
 * @param {number} delay - O atraso em milissegundos.
 * @returns {function}
 */
export const debounce = (func, delay) => {
    let t;
    return (...a) => {
        clearTimeout(t);
        t = setTimeout(() => func.apply(this, a), delay);
    };
};

/**
 * Escapa caracteres HTML para prevenir XSS.
 * @param {string} unsafe - A string a ser escapada.
 * @returns {string}
 */
export const escapeHtml = (unsafe) => (unsafe === undefined || unsafe === null) ? '' : unsafe.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

/**
 * Converte uma string de moeda brasileira (R$) para um número.
 * @param {string} value 
 * @returns {number}
 */
export const parseCurrency = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return 0;
    return parseFloat(value.replace('R$', '').replace(/\./g, '').replace(',', '.').trim()) || 0;
};

/**
 * Normaliza o campo 'Tombamento' para garantir que números sejam tratados consistentemente.
 * @param {string|number} tombo - O valor do campo tombamento.
 * @returns {string} O valor normalizado.
 */
export const normalizeTombo = (tombo) => {
    if (tombo === undefined || tombo === null || String(tombo).trim() === '') {
        return '';
    }
    let str = String(tombo).trim();
    if (/^0?\d+(\.0)?$/.test(str)) {
        return String(parseInt(str, 10));
    }
    return str;
};

/**
 * Analisa o campo 'Estado e Origem da Doação' e separa as informações.
 * @param {string} texto - O texto do campo 'Estado e Origem da Doação'
 * @returns {{estado: string, origem: string}} 
 */
export function parseEstadoEOrigem(texto) {
    const textoCru = (texto || '').trim();
    if (!textoCru) return { estado: 'Regular', origem: '' };

    const validEstados = ['Novo', 'Bom', 'Regular', 'Avariado'];
    let estadoFinal = 'Regular';
    let origemFinal = '';

    for (const estado of validEstados) {
        if (normalizeStr(textoCru).startsWith(normalizeStr(estado))) {
            estadoFinal = estado;
            let resto = textoCru.substring(estado.length).trim();
            
            if ((resto.startsWith('(') && resto.endsWith(')')) || (resto.startsWith('[') && resto.endsWith(']'))) {
                resto = resto.substring(1, resto.length - 1).trim();
            } else if (resto.startsWith('-')) {
                resto = resto.substring(1).trim();
            }

            if (resto) {
                const restoNormalizado = normalizeStr(resto);
                if (restoNormalizado.startsWith('doação') || restoNormalizado.startsWith('doacao')) {
                    origemFinal = resto.replace(/^(doação|doacao)\s*/i, '').trim();
                } else {
                    origemFinal = resto.trim(); // Se não for 'doação', assume que é apenas a origem
                }
            }
            return { estado: estadoFinal, origem: origemFinal };
        }
    }
    
    for (const estado of validEstados) {
        if (normalizeStr(textoCru) === normalizeStr(estado)) {
            return { estado: estado, origem: '' };
        }
    }
    
    return { estado: 'Regular', origem: '' };
}

/**
 * Converte data em formato DD/MM/AAAA para objeto Date.
 * @param {string} dateStr - Data no formato DD/MM/AAAA.
 * @returns {Date}
 */
export function parsePtBrDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return new Date(0); 
    const parts = dateStr.split('/');
    if (parts.length === 3) {
        return new Date(parts[2], parts[1] - 1, parts[0]);
    }
    const isoParts = dateStr.split('-');
    if(isoParts.length === 3) {
        return new Date(isoParts[0], isoParts[1] - 1, isoParts[2]);
    }
    return new Date(0);
}
