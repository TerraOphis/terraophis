// 1. Importation des modules
const express = require('express');
const cors = require('cors');
require('dotenv').config(); // Charge les variables du fichier .env

const multer = require('multer');
const sharp = require('sharp');
const { S3Client, PutObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const archiver = require('archiver');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// //////////////////////////////////////////////////
// 🛡️ MIDDLEWARE DE SÉCURITÉ ADMIN
// //////////////////////////////////////////////////
const verifyAdmin = async (req, res, next) => {
    // 1. On vérifie si un token est présent dans l'en-tête de la requête
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Accès refusé : Token d'authentification manquant." });
    }

    // 2. On extrait le token (en enlevant le mot "Bearer ")
    const idToken = authHeader.split('Bearer ')[1];

    try {
        // 3. On demande à Firebase de vérifier si le token est authentique et non expiré
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        
        // 4. VÉRIFICATION ULTIME : Est-ce que c'est bien Martin ?
        if (decodedToken.email !== "martin.stuis11@gmail.com") {
            console.warn(`Tentative d'accès non autorisé par : ${decodedToken.email}`);
            return res.status(403).json({ error: "Accès interdit : Droits administrateur requis." });
        }

        // Si tout est bon, on laisse passer la requête à la suite du code
        req.user = decodedToken;
        next(); 
    } catch (error) {
        console.error("Erreur de validation du token :", error.message);
        return res.status(401).json({ error: "Token invalide ou expiré." });
    }
};

// NOUVEAU : Initialisation Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true, 
    auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD
    }
});

// Configuration Cloudflare R2
const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    }
});

// Configuration Multer (stockage temporaire en mémoire RAM)
const upload = multer({ storage: multer.memoryStorage() });

// 2. Initialisation de l'application
const app = express();
const PORT = process.env.PORT || 3000;


// Route Webhook Stripe
/*app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Erreur de signature Webhook :', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const orderId = session.client_reference_id;
        const amountPaidThisSession = session.amount_total / 100;

        console.log(`✅ Paiement Stripe validé : ${orderId} (${amountPaidThisSession}€)`);

        try {
            const orderRef = admin.firestore().collection('orders').doc(orderId);
            const orderSnap = await orderRef.get();
            const orderData = orderSnap.data();

            const currentAmountPaid = orderData.amountPaid || 0;
            const updateObj = { amountPaid: currentAmountPaid + amountPaidThisSession };

            const messageId = session.metadata ? session.metadata.messageId : null;
            if (messageId) {
                await orderRef.collection('messages').doc(messageId).update({ status: 'paid' });
                
                // NOUVEAU : On marque spécifiquement l'extra comme "payé" dans l'array extras
                if (orderData.extras && orderData.extras.length > 0) {
                    updateObj.extras = orderData.extras.map(ex => {
                        if (ex.messageId === messageId) return { ...ex, isPaid: true };
                        return ex;
                    });
                }
            } else {
                updateObj.status = 'Payé';
                updateObj.paymentDate = admin.firestore.FieldValue.serverTimestamp();
            }

            await orderRef.update(updateObj);
            
            // On met à jour l'objet pour la fonction de nettoyage
            if (updateObj.extras) orderData.extras = updateObj.extras;

            // Appel de la fonction de nettoyage
            await unlockOrderPhotos(orderId, orderData);

        } catch(e) {
            console.error("Erreur Webhook :", e);
        }
    }
    res.json({ received: true });
});*/

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Erreur de signature Webhook :', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const orderId = session.client_reference_id;
        const amountPaidThisSession = session.amount_total / 100;

        console.log(`✅ Paiement Stripe validé pour la commande : ${orderId} (${amountPaidThisSession}€)`);

        try {
            const orderRef = admin.firestore().collection('orders').doc(orderId);
            const orderSnap = await orderRef.get();
            
            if (orderSnap.exists) {
                const orderData = orderSnap.data();
                if (orderData.items && orderData.items.length > 0) {
                    const batch = admin.firestore().batch();
                    for (const item of orderData.items) {
                        const productRef = admin.firestore().collection('products').doc(item.id);
                        batch.update(productRef, {
                            stock: admin.firestore.FieldValue.increment(-item.quantity)
                        });
                    }
                    await batch.commit();
                    console.log(`📦 Stocks déduits avec succès pour la commande ${orderId}`);
                }
            }

            // NOUVEAU : Extraction sécurisée des détails de livraison et de contact client
            const shipping = session.shipping_details;
            const customer = session.customer_details;

            await orderRef.update({
                status: 'Payé',
                amountPaid: amountPaidThisSession,
                paymentDate: admin.firestore.FieldValue.serverTimestamp(),
                // Stockage des informations acheteur
                customerEmail: customer?.email || 'Non renseigné',
                customerName: shipping?.name || customer?.name || 'Inconnu',
                shippingAddress: shipping ? {
                    line1: shipping.address.line1,
                    line2: shipping.address.line2 || '',
                    city: shipping.address.city,
                    postalCode: shipping.address.postal_code,
                    country: shipping.address.country
                } : null
            });

        } catch(e) {
            console.error("Erreur lors du traitement Firestore du Webhook :", e);
        }
    }
    res.json({ received: true });
});


// NOUVEAU : Retrait de verifyAdmin pour autoriser les clients à valider leur panier gratuit
app.post('/api/free-order', async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: "orderId manquant" });

        const orderRef = admin.firestore().collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        if(!orderSnap.exists) return res.status(404).json({ error: "Commande introuvable" });
        
        const orderData = orderSnap.data();

        // //////////////////////////////////////////////////
        // NOUVEAU: Anti-hack de validation forcée
        // //////////////////////////////////////////////////
        if (orderData.amountValue > 0) {
            return res.status(403).json({ error: "Cette commande n'est pas gratuite." });
        }
        // //////////////////////////////////////////////////

        await orderRef.update({
            status: 'Payé',
            paymentDate: admin.firestore.FieldValue.serverTimestamp(),
            amountPaid: 0
        });

        console.log(`✅ Commande 0€ (Crédits) validée : ${orderId}`);
        await unlockOrderPhotos(orderId, orderData);

        res.status(200).json({ message: "Commande validée avec succès" });
    } catch (e) {
        console.error("Erreur Free Order :", e);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

// Tes Middlewares existants
app.use(cors()); 
app.use(express.json()); // <--- Le Webhook doit impérativement être au dessus de cette ligne
const path = require('path');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/produit', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'produit.html'));
});

// NOUVEAU : Création de la session de paiement
/*app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { orderId, userEmail, messageId } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: "Paramètres manquants (orderId)." });
        }

        // //////////////////////////////////////////////////
        // NOUVEAU: Le serveur calcule le prix via Firestore
        // //////////////////////////////////////////////////
        const orderRef = admin.firestore().collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        
        if (!orderSnap.exists) {
            return res.status(404).json({ error: "Commande introuvable." });
        }
        
        const orderData = orderSnap.data();
        let amountToPay = 0;
        
        if (messageId) {
            const msgRef = await admin.firestore().collection('orders').doc(orderId).collection('messages').doc(messageId).get();
            if(!msgRef.exists) return res.status(404).json({ error: "Extra introuvable." });
            amountToPay = msgRef.data().extraPrice;
        } else {
            const total = orderData.amountValue || 0;
            const paid = orderData.amountPaid || 0;
            const depositReq = parseFloat(orderData.depositRequested) || 0;
            
            amountToPay = Math.max(0, total - paid);
            if (depositReq > 0 && paid < depositReq) {
                amountToPay = depositReq - paid;
            }
        }
        
        if (amountToPay <= 0) {
            return res.status(400).json({ error: "Rien à payer pour cette commande." });
        }
        // //////////////////////////////////////////////////

        let clientUrl = process.env.CLIENT_URL || req.headers.origin || 'http://localhost:3000';
        if (clientUrl.endsWith('/')) {
            clientUrl = clientUrl.slice(0, -1);
        }

        const metadataParams = messageId ? { messageId: String(messageId) } : {};

        const sessionConfig = {
            payment_method_types: ['card'],
            client_reference_id: String(orderId),
            metadata: metadataParams,
            line_items: [
                {
                    price_data: {
                        currency: 'eur',
                        product_data: {
                            name: `Commande M2S #${String(orderId).slice(0,6).toUpperCase()}`,
                            description: 'Déblocage de vos photographies Haute Définition'
                        },
                        unit_amount: Math.round(parseFloat(amountToPay) * 100), 
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: `${clientUrl}/?payment=success#profil`,
            cancel_url: `${clientUrl}/?payment=cancel#profil`,
        };

        if (userEmail) {
            sessionConfig.customer_email = userEmail;
        }

        const session = await stripe.checkout.sessions.create(sessionConfig);

        res.status(200).json({ url: session.url });
    } catch (error) {
        console.error("Erreur Stripe Checkout :", error.message || error);
        res.status(500).json({ error: "Erreur Stripe : " + (error.message || "Impossible de créer la session.") });
    }
});*/

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { orderId, userEmail } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: "Paramètre manquant (orderId)." });
        }

        const orderRef = admin.firestore().collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        
        if (!orderSnap.exists) {
            return res.status(404).json({ error: "Commande introuvable." });
        }
        
        const orderData = orderSnap.data();
        const amountToPay = orderData.amountValue || 0;
        
        if (amountToPay <= 0) {
            return res.status(400).json({ error: "Aucun montant à régler pour cette commande." });
        }

        let clientUrl = process.env.CLIENT_URL || req.headers.origin || 'http://localhost:3000';
        if (clientUrl.endsWith('/')) {
            clientUrl = clientUrl.slice(0, -1);
        }

        const sessionConfig = {
            payment_method_types: ['card'],
            client_reference_id: String(orderId),
            // NOUVEAU : Activation de la collecte obligatoire de l'adresse de livraison
            shipping_address_collection: {
                allowed_countries: ['FR', 'BE', 'CH', 'LU'],
            },
            line_items: [
                {
                    price_data: {
                        currency: 'eur',
                        product_data: {
                            name: `Commande Terraophis #${String(orderId).slice(0,6).toUpperCase()}`,
                            description: 'Votre sélection d\'arthropodes et matériels d\'élevage'
                        },
                        unit_amount: Math.round(parseFloat(amountToPay) * 100), 
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: `${clientUrl}/confirmation.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${clientUrl}/`,
        };

        if (userEmail) {
            sessionConfig.customer_email = userEmail;
        }

        const session = await stripe.checkout.sessions.create(sessionConfig);

        res.status(200).json({ url: session.url });
    } catch (error) {
        console.error("Erreur Stripe Checkout :", error.message || error);
        res.status(500).json({ error: "Erreur Stripe : " + (error.message || "Impossible de créer la session de paiement.") });
    }
});

// 4. Création d'une route de test
app.get('/api/ping', (req, res) => {
    res.send('API M2S Photo en ligne ! 🚀');
});

app.post('/api/upload', verifyAdmin, upload.array('photos', 5), async (req, res) => { 
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "Aucun fichier reçu." });
        }

        let folderName = req.body.folderName || 'products';
        folderName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');

        const uploadPromises = req.files.map(async (file) => {
            const fileName = `${Date.now()}-${file.originalname.replace(/\s/g, '_')}`;
            const basePath = `${folderName}/${fileName}`;

            // On garde Sharp uniquement pour optimiser le poids de l'image pour le web
            const buffer = await sharp(file.buffer)
                .rotate()
                .resize({ width: 1200, withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();

            await s3.send(new PutObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: basePath,
                Body: buffer,
                ContentType: 'image/jpeg'
            }));

            return { url: `${process.env.R2_PUBLIC_URL}/${basePath}`, path: basePath };
        });

        const uploadedData = await Promise.all(uploadPromises);
        res.status(200).json({ message: "Upload réussi", files: uploadedData });

    } catch (error) {
        console.error("Erreur d'upload :", error);
        res.status(500).json({ error: "Erreur lors de l'upload des images." });
    }
});

// NOUVEAU : Route de suppression définitive sur Cloudflare R2
app.post('/api/delete', verifyAdmin, async (req, res) => {
    try {
        const { keys } = req.body; // Attend un tableau de chemins complets
        if (!keys || keys.length === 0) return res.status(400).json({ error: "Aucune clé fournie" });

        const deleteParams = {
            Bucket: process.env.R2_BUCKET_NAME,
            Delete: { Objects: keys.map(key => ({ Key: key })) }
        };

        await s3.send(new DeleteObjectsCommand(deleteParams));
        res.status(200).json({ message: "Fichiers supprimés de Cloudflare avec succès" });
    } catch (error) {
        console.error("Erreur suppression Cloudflare :", error);
        res.status(500).json({ error: "Erreur lors de la suppression sur les serveurs" });
    }
});

// NOUVEAU : Route pour uploader un document PDF à une commande
app.post('/api/upload-order-document', verifyAdmin, upload.single('document'), async (req, res) => {
    try {
        const { orderId, fileName } = req.body;
        const file = req.file;

        // 1. Upload vers R2
        const key = `documents/${orderId}/${Date.now()}_${fileName}`;
        await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            Body: file.buffer,
            ContentType: 'application/pdf'
        }));

        const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;

        // 2. Mise à jour Firestore (on l'ajoute au tableau 'documents')
        const orderRef = admin.firestore().collection('orders').doc(orderId);
        await orderRef.update({
            documents: admin.firestore.FieldValue.arrayUnion({
                name: fileName,
                url: publicUrl,
                date: new Date().toISOString()
            })
        });

        res.status(200).json({ url: publicUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/send-email', async (req, res) => {
    try {
        const { to, subject, html, replyTo, attachments = [] } = req.body;
        const fs = require('fs');
        const path = require('path');

        // 1. SÉCURITÉ : On bloque immédiatement si on n'a pas de destinataire
        if (!to || to === 'undefined' || to === 'null') {
            console.error("Erreur SMTP : Aucun destinataire (to) défini.");
            return res.status(400).json({ error: "Destinataire manquant. Impossible d'envoyer l'email." });
        }

        const finalAttachments = [...attachments];
        
        // 2. SÉCURITÉ CHEMIN : On vérifie dans /public/assets... ET dans /assets...
        const cgvPathPublic = path.join(__dirname, 'public', 'assets', 'docs', 'CGV_M2S_Photo.pdf');
        const cgvPathRoot = path.join(__dirname, 'assets', 'docs', 'CGV_M2S_Photo.pdf');

        if (fs.existsSync(cgvPathPublic)) {
            finalAttachments.push({ filename: 'CGV_M2S_Photo.pdf', path: cgvPathPublic });
        } else if (fs.existsSync(cgvPathRoot)) {
            finalAttachments.push({ filename: 'CGV_M2S_Photo.pdf', path: cgvPathRoot });
        } else {
            console.warn("Attention : Le fichier CGV est introuvable sur le serveur.");
        }

        // 3. On construit les options proprement
        const mailOptions = {
            from: `"M2S Photo" <${process.env.SMTP_EMAIL}>`,
            to: to,
            subject: subject,
            html: html,
            attachments: finalAttachments
        };

        // On n'ajoute le replyTo que s'il existe vraiment (évite un bug Nodemailer)
        if (replyTo && replyTo !== 'undefined') {
            mailOptions.replyTo = replyTo;
        }

        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: "Email envoyé avec succès" });
        
    } catch (error) {
        console.error("Erreur SMTP détaillée :", error);
        res.status(500).json({ error: error.message });
    }
});

// NOUVEAU : Route pour supprimer un utilisateur de Firebase Auth
app.post('/api/delete-user', verifyAdmin, async (req, res) => {
    try {
        const { uid } = req.body;
        if (!uid) return res.status(400).json({ error: "UID manquant" });
        
        await admin.auth().deleteUser(uid);
        res.status(200).json({ message: "Utilisateur supprimé de Firebase Auth" });
    } catch (error) {
        console.error("Erreur suppression Auth :", error);
        res.status(500).json({ error: "Erreur lors de la suppression Auth" });
    }
});

// NOUVEAU : Route pour le Plan B (Réinitialisation de mot de passe sur-mesure)
app.post('/api/custom-password-reset', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email manquant" });

        // 1. Demander à Firebase Admin de générer le lien brut sécurisé
        const resetLink = await admin.auth().generatePasswordResetLink(email);

        // 2. Préparer le design de l'e-mail avec le lien intégré
        const resetEmailHTML = `
        <div style="font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #0a0a0a; padding: 40px 20px; color: #f5f5f5;">
            <div style="max-width: 600px; margin: 0 auto; background-color: #1a1a1a; border-top: 4px solid #d4af37; border-radius: 8px; padding: 40px 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); text-align: center;">
                <img src="https://m2s-photo.fr/assets/img/logo.png" alt="M2S Photo" style="max-width: 150px; margin-bottom: 25px;">
                <h2 style="color: #d4af37; margin-top: 0; font-size: 22px; text-transform: uppercase; letter-spacing: 2px;">Modification du mot de passe</h2>
                
                <p style="color: #ccc; font-size: 16px; margin-bottom: 25px; line-height: 1.6;">
                    Bonjour,<br>
                    Nous avons reçu une demande de réinitialisation de mot de passe pour votre espace client associé à l'adresse <strong>${email}</strong>.
                </p>

                <a href="${resetLink}" style="display: inline-block; background-color: #d4af37; color: #000; padding: 15px 35px; text-decoration: none; font-weight: bold; border-radius: 4px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 30px;">Créer mon nouveau mot de passe</a>
                
                <p style="color: #888; font-size: 13px; line-height: 1.5;">
                    Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité. Votre mot de passe actuel restera actif.
                </p>
            </div>
            <div style="text-align: center; margin-top: 20px; color: #666; font-size: 12px;">
                <p>© M2S Photo - L'Art de l'Instant</p>
            </div>
        </div>
        `;

        // 3. Envoyer l'e-mail via Hostinger SMTP
        const mailOptions = {
            from: `"M2S Photo" <${process.env.SMTP_EMAIL}>`,
            to: email,
            subject: "Réinitialisation de votre mot de passe - M2S Photo",
            html: resetEmailHTML
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: "Email de réinitialisation envoyé avec succès" });

    } catch (error) {
        console.error("Erreur réinitialisation :", error);
        // Sécurité : on renvoie quand même 200 pour qu'un hacker ne puisse pas deviner 
        // si une adresse e-mail existe ou non dans ta base de données en regardant les erreurs.
        res.status(200).json({ message: "Processus terminé" });
    }
});

// Nouvelle route pour supprimer un document spécifique d'une commande
app.post('/api/delete-order-document', verifyAdmin, async (req, res) => {
    try {
        const { orderId, docUrl, docIndex } = req.body;
        
        // 1. Suppression physique sur R2 (on extrait la clé de l'URL)
        const key = docUrl.split('.dev/')[1];
        if (key) {
            await s3.send(new DeleteObjectsCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Delete: { Objects: [{ Key: key }] }
            }));
        }

        // 2. Mise à jour Firestore (on récupère le doc actuel pour filtrer)
        const orderRef = admin.firestore().collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();
        const docs = orderSnap.data().documents || [];
        
        // On garde tout sauf celui qui correspond à l'URL fournie
        const updatedDocs = docs.filter(d => d.url !== docUrl);
        await orderRef.update({ documents: updatedDocs });

        res.status(200).json({ message: "Document supprimé" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// //////////////////////////////////////////////////
// 5. INITIALISATION ET ALLUMAGE SÉCURISÉ
// //////////////////////////////////////////////////

// On enveloppe l'écoute du serveur pour éviter que Hostinger ne reçoive une erreur 503 vide
try {
    app.listen(PORT, () => {
        console.log(`✅ Serveur Terraophis démarré avec succès sur le port ${PORT}`);
    });
} catch (error) {
    console.error("❌ Erreur critique lors du lancement du serveur Express :", error);
}
