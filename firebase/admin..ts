import admin from "firebase-admin";

const serviceAccount: any = {
  type: "service_account",
  project_id: "project2-f5cb2",
  private_key_id: "40db8b59f8965f04c080f0b83c5579ff195b6432",
  private_key: "-----BEGIN PRIVATE KEY-----\n...YOUR_KEY...\n-----END PRIVATE KEY-----\n",
  client_email: "project2-service-account@project2-f5cb2.iam.gserviceaccount.com",
  client_id: "101614200308291357992",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/project2-service-account%40project2-f5cb2.iam.gserviceaccount.com",
  universe_domain: "googleapis.com",
};

// Initialize Firebase Admin
console.log("🔥 Initializing Firebase Admin...");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log("✅ Firebase Admin initialized.");

export const db = admin.firestore();
export default admin;
