/**
 * src/services/firebase.js
 * Configuração, inicialização do Firebase e funções de autenticação.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, query, getDocs, doc, getDoc, setDoc, updateDoc, serverTimestamp, addDoc, orderBy, limit, where, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { showNotification } from '../utils/helpers.js';

// --- CONFIGURAÇÃO ---
const firebaseConfig = {
    apiKey: "AIzaSyBq9vMW39Cba8fqgXfRNtxqOltnTiaKjnU",
    authDomain: "controle-de-patrimonio-semcas.firebaseapp.com",
    projectId: "controle-de-patrimonio-semcas",
    storageBucket: "controle-de-patrimonio-semcas.firebasestorage.app",
    messagingSenderId: "438620819929",
    appId: "1:438620819929:web:6fcbc12905a0c928e549c8"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const serverT = serverTimestamp;

// --- AUTENTICAÇÃO ---

let authStateChangeCallbacks = [];

onAuthStateChanged(auth, user => {
    authStateChangeCallbacks.forEach(cb => cb(user));
});

export function addAuthListener(callback) {
    authStateChangeCallbacks.push(callback);
    callback(auth.currentUser);
}

export async function handleLogin(email, password) {
    try {
        await signInWithEmailAndPassword(auth, email, password);
        return true;
    } catch (error) {
        console.error("Erro no login:", error.code);
        return { success: false, code: error.code };
    }
}

export function handleLogout() {
    signOut(auth);
}

// --- FUNÇÕES DE CARREGAMENTO FIREBASE ---

export async function loadFirebaseInventory() {
    const querySnapshot = await getDocs(query(collection(db, 'patrimonio')));
    return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function loadUnitMappingFromFirestore() {
    try {
        const docRef = doc(db, 'config', 'unitMapping');
        const docSnap = await getDoc(docRef);
        return docSnap.exists() ? docSnap.data().mappings || {} : {};
    } catch (error) {
        showNotification("Erro ao carregar mapeamento de unidades.", 'error');
        console.error("Error loading unit mapping:", error);
        return {};
    }
}

export async function loadReconciledUnits() {
    try {
        const docRef = doc(db, 'config', 'reconciledUnits');
        const docSnap = await getDoc(docRef);
        return docSnap.exists() ? docSnap.data().units || [] : [];
    } catch (error) {
        showNotification("Erro ao carregar unidades conciliadas.", 'error');
        console.error("Erro ao carregar unidades conciliadas:", error);
        return [];
    }
}

export async function loadCustomGiapUnits() {
    try {
        const docRef = doc(db, 'config', 'customGiapUnits');
        const docSnap = await getDoc(docRef);
        return docSnap.exists() ? docSnap.data().units || [] : [];
    } catch (error) {
        showNotification("Erro ao carregar unidades GIAP customizadas.", 'error');
        console.error("Error loading custom GIAP units:", error);
        return [];
    }
}

export async function loadConciliationPatterns() {
    try {
        const q = query(
            collection(db, 'padroesConciliacao'),
            orderBy('timestamp', 'desc'),
            limit(300)
        );
        const snapshot = await getDocs(q);
        return snapshot.docs.map(doc => doc.data());
    } catch (error) {
        console.warn('Coleção de padrões de conciliação ainda não existe. Ignorando.');
        return [];
    }
}

export async function loadHistory() {
    if (!auth.currentUser) return [];
    try {
        const q = query(collection(db, "historico"), orderBy("timestamp", "desc"), limit(100));
        const querySnapshot = await getDocs(q);
        return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch(e){
        console.error("Error loading history: ", e);
        return [];
    }
}

export async function logAction(action, details) {
    if (!auth.currentUser) return;
    try {
        await addDoc(collection(db, 'historico'), { 
            ...details, 
            action: action, 
            user: auth.currentUser.email, 
            timestamp: serverTimestamp() 
        });
    } catch (error) { console.error("Falha ao registrar ação no histórico:", error); }
}
