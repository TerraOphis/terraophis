// 1. Importation des modules
const express = require('express');
const cors = require('cors');
require('dotenv').config(); // Charge les variables du fichier .env

const multer = require('multer');
const sharp = require('sharp');
const { S3Client, PutObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const path = require('path');
const nodemailer = require('nodemailer');
// API modulaire de firebase-admin (v14+)
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
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
const ADMIN_EMAILS = ["martin.stuis11@gmail.com", "terra.ophis@gmail.com"];
const ADMIN_NOTIFY_EMAIL = "terra.ophis@gmail.com";
const SITE_URL = (process.env.CLIENT_URL || 'https://terraophis.fr').replace(/\/$/, '');

// Échappement HTML pour les données client injectées dans les e-mails
const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Vérifie le token Firebase d'un client connecté (sans exiger les droits admin)
const verifyUser = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Veuillez vous reconnecter." });
    }
    try {
        req.user = await getAuth().verifyIdToken(authHeader.split('Bearer ')[1]);
        next();
    } catch (error) {
        return res.status(401).json({ error: "Session expirée, veuillez vous reconnecter." });
    }
};

const verifyAdmin = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Accès refusé : Token d'authentification manquant." });
    }

    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await getAuth().verifyIdToken(idToken);
        
        // Blocage si l'e-mail décodé n'appartient à aucun des deux administrateurs configurés
        if (!ADMIN_EMAILS.includes(decodedToken.email)) {
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

// Initialisation Firebase Admin : la clé est lue depuis la variable d'environnement FIREBASE_SERVICE_ACCOUNT (JSON complet)
// ou, à défaut, depuis le fichier serviceAccountKey.json (qui ne doit JAMAIS être commité, cf. .gitignore)
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    try {
        serviceAccount = require('./serviceAccountKey.json');
    } catch (e) {
        console.error("❌ Clé Firebase Admin introuvable : définissez FIREBASE_SERVICE_ACCOUNT ou déposez serviceAccountKey.json à la racine du serveur.");
        process.exit(1);
    }
}
initializeApp({
    credential: cert(serviceAccount)
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

// //////////////////////////////////////////////////
// 💶 CALCUL DES PRIX CÔTÉ SERVEUR
// Le navigateur n'est jamais la source de vérité pour un montant :
// on recalcule tout depuis Firestore avant de créer la session Stripe.
// //////////////////////////////////////////////////
class OrderError extends Error {}

const SHIPPING_DEFAULTS = { colissimo: 8.90, chrono13: 14.90, threshold: 100, heatPack: 2.00 };
const SHIPPING_METHODS = ['colissimo', 'chrono13', 'retrait'];

const round2 = (n) => Math.round(n * 100) / 100;

const formatLot = (lotSize) => {
    if (lotSize === null || lotSize === undefined || lotSize === '') return '';
    if (typeof lotSize === 'string' && !/^\d+$/.test(lotSize)) return ` (Option : ${lotSize})`;
    return parseInt(lotSize) > 1 ? ` (Lot de ${lotSize})` : '';
};

const buildItemsSummaryHtml = (items) => {
    if (!Array.isArray(items) || items.length === 0) return '';
    const rows = items.map(it => `
        <tr>
            <td style="padding: 6px 0; text-align: left;">x${it.quantity} ${escapeHtml(it.name || 'Article')}${escapeHtml(formatLot(it.lotSize))}${it.freeOption ? ' (+ ' + escapeHtml(it.freeOption) + ')' : ''}</td>
            <td style="padding: 6px 0; text-align: right; white-space: nowrap;">${it.lineTotal !== undefined ? Number(it.lineTotal).toFixed(2) + ' €' : ''}</td>
        </tr>`).join('');
    return `<table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #4a4238; margin: 15px 0; border-top: 1px solid #e0ddd5; border-bottom: 1px solid #e0ddd5;">${rows}</table>`;
};

const getUnitPrice = (product, lotSize) => {
    const variants = product.customOptions?.variants;
    if (Array.isArray(variants) && variants.length > 0 && typeof lotSize === 'string' && !/^\d+$/.test(lotSize)) {
        const variant = variants.find(v => v.label === lotSize);
        return variant ? Number(variant.price) : NaN;
    }
    const lot = lotSize === null || lotSize === undefined ? 1 : parseInt(lotSize);
    if (product.prices && Object.keys(product.prices).length > 0) {
        return product.prices[lot] !== undefined ? Number(product.prices[lot]) : NaN;
    }
    // Rétrocompatibilité des anciens articles (price, price3, price5, price10)
    const legacy = lot === 1 ? product.price : product[`price${lot}`];
    return legacy !== undefined ? Number(legacy) : NaN;
};

// Recalcule chaque ligne du panier et vérifie la disponibilité réelle (visibilité + stock, packs inclus)
async function priceOrder(rawItems, shippingMethod, hasHeatPack) {
    const db = getFirestore();
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw new OrderError("Votre panier est vide.");
    if (!SHIPPING_METHODS.includes(shippingMethod)) throw new OrderError("Mode de livraison invalide.");

    const productIds = [...new Set(rawItems.map(i => String(i.id || '')))].filter(Boolean);
    const snaps = await db.getAll(...productIds.map(id => db.collection('products').doc(id)));
    const products = {};
    snaps.forEach(snap => { if (snap.exists) products[snap.id] = snap.data(); });

    // Chargement des composants des packs pour contrôler leur stock
    const componentIds = new Set();
    Object.values(products).forEach(p => (p.bundleItems || []).forEach(b => { if (!products[b.productId]) componentIds.add(b.productId); }));
    if (componentIds.size > 0) {
        const compSnaps = await db.getAll(...[...componentIds].map(id => db.collection('products').doc(id)));
        compSnaps.forEach(snap => { if (snap.exists) products[snap.id] = snap.data(); });
    }

    const lines = [];
    const needs = {}; // clé de stock -> quantité requise
    const addNeed = (key, qty) => { needs[key] = (needs[key] || 0) + qty; };

    for (const raw of rawItems) {
        const quantity = parseInt(raw.quantity);
        if (!(quantity > 0)) continue;
        const product = products[raw.id];
        if (!product || product.hidden) {
            throw new OrderError(`L'article "${product?.name || 'inconnu'}" n'est plus disponible. Merci de le retirer de votre panier.`);
        }
        const lotSize = raw.lotSize ?? null;
        const freeOption = raw.freeOption || null;
        const unitPrice = getUnitPrice(product, lotSize);
        if (!Number.isFinite(unitPrice) || unitPrice < 0) {
            throw new OrderError(`Le prix de "${product.name}" a changé. Merci de le retirer puis de le rajouter au panier.`);
        }

        if (Array.isArray(product.bundleItems) && product.bundleItems.length > 0) {
            product.bundleItems.forEach(b => addNeed(b.productId, quantity * (parseInt(b.qty) || 1) * (parseInt(b.lot) || 1)));
        } else if (product.variantStocks && Object.keys(product.variantStocks).length > 0) {
            addNeed(`${raw.id}::${freeOption ? `${lotSize}_${freeOption}` : lotSize}`, quantity);
        } else {
            const numericLot = /^\d+$/.test(String(lotSize)) ? parseInt(lotSize) : 1;
            addNeed(raw.id, quantity * numericLot);
        }

        lines.push({
            id: raw.id,
            cartId: raw.cartId || raw.id,
            name: product.name,
            lotSize,
            freeOption,
            quantity,
            unitPrice: round2(unitPrice),
            lineTotal: round2(unitPrice * quantity)
        });
    }

    if (lines.length === 0) throw new OrderError("Votre panier est vide.");

    for (const [key, qty] of Object.entries(needs)) {
        let available = 0;
        let label = '';
        if (key.includes('::')) {
            const [pid, comb] = key.split('::');
            available = parseInt(products[pid]?.variantStocks?.[comb]) || 0;
            label = products[pid]?.name;
        } else {
            available = parseInt(products[key]?.stock) || 0;
            label = products[key]?.name;
        }
        if (qty > available) throw new OrderError(`Stock insuffisant pour "${label || 'un article'}". Merci d'ajuster votre panier.`);
    }

    const subtotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));

    const configSnap = await db.collection('config').doc('shipping').get();
    const cfg = { ...SHIPPING_DEFAULTS, ...(configSnap.exists ? configSnap.data() : {}) };
    let shippingCost = 0;
    if (shippingMethod === 'colissimo') shippingCost = subtotal >= Number(cfg.threshold) ? 0 : Number(cfg.colissimo);
    if (shippingMethod === 'chrono13') shippingCost = Number(cfg.chrono13);
    if (hasHeatPack && shippingMethod !== 'retrait') shippingCost += Number(cfg.heatPack);
    shippingCost = round2(shippingCost);

    return { lines, subtotal, shippingCost, total: round2(subtotal + shippingCost) };
}




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
            const orderRef = getFirestore().collection('orders').doc(orderId);
            
            const shipping = session.shipping_details;
            const customer = session.customer_details;
            const customerEmail = customer?.email || 'Non renseigné';
            const customerName = shipping?.name || customer?.name || 'Client';
            
            let weatherWarning = 'OK';
            let orderItemsHtml = '';

            // NOUVEAU : Utilisation d'une "Transaction" Firestore.
            await getFirestore().runTransaction(async (transaction) => {
                const orderSnap = await transaction.get(orderRef);
                
                if (!orderSnap.exists) {
                    throw new Error("Commande introuvable");
                }
                
                const orderData = orderSnap.data();
                weatherWarning = orderData.weatherWarning || 'OK';
                orderItemsHtml = buildItemsSummaryHtml(orderData.items);

                if (orderData.status !== 'En attente de paiement') {
                    throw new Error("ALREADY_PROCESSED");
                }

                const stockDeductions = {}; 
                const productsToFetch = [];

                // Étape 1 : On liste tous les produits principaux (AVEC freeOption)
                if (orderData.items && orderData.items.length > 0) {
                    for (const item of orderData.items) {
                        productsToFetch.push({
                            id: item.id,
                            ref: getFirestore().collection('products').doc(item.id),
                            quantity: item.quantity,
                            lotSize: item.lotSize || 1,
                            freeOption: item.freeOption || null // NOUVEAU : Récupération de l'option gratuite
                        });
                    }
                }

                // Étape 2 : Première passe de lecture Firestore
                for (const p of productsToFetch) {
                    const prodSnap = await transaction.get(p.ref);
                    if (prodSnap.exists) {
                        const prodData = prodSnap.data();

                        if (prodData.bundleItems && Array.isArray(prodData.bundleItems) && prodData.bundleItems.length > 0) {
                            // C'EST UN PACK
                            for (const bItem of prodData.bundleItems) {
                                const subId = bItem.productId;
                                const itemLot = parseInt(bItem.lot) || 1;
                                const itemQty = parseInt(bItem.qty) || 1;
                                const qtyToDeduct = p.quantity * itemQty * itemLot;

                                if (!stockDeductions[subId]) {
                                    stockDeductions[subId] = {
                                        ref: getFirestore().collection('products').doc(subId),
                                        isOption: false,
                                        amount: 0
                                    };
                                }
                                stockDeductions[subId].amount += qtyToDeduct;
                            }
                        } else {
                            // NOUVEAU : Détection infaillible basée sur la présence réelle de la matrice
                            const hasVariants = prodData.variantStocks && Object.keys(prodData.variantStocks).length > 0;
                            // Un lot "texte" (ex: option 10cm) compte pour 1 unité, un lot numérique multiplie la quantité
                            const numericLot = typeof p.lotSize === 'number' ? p.lotSize : (parseInt(p.lotSize) && /^\d+$/.test(String(p.lotSize)) ? parseInt(p.lotSize) : 1);
                            const qtyToDeduct = hasVariants ? p.quantity : (p.quantity * numericLot);
                            
                            const dKey = hasVariants ? `${p.id}_${p.lotSize}_${p.freeOption}` : p.id;

                            if (!stockDeductions[dKey]) {
                                stockDeductions[dKey] = {
                                    ref: p.ref,
                                    isOption: hasVariants,
                                    lotSize: p.lotSize,
                                    freeOption: p.freeOption,
                                    amount: 0
                                };
                            }
                            stockDeductions[dKey].amount += qtyToDeduct;
                        }
                    }
                }

                // Étape 3 : Seconde passe de lecture pour les packs
                for (const key in stockDeductions) {
                    await transaction.get(stockDeductions[key].ref);
                }

                // Étape 4 : Application finale et ciblée des déductions
                for (const key in stockDeductions) {
                    const item = stockDeductions[key];
                    
                    if (item.isOption) {
                        // C'est un accessoire : On retire uniquement dans la sous-clé de la matrice
                        const combKey = item.freeOption ? `${item.lotSize}_${item.freeOption}` : item.lotSize;
                        // FieldPath évite les erreurs si le libellé contient un point (ex: "10.5cm")
                        transaction.update(item.ref, new FieldPath('variantStocks', String(combKey)), FieldValue.increment(-item.amount));
                    } else {
                        // C'est un insecte classique : On retire dans le stock global
                        transaction.update(item.ref, {
                            stock: FieldValue.increment(-item.amount)
                        });
                    }
                }

                const updatePayload = {
                    status: 'Payé',
                    amountPaid: amountPaidThisSession,
                    paymentDate: FieldValue.serverTimestamp(),
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
                                    <img src="https://terraophis.fr/assets/img/logo_carre.png" alt="Terraophis" style="max-width: 120px; height: auto; display: block; margin: 0 auto;">
                                    <p style="color: #eadb9d; margin: 15px 0 0 0; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase;">Boutique d'Arthropodes & Insectes de collection</p>
                                </div>
                                <div style="padding: 35px; color: #4a4238; text-align: center;">
                                    <h2 style="font-size: 20px; margin-top: 0; color: #4a4238; font-weight: 600;">Merci pour votre commande, ${escapeHtml(customerName)} !</h2>

                                    ${orderItemsHtml}
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
                            <p><strong>Client :</strong> ${escapeHtml(customerName)} (${escapeHtml(customerEmail)})</p>
                            <p><strong>Montant payé :</strong> ${amountPaidThisSession.toFixed(2)} €</p>
                            <p><strong>ID Commande :</strong> ${orderId}</p>
                            ${orderItemsHtml}
                            <a href="${SITE_URL}/admin/admin.html" style="display:inline-block; padding:12px 24px; background:#4d5d30; color:#fff; text-decoration:none; border-radius:6px; margin-top:15px; font-weight: bold;">Accéder au panel Admin</a>
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


// Tes Middlewares existants
app.use(cors()); 
app.use(express.json({ limit: '1mb' })); // <--- Le Webhook doit impérativement être au dessus de cette ligne

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

// Construit et crée la session Stripe à partir d'une commande déjà tarifée
async function createStripeSession(req, orderId, orderData, priced) {
    let clientUrl = process.env.CLIENT_URL || req.headers.origin || 'http://localhost:3000';
    if (clientUrl.endsWith('/')) clientUrl = clientUrl.slice(0, -1);

    // Une ligne Stripe par article : le client retrouve le détail sur la page de paiement
    const lineItems = priced.lines.map(line => ({
        price_data: {
            currency: 'eur',
            product_data: { name: `${line.name}${formatLot(line.lotSize)}${line.freeOption ? ' (+ ' + line.freeOption + ')' : ''}` },
            unit_amount: Math.round(line.unitPrice * 100)
        },
        quantity: line.quantity
    })).filter(l => l.price_data.unit_amount > 0);

    if (priced.shippingCost > 0) {
        lineItems.push({
            price_data: {
                currency: 'eur',
                product_data: { name: orderData.hasHeatPack ? 'Livraison + chaufferette' : 'Livraison' },
                unit_amount: Math.round(priced.shippingCost * 100)
            },
            quantity: 1
        });
    }

    if (lineItems.length === 0) throw new OrderError("Aucun montant à régler pour cette commande.");

    const sessionConfig = {
        payment_method_types: ['card'],
        client_reference_id: String(orderId),
        line_items: lineItems,
        mode: 'payment',
        success_url: `${clientUrl}/confirmation.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/profil.html`,
    };

    // On collecte l'adresse Stripe UNIQUEMENT s'il y a expédition
    if (orderData.shippingMethod !== 'retrait') {
        sessionConfig.shipping_address_collection = { allowed_countries: ['FR', 'BE', 'CH', 'LU'] };
    }
    if (req.user.email) sessionConfig.customer_email = req.user.email;

    const session = await stripe.checkout.sessions.create(sessionConfig);
    return session.url;
}

// Création d'une commande : faite par le serveur uniquement (cf. firebase.rules), avec des montants recalculés
app.post('/api/checkout', verifyUser, async (req, res) => {
    try {
        const { items, shippingMethod, customerName, customerPhone, shippingAddress, hasHeatPack, weatherWarning } = req.body;
        const heatPack = hasHeatPack === true && shippingMethod !== 'retrait';
        const priced = await priceOrder(items, shippingMethod, heatPack);

        const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
        const orderData = {
            userId: req.user.uid,
            customerEmail: req.user.email || '',
            customerName: clean(customerName, 120) || req.user.name || 'Client',
            customerPhone: clean(customerPhone, 30),
            items: priced.lines,
            subtotal: priced.subtotal,
            shippingCost: priced.shippingCost,
            amountValue: priced.total,
            shippingMethod,
            status: 'En attente de paiement',
            shippingAddress: shippingMethod === 'retrait' || !shippingAddress ? null : {
                line1: clean(shippingAddress.line1),
                line2: clean(shippingAddress.line2),
                postalCode: clean(shippingAddress.postalCode, 12),
                city: clean(shippingAddress.city, 100),
                country: clean(shippingAddress.country, 2)
            },
            hasHeatPack: heatPack,
            weatherWarning: shippingMethod === 'retrait' ? 'OK' : (['Canicule', 'Grand Froid'].includes(weatherWarning) ? weatherWarning : 'OK'),
            createdAt: FieldValue.serverTimestamp()
        };

        const orderRef = await getFirestore().collection('orders').add(orderData);
        const url = await createStripeSession(req, orderRef.id, orderData, priced);
        res.status(200).json({ url, orderId: orderRef.id });
    } catch (error) {
        if (error instanceof OrderError) return res.status(400).json({ error: error.message });
        console.error("Erreur création commande :", error.message || error);
        res.status(500).json({ error: "Impossible de créer la commande. Réessayez dans quelques instants." });
    }
});

// Historique des commandes du client connecté (les règles Firestore lui interdisent la lecture directe)
app.get('/api/my-orders', verifyUser, async (req, res) => {
    try {
        const snap = await getFirestore().collection('orders').where('userId', '==', req.user.uid).get();
        const orders = snap.docs.map(d => {
            const o = d.data();
            return {
                id: d.id,
                status: o.status,
                items: (o.items || []).map(i => ({ name: i.name || null, id: i.id, lotSize: i.lotSize ?? null, freeOption: i.freeOption || null, quantity: i.quantity })),
                amountValue: o.amountValue || 0,
                shippingMethod: o.shippingMethod,
                trackingNumber: o.trackingNumber || null,
                createdAt: o.createdAt ? o.createdAt.toMillis() : 0
            };
        }).sort((a, b) => b.createdAt - a.createdAt);
        res.status(200).json({ orders });
    } catch (error) {
        console.error("Erreur historique commandes :", error);
        res.status(500).json({ error: "Impossible de charger vos commandes." });
    }
});

app.post('/api/create-checkout-session', verifyUser, async (req, res) => {
    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ error: "Paramètre manquant (orderId)." });
        }

        const orderRef = getFirestore().collection('orders').doc(String(orderId));
        const orderSnap = await orderRef.get();
        
        if (!orderSnap.exists) {
            return res.status(404).json({ error: "Commande introuvable." });
        }
        
        const orderData = orderSnap.data();

        // Seul le propriétaire de la commande peut la payer
        if (orderData.userId !== req.user.uid) {
            return res.status(403).json({ error: "Cette commande ne vous appartient pas." });
        }
        if (orderData.status !== 'En attente de paiement') {
            return res.status(400).json({ error: "Cette commande a déjà été réglée ou annulée." });
        }

        // Recalcul complet du montant (prix, stock, visibilité, frais de port)
        const priced = await priceOrder(orderData.items, orderData.shippingMethod, orderData.hasHeatPack === true);

        await orderRef.update({
            items: priced.lines,
            subtotal: priced.subtotal,
            shippingCost: priced.shippingCost,
            amountValue: priced.total
        });

        const url = await createStripeSession(req, orderId, orderData, priced);
        res.status(200).json({ url });
    } catch (error) {
        if (error instanceof OrderError) {
            return res.status(400).json({ error: error.message });
        }
        console.error("Erreur Stripe Checkout :", error.message || error);
        res.status(500).json({ error: "Impossible de créer la session de paiement. Réessayez dans quelques instants." });
    }
});

// 4. Création d'une route de test
app.get('/api/ping', (req, res) => {
    res.send('API Terraophis en ligne ! 🚀');
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
        const { orderId } = req.body;
        const file = req.file;
        if (!orderId || !file) return res.status(400).json({ error: "Commande ou fichier manquant." });
        const fileName = String(req.body.fileName || file.originalname || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');

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
        const orderRef = getFirestore().collection('orders').doc(orderId);
        await orderRef.update({
            documents: FieldValue.arrayUnion({
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

// NOUVEAU : Route pour l'envoi de l'e-mail de bienvenue
// Sécurisé : seul un utilisateur connecté peut déclencher l'e-mail, et uniquement vers sa propre adresse (anti-spam)
app.post('/api/send-welcome-email', verifyUser, async (req, res) => {
    try {
        const email = req.user.email;
        const name = req.body.name || req.user.name;
        if (!email) return res.status(400).json({ error: "Email manquant" });

        // On récupère uniquement le prénom pour un ton plus chaleureux
        const firstName = escapeHtml(name ? String(name).split(' ')[0] : 'passionné(e)');

        const welcomeHtml = `
            <div style="background-color: #fcf8f2; padding: 40px 10px; font-family: 'Helvetica Neue', Arial, sans-serif;">
                <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e0ddd5; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(74,66,56,0.05);">
                    <div style="background-color: #4d5d30; padding: 30px; text-align: center;">
                        <img src="https://terraophis.fr/assets/img/logo_carre.png" alt="Terraophis" style="max-width: 120px; height: auto; display: block; margin: 0 auto;">
                        <p style="color: #eadb9d; margin: 15px 0 0 0; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase;">Bienvenue dans notre élevage !</p>
                    </div>
                    <div style="padding: 35px; color: #4a4238; text-align: center;">
                        <h2 style="font-size: 20px; margin-top: 0; color: #4a4238; font-weight: 600;">Bienvenue sur Terraophis, ${firstName} ! 🌿</h2>
                        <p style="font-size: 15px; line-height: 1.6; color: #555;">Votre compte client a été créé avec succès. Vous faites désormais partie de notre communauté !</p>
                        
                        <div style="background-color: #f4f8f0; border: 1px solid #d4e3c5; padding: 18px; border-radius: 8px; margin: 25px 0; text-align: left;">
                            <h4 style="margin: 0 0 5px 0; color: #4d5d30; font-size: 15px;">Ce qui vous attend dans votre espace :</h4>
                            <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #4a4238; line-height: 1.6;">
                                <li>Suivi en temps réel de vos commandes et livraisons.</li>
                                <li>Historique de vos spécimens et accès aux fiches de suivi.</li>
                                <li>Communication directe et prioritaire avec nos éleveurs.</li>
                            </ul>
                        </div>

                        <a href="https://terraophis.fr/boutique" style="display: inline-block; background-color: #4d5d30; color: #f9f8f2; text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: 600; font-size: 14px; margin-top: 10px;">Explorer la boutique</a>
                        
                        <hr style="border: none; border-top: 1px solid #e0ddd5; margin: 30px 0;">
                        <p style="margin: 0; font-size: 14px; color: #888; font-style: italic;">À très bientôt,<br>L'équipe Terraophis</p>
                    </div>
                </div>
            </div>
        `;

        const mailOptions = {
            from: `"Terraophis" <terra.ophis@gmail.com>`,
            to: email,
            subject: "Bienvenue sur Terraophis ! 🌿",
            html: welcomeHtml
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: "Email de bienvenue envoyé" });
    } catch (error) {
        console.error("Erreur e-mail de bienvenue :", error);
        res.status(500).json({ error: "Erreur serveur" });
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
        
        await getAuth().deleteUser(uid);
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
        const resetLink = await getAuth().generatePasswordResetLink(email);

        // 2. Préparer le design de l'e-mail avec le lien intégré
        const resetEmailHTML = `
            <div style="background-color: #fcf8f2; padding: 40px 10px; font-family: 'Helvetica Neue', Arial, sans-serif;">
                <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e0ddd5; border-radius: 12px; overflow: hidden;">
                    <div style="background-color: #4d5d30; padding: 30px; text-align: center;">
                        <img src="${SITE_URL}/assets/img/logo_carre.png" alt="Terraophis" style="max-width: 120px; height: auto; display: block; margin: 0 auto;">
                        <p style="color: #eadb9d; margin: 15px 0 0 0; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase;">Votre espace client</p>
                    </div>
                    <div style="padding: 35px; color: #4a4238; text-align: center;">
                        <h2 style="font-size: 20px; margin-top: 0; color: #4a4238; font-weight: 600;">Modification du mot de passe</h2>
                        <p style="font-size: 15px; line-height: 1.6; color: #555;">Nous avons reçu une demande de réinitialisation du mot de passe associé à l'adresse <strong>${escapeHtml(email)}</strong>.</p>
                        <a href="${resetLink}" style="display: inline-block; background-color: #4d5d30; color: #f9f8f2; text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: 600; font-size: 14px; margin: 15px 0 25px;">Choisir un nouveau mot de passe</a>
                        <p style="font-size: 13px; color: #888; line-height: 1.5;">Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail : votre mot de passe actuel reste actif.</p>
                        <hr style="border: none; border-top: 1px solid #e0ddd5; margin: 30px 0;">
                        <p style="margin: 0; font-size: 14px; color: #888; font-style: italic;">L'équipe Terraophis</p>
                    </div>
                </div>
            </div>
        `;

        const mailOptions = {
            from: `"Terraophis" <terra.ophis@gmail.com>`,
            to: email,
            subject: "Réinitialisation de votre mot de passe - Terraophis",
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

// Formulaire de contact du footer : transfère le message à la boutique (réponse directe possible via Reply-To)
const contactRateLimit = new Map();
app.post('/api/contact', async (req, res) => {
    try {
        const name = String(req.body.name || '').trim().slice(0, 100);
        const email = String(req.body.email || '').trim().slice(0, 150);
        const message = String(req.body.message || '').trim().slice(0, 5000);

        if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: "Merci de remplir correctement tous les champs." });
        }

        // Anti-spam basique : 3 messages max par IP toutes les 10 minutes
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
        const now = Date.now();
        const recent = (contactRateLimit.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
        if (recent.length >= 3) {
            return res.status(429).json({ error: "Trop de messages envoyés. Réessayez dans quelques minutes." });
        }
        recent.push(now);
        contactRateLimit.set(ip, recent);

        await transporter.sendMail({
            from: `"Terraophis (Contact)" <terra.ophis@gmail.com>`,
            to: ADMIN_NOTIFY_EMAIL,
            replyTo: email,
            subject: `📩 Nouveau message de ${name}`,
            html: `
                <div style="font-family: 'Helvetica Neue', Arial, sans-serif; padding: 20px; background-color: #fcf8f2; color: #4a4238; border-radius: 8px;">
                    <h2 style="color: #4d5d30; margin-top: 0;">Nouveau message via le site</h2>
                    <p><strong>De :</strong> ${escapeHtml(name)} (${escapeHtml(email)})</p>
                    <div style="background: #fff; border: 1px solid #e0ddd5; border-radius: 6px; padding: 15px; white-space: pre-wrap;">${escapeHtml(message)}</div>
                    <p style="font-size: 12px; color: #888;">Répondez directement à cet e-mail pour écrire au client.</p>
                </div>
            `
        });

        res.status(200).json({ message: "Message envoyé" });
    } catch (error) {
        console.error("Erreur formulaire contact :", error);
        res.status(500).json({ error: "Impossible d'envoyer le message pour le moment." });
    }
});

// Nouvelle route pour supprimer un document spécifique d'une commande
app.post('/api/delete-order-document', verifyAdmin, async (req, res) => {
    try {
        const { orderId, docUrl } = req.body;
        if (!orderId || !docUrl) return res.status(400).json({ error: "Paramètres manquants." });
        
        // 1. Suppression physique sur R2 (on extrait la clé depuis le chemin de l'URL)
        const key = decodeURIComponent(new URL(docUrl).pathname.substring(1));
        if (key) {
            await s3.send(new DeleteObjectsCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Delete: { Objects: [{ Key: key }] }
            }));
        }

        // 2. Mise à jour Firestore (on récupère le doc actuel pour filtrer)
        const orderRef = getFirestore().collection('orders').doc(orderId);
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
