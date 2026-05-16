import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

  const firebaseConfig = {
    apiKey: "AIzaSyDkLMwFPuaAbXyEsOQLHpzmORYzAdaA9Eg",
    authDomain: "terraophis-project.firebaseapp.com",
    projectId: "terraophis-project",
    storageBucket: "terraophis-project.firebasestorage.app",
    messagingSenderId: "1049432785492",
    appId: "1:1049432785492:web:ab77e5d4870ef478b0e3c1",
    measurementId: "G-3RWP28C9DZ"
  };

const app = initializeApp(firebaseConfig);
// CRUCIAL : On initialise et on exporte les instances
export const db = getFirestore(app);
export const auth = getAuth(app);