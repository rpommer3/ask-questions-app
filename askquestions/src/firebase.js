import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY || "AIzaSyBsYsFai_bssS_xphblqDTJ4Iz96kfOa3g",
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN || "ask-questions-app-38d69.firebaseapp.com",
  databaseURL: process.env.REACT_APP_FIREBASE_DATABASE_URL || "https://ask-questions-app-38d69-default-rtdb.firebaseio.com",
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID || "ask-questions-app-38d69",
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET || "ask-questions-app-38d69.firebasestorage.app",
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID || "994062289717",
  appId: process.env.REACT_APP_FIREBASE_APP_ID || "1:994062289717:web:c011deed25539734725a7c"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
