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

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', // NOUVEAU : On passe sur les serveurs de Google
    port: 465,
    secure: true, 
    auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD
    }
});

// //////////////////////////////////////////////////
// 🛡️ MIDDLEWARE DE SÉCURITÉ ADMIN
// //////////////////////////////////////////////////
const verifyAdmin = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Accès refusé : Token d'authentification manquant." });
    }

    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        
        // Blocage si l'e-mail décodé n'appartient à aucun des deux administrateurs configurés
        if (decodedToken.email !== "martin.stuis11@gmail.com" && decodedToken.email !== "terra.ophis@gmail.com") {
            console.warn(`Tentative d'accès non autorisé par : ${decodedToken.email}`);
            return res.status(403).json({ error: "Accès interdit : Droits administrateur requis." });
        }

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
            
            const shipping = session.shipping_details;
            const customer = session.customer_details;
            const customerEmail = customer?.email || 'Non renseigné';
            const customerName = shipping?.name || customer?.name || 'Client';
            
            let weatherWarning = 'OK';

            // NOUVEAU : Utilisation d'une "Transaction" Firestore.
            // Cela verrouille la commande en base de données. Si Stripe envoie le Webhook 2 fois en même temps,
            // la 2ème requête attendra que la 1ère ait fini, verra que le statut est passé à "Payé", et s'annulera !
            await admin.firestore().runTransaction(async (transaction) => {
                const orderSnap = await transaction.get(orderRef);
                
                if (!orderSnap.exists) {
                    throw new Error("Commande introuvable");
                }
                
                const orderData = orderSnap.data();
                weatherWarning = orderData.weatherWarning || 'OK';

                // On vérifie le statut DANS la transaction verrouillée
                if (orderData.status !== 'En attente de paiement') {
                    throw new Error("ALREADY_PROCESSED");
                }

                // NOUVEAU : Algorithme de gestion des stocks corrigé et ordonné
                const stockDeductions = {}; 
                const productsToFetch = [];

                // Étape 1 : On liste tous les produits principaux de la commande
                if (orderData.items && orderData.items.length > 0) {
                    for (const item of orderData.items) {
                        productsToFetch.push({
                            id: item.id,
                            ref: admin.firestore().collection('products').doc(item.id),
                            quantity: item.quantity,
                            lotSize: item.lotSize || 1
                        });
                    }
                }

                // Étape 2 : Première passe de lecture Firestore obligatoire pour les produits principaux
                for (const p of productsToFetch) {
                    const prodSnap = await transaction.get(p.ref);
                    if (prodSnap.exists) {
                        const prodData = prodSnap.data();

                        // Correction : On vérifie la présence du tableau de composants du pack
                        if (prodData.bundleItems && Array.isArray(prodData.bundleItems) && prodData.bundleItems.length > 0) {
                            // C'EST UN PACK : On extrait ses composants
                            for (const bItem of prodData.bundleItems) {
                                const subId = bItem.productId;
                                
                                // NOUVEAU : Sécurisation mathématique pour éviter toute erreur de déduction silencieuse
                                const itemLot = parseInt(bItem.lot) || 1;
                                const itemQty = parseInt(bItem.qty) || 1;
                                const qtyToDeduct = p.quantity * itemQty * itemLot;

                                if (!stockDeductions[subId]) {
                                    stockDeductions[subId] = {
                                        ref: admin.firestore().collection('products').doc(subId),
                                        amount: 0
                                    };
                                }
                                stockDeductions[subId].amount += qtyToDeduct;
                            }
                        } else {
                            // C'EST UN PRODUIT STANDARD
                            const qtyToDeduct = p.quantity * p.lotSize;

                            if (!stockDeductions[p.id]) {
                                stockDeductions[p.id] = {
                                    ref: p.ref,
                                    amount: 0
                                };
                            }
                            stockDeductions[p.id].amount += qtyToDeduct;
                        }
                    }
                }

                // Étape 3 : Seconde passe de lecture pour les sous-produits des packs (Contrainte des Transactions Firestore)
                for (const id in stockDeductions) {
                    await transaction.get(stockDeductions[id].ref);
                }

                // Étape 4 : Application finale et sécurisée des déductions de stocks
                for (const id in stockDeductions) {
                    transaction.update(stockDeductions[id].ref, {
                        stock: admin.firestore.FieldValue.increment(-stockDeductions[id].amount)
                    });
                }

                // 2. Préparation et mise à jour immédiate du statut de la commande
                const updatePayload = {
                    status: 'Payé',
                    amountPaid: amountPaidThisSession,
                    paymentDate: admin.firestore.FieldValue.serverTimestamp(),
                    customerEmail: customerEmail,
                    customerName: customerName
                };

                if (shipping && shipping.address) {
                    updatePayload.shippingAddress = {
                        line1: shipping.address.line1,
                        line2: shipping.address.line2 || '',
                        city: shipping.address.city,
                        postalCode: shipping.address.postal_code,
                        country: shipping.address.country
                    };
                }

                transaction.update(orderRef, updatePayload);
            });

            console.log(`📦 Transaction réussie, stocks déduits sans doublon pour la commande ${orderId}`);

            if (customerEmail !== 'Non renseigné') {
                // Configuration dynamique du message selon la météo lors de la commande
                let weatherAlertHtml = '';

                if (weatherWarning === 'Canicule') {
                    weatherAlertHtml = `
                        <div style="background-color: #fdf3f2; border: 1px solid #eebdbb; padding: 18px; border-radius: 8px; margin: 20px 0; text-align: left;">
                            <h4 style="margin: 0 0 5px 0; color: #a35d5d; font-size: 15px; font-family: 'Helvetica Neue', Arial, sans-serif;">☀️ Alerte Canicule active</h4>
                            <p style="margin: 0; font-size: 14px; color: #4a4238; line-height: 1.5;">
                                En raison des fortes chaleurs actuelles sur l'itinéraire de transport, les expéditions de vos animaux pourront être <strong>suspendues ou décalées</strong>. Nous ajustons nos départs au jour le jour pour leur confort thermique absolu. Un e-mail de notification vous sera envoyé dès que vos spécimens prendront la route !
                            </p>
                        </div>
                    `;
                } else if (weatherWarning === 'Grand Froid') {
                    weatherAlertHtml = `
                        <div style="background-color: #f0f4f8; border: 1px solid #cce0f0; padding: 18px; border-radius: 8px; margin: 20px 0; text-align: left;">
                            <h4 style="margin: 0 0 5px 0; color: #4a7599; font-size: 15px; font-family: 'Helvetica Neue', Arial, sans-serif;">❄️ Protection Grand Froid activée</h4>
                            <p style="margin: 0; font-size: 14px; color: #4a4238; line-height: 1.5;">
                                Les températures étant basses sur le trajet, une <strong>chaufferette isotherme</strong> a été automatiquement ajoutée à votre colis. Elle diffusera une chaleur douce pour maintenir vos spécimens à une température idéale pendant tout leur voyage.
                            </p>
                        </div>
                    `;
                } else {
                    weatherAlertHtml = `
                        <div style="background-color: #f4f8f0; border: 1px solid #d4e3c5; padding: 18px; border-radius: 8px; margin: 20px 0; text-align: left;">
                            <h4 style="margin: 0 0 5px 0; color: #4d5d30; font-size: 15px; font-family: 'Helvetica Neue', Arial, sans-serif;">🌿 Conditions de transport idéales</h4>
                            <p style="margin: 0; font-size: 14px; color: #4a4238; line-height: 1.5;">
                                Les prévisions météo actuelles sur le trajet sont optimales. Vos spécimens voyageront depuis notre élevage de Nîmes dans les meilleures dispositions possibles.
                            </p>
                        </div>
                    `;
                }

                const mailOptions = {
                    from: `"Terraophis" <terra.ophis@gmail.com>`,
                    to: customerEmail,
                    subject: `Confirmation de votre commande #${orderId.slice(0,6).toUpperCase()} 🌿`,
                    html: `
                        <div style="background-color: #fcf8f2; padding: 40px 10px; font-family: 'Helvetica Neue', Arial, sans-serif;">
                            <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e0ddd5; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(74,66,56,0.05);">
                                <div style="background-color: #4d5d30; padding: 30px; text-align: center;">
                                    <img src="https://working.terraophis.fr/assets/img/logo_carre.png" alt="Terraophis" style="max-width: 120px; height: auto; display: block; margin: 0 auto;">
                                    <p style="color: #eadb9d; margin: 15px 0 0 0; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase;">Boutique d'Arthropodes & Insectes de collection</p>
                                </div>
                                <div style="padding: 35px; color: #4a4238; text-align: center;">
                                    <h2 style="font-size: 20px; margin-top: 0; color: #4a4238; font-weight: 600;">Merci pour votre commande, ${customerName} !</h2>
                                    <p style="font-size: 15px; line-height: 1.6; color: #555;">Nous vous confirmons la bonne validation de votre règlement de <strong>${amountPaidThisSession.toFixed(2)} €</strong> pour la commande <strong>#${orderId.slice(0,6).toUpperCase()}</strong>.</p>
                                    
                                    ${weatherAlertHtml}

                                    <p style="font-size: 15px; line-height: 1.6; color: #555; margin-top: 25px;">Toute notre équipe s'active pour préparer vos boîtes et contenants d'expédition de façon sécurisée.</p>
                                    <hr style="border: none; border-top: 1px solid #e0ddd5; margin: 30px 0;">
                                    <p style="margin: 0; font-size: 14px; color: #888; font-style: italic;">À très bientôt sur Terraophis,<br>L'élevage passionné.</p>
                                </div>
                            </div>
                        </div>
                    `,
                    // NOUVEAU : Ajout de la pièce jointe pour les CGV
                    attachments: [
                        {
                            filename: 'CGV_Terra_Ophis.pdf',
                            path: path.join(__dirname, 'public', 'assets', 'docs', 'CGV_Terra_Ophis.pdf')
                        }
                    ]
                };
                await transporter.sendMail(mailOptions);
                    console.log(`✅ Email de confirmation envoyé à ${customerEmail}`);
                }

                // NOUVEAU : Notification automatique à l'admin
                const adminMailOptions = {
                    from: `"Terraophis (Admin)" <terra.ophis@gmail.com>`,
                    to: "terra.ophis@gmail.com",
                    subject: `🚨 Nouvelle commande validée ! (#${orderId.slice(0,6).toUpperCase()})`,
                    html: `
                        <div style="font-family: 'Helvetica Neue', Arial, sans-serif; padding: 20px; background-color: #fcf8f2; color: #4a4238; border-radius: 8px;">
                            <h2 style="color: #4d5d30; margin-top: 0;">Nouvelle commande reçue ! 🎉</h2>
                            <p><strong>Client :</strong> ${customerName} (${customerEmail})</p>
                            <p><strong>Montant payé :</strong> ${amountPaidThisSession.toFixed(2)} €</p>
                            <p><strong>ID Commande :</strong> ${orderId}</p>
                            <a href="https://terraophis.fr/admin.html" style="display:inline-block; padding:12px 24px; background:#4d5d30; color:#fff; text-decoration:none; border-radius:6px; margin-top:15px; font-weight: bold;">Accéder au panel Admin</a>
                        </div>
                    `
                };
                await transporter.sendMail(adminMailOptions);
                console.log(`✅ Email de notification envoyé à l'admin pour la commande ${orderId}`);

        } catch(e) {
            // NOUVEAU : On gère silencieusement l'erreur si la commande a déjà été traitée par un webhook précédent
            if (e.message === "ALREADY_PROCESSED") {
                console.log(`⚠️ Webhook en double ignoré par sécurité pour la commande ${orderId}`);
            } else {
                console.error("Erreur lors du traitement Firestore du Webhook :", e);
            }
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

// NOUVEAU : Fusion de la gestion des extensions HTML et de l'anti-cache
app.use(express.static(path.join(__dirname, 'public'), { 
    extensions: ['html'],
    setHeaders: function (res, path) {
        if (path.endsWith('.css') || path.endsWith('.js') || path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

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

        // NOUVEAU : On collecte l'adresse Stripe UNIQUEMENT s'il y a expédition
        if (orderData.shippingMethod !== 'retrait') {
            sessionConfig.shipping_address_collection = {
                allowed_countries: ['FR', 'BE', 'CH', 'LU'],
            };
        }

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

app.post('/api/send-email', verifyAdmin, async (req, res) => { // NOUVEAU : Sécurisation de la route
    try {
        const { to, subject, html, replyTo, attachments = [] } = req.body;

        // NOUVEAU : On bloque immédiatement si on n'a pas de destinataire
        if (!to || to === 'undefined' || to === 'null') {
            console.error("Erreur SMTP : Aucun destinataire (to) défini.");
            return res.status(400).json({ error: "Destinataire manquant. Impossible d'envoyer l'email." });
        }

        // NOUVEAU : Construction des options avec l'expéditeur officiel de Terraophis
        const mailOptions = {
            from: `"Terraophis" <terra.ophis@gmail.com>`,
            to: to,
            subject: subject,
            html: html,
            attachments: attachments
        };

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
