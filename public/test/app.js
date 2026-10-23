import { db, auth } from './firebase-config.js';
import { collection, query, getDocs, orderBy, doc, getDoc, addDoc, setDoc, updateDoc, increment, serverTimestamp, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut, getAdditionalUserInfo } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import * as DEFAULTS from './defaults.js';

let allProducts = []; // Stockage local pour filtrer sans requêter Firebase en boucle

const escapeHtml = (str = '') => String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// =========================================================
// CONTENU MODIFIABLE (admin > Contenu du site, stocké dans settings/siteContent)
// =========================================================
// Les textes du HTML servent de valeurs par défaut : chaque élément [data-c]
// est remplacé par sa version enregistrée, s'il y en a une.
const CONTENT_CACHE_KEY = 'to_content_v1';
let siteContent = {};
const defaultTexts = new WeakMap();

const site = {
    get faq() { return siteContent.faq || DEFAULTS.faq; },
    get settings() { return { ...DEFAULTS.settings, ...(siteContent.settings || {}) }; }
};

function readContentCache() {
    try { return localStorage.getItem(CONTENT_CACHE_KEY); } catch { return null; }
}

function applyContent(root = document) {
    const texts = siteContent.texts || {};
    const images = siteContent.images || {};
    const hidden = siteContent.hidden || {};

    root.querySelectorAll('[data-c]').forEach(el => {
        const isMeta = el.tagName === 'META';
        if (!defaultTexts.has(el)) defaultTexts.set(el, isMeta ? el.getAttribute('content') : el.innerHTML);
        const value = texts[el.dataset.c] ?? defaultTexts.get(el);
        if (isMeta) el.setAttribute('content', value);
        else if (el.tagName === 'TITLE') document.title = value;
        else if (el.innerHTML !== value) el.innerHTML = value;
    });

    root.querySelectorAll('[data-c-img]').forEach(img => {
        if (!img.dataset.defaultSrc) img.dataset.defaultSrc = img.getAttribute('src');
        const url = images[img.dataset.cImg];
        img.src = url || img.dataset.defaultSrc;
        img.classList.toggle('is-photo', Boolean(url));
    });

    root.querySelectorAll('[data-s]').forEach(el => { el.hidden = Boolean(hidden[el.dataset.s]); });

    // Liens réglables depuis l'admin : masqués s'ils sont vides
    const { instagram, facebook, email } = site.settings;
    const links = { instagram, facebook, email: email && `mailto:${email}` };
    root.querySelectorAll('[data-link]').forEach(a => {
        const href = links[a.dataset.link];
        a.hidden = !href;
        if (href) a.href = href;
    });
}

async function refreshContent() {
    try {
        const snap = await getDoc(doc(db, 'settings', 'siteContent'));
        const raw = snap.exists() ? (snap.data().data || '{}') : '{}';
        if (raw === readContentCache()) return false;
        try { localStorage.setItem(CONTENT_CACHE_KEY, raw); } catch { /* stockage indisponible */ }
        siteContent = JSON.parse(raw);
        applyContent();
        return true;
    } catch (err) {
        console.error('Contenu du site indisponible, affichage du contenu par défaut :', err);
        return false;
    }
}

// NOUVEAU : Gestion de l'état de connexion client et injection de l'icône de profil
// NOUVEAU : Mise à jour dynamique du bouton de la navbar selon l'état
window.updateNavAuthUI = (user) => {
    const authBtn = document.getElementById('nav-auth-btn');
    if (!authBtn) return; 

    if (user) {
        // NOUVEAU : Ajout du nom du client et flexbox pour aligner le texte et l'icône
        const displayName = user.displayName ? user.displayName : 'Profil';
        authBtn.href = 'profil';
        authBtn.style.display = 'flex';
        authBtn.style.alignItems = 'center';
        authBtn.style.gap = '8px';
        authBtn.innerHTML = `<span>${displayName}</span> <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#586d32" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    } else {
        authBtn.href = 'connexion';
        authBtn.style.display = 'block';
        authBtn.innerHTML = `Connexion`;
    }
};

onAuthStateChanged(auth, (user) => {
    window.updateNavAuthUI(user);
});

// NOUVEAU : Logique de connexion Google Pop-up
window.loginWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    try {
        const result = await signInWithPopup(auth, provider);
        // NOUVEAU : Vérification du type de connexion (nouveau compte ou habitué)
        const userInfo = getAdditionalUserInfo(result); 
        
        await setDoc(doc(db, "users", result.user.uid), {
            name: result.user.displayName,
            email: result.user.email,
            updatedAt: serverTimestamp()
        }, { merge: true });
        
        // NOUVEAU : Si c'est une création de compte, on déclenche l'envoi de l'e-mail
        if (userInfo && userInfo.isNewUser) {
            try {
                const token = await result.user.getIdToken();
                await fetch('/api/send-welcome-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ name: result.user.displayName })
                });
            } catch (emailError) {
                console.error("Erreur d'envoi de l'e-mail de bienvenue :", emailError);
            }
            alert(`Bienvenue parmi nous, ${result.user.displayName} ! 🌿`);
        } else {
            alert(`Ravi de vous revoir, ${result.user.displayName} ! 🌿`);
        }
        
        window.location.reload();
    } catch (error) {
        console.error("Erreur d'authentification Google :", error);
        alert("Impossible de finaliser la connexion Google.");
    }
};

async function loadCatalogue() {
    const productGrid = document.getElementById('productGrid');
    const searchInput = document.getElementById('shopSearch');
    const sortSelect = document.getElementById('shopSort');
    const categoryFilter = document.getElementById('categoryFilter');
    
    const urlParams = new URLSearchParams(window.location.search);
    let initialCat = urlParams.get('cat');

    if (!productGrid) return;

    // Lecture globale de toutes les catégories pour récupérer le lot d'affichage préféré
    const categoriesMap = {};
    const categoriesSnap = await getDocs(collection(db, "categories"));
    categoriesSnap.forEach(catDoc => {
        categoriesMap[catDoc.id] = catDoc.data();
    });

    if (categoryFilter) {
        let optionsHtml = '<option value="all">Toutes les catégories</option>';
        
        categoriesSnap.forEach(catDoc => {
            optionsHtml += `<option value="${catDoc.id}">${catDoc.data().name}</option>`;
        });
        categoryFilter.innerHTML = optionsHtml;
    }

    if (initialCat && categoryFilter) {
        categoryFilter.value = initialCat;
    }

    // NOUVEAU : Animation de chargement élégante (pulsation gérée en CSS)
    productGrid.innerHTML = '<div class="loading-note">Les cloportes sortent de leur cachette… 🌿</div>';

    try {
        const q = query(collection(db, "products"), orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);
        
        const allProducts = querySnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        // NOUVEAU : Calcul des stocks virtuels pour les packs sur la boutique publique
        allProducts.forEach(p => {
            if (p.bundleItems && p.bundleItems.length > 0) {
                let virtualStock = Infinity;
                p.bundleItems.forEach(bItem => {
                    const subProduct = allProducts.find(sub => sub.id === bItem.productId);
                    if (subProduct) {
                        const subStock = parseInt(subProduct.stock) || 0;
                        const itemLot = parseInt(bItem.lot) || 1;
                        const itemQty = parseInt(bItem.qty) || 1;
                        const possiblePacks = Math.floor(subStock / (itemQty * itemLot));
                        if (possiblePacks < virtualStock) virtualStock = possiblePacks;
                    } else {
                        virtualStock = 0;
                    }
                });
                p.stock = virtualStock === Infinity ? 0 : virtualStock;
                p.isPack = true;
            }
        });

        // NOUVEAU : Ajout de l'index dans le forEach pour gérer le délai d'animation
        // Les articles masqués depuis l'admin n'apparaissent pas dans la boutique
        const visibleProducts = allProducts.filter(p => p.hidden !== true);

        // Stock réellement disponible (matrice d'options incluse) et plus petit lot vendable
        const getAvailableStock = (p) => (p.variantStocks && Object.keys(p.variantStocks).length > 0)
            ? Object.values(p.variantStocks).reduce((sum, val) => sum + (parseInt(val) || 0), 0)
            : (parseInt(p.stock) || 0);

        const renderProducts = (productsToDisplay) => {
            productGrid.innerHTML = ''; 
            if (productsToDisplay.length === 0) {
                productGrid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Aucun spécimen ne correspond.</p>';
                return;
            }

            productsToDisplay.forEach((product, index) => {
                const photoUrl = product.photos && product.photos.length > 0 ? product.photos[0] : 'assets/img/placeholder.jpg';
                
                let minLotSize = 1;
                let basePrice = 0;
                let displayLot = 1;
                let lotText = ''; // NOUVEAU: Rendu dynamique pour ne pas bloquer sur "(le lot de X)"
                
                const catInfo = categoriesMap[product.category];
                const preferredLot = catInfo ? catInfo.defaultDisplayLot : null;

                // NOUVEAU : Gestion de l'affichage pour le matériel avec options personnalisées
                if (product.customOptions && product.customOptions.variants && product.customOptions.variants.length > 0) {
                    const cheapest = product.customOptions.variants.reduce((prev, curr) => prev.price < curr.price ? prev : curr);
                    basePrice = cheapest.price;
                    lotText = ` <span style="font-size: 0.8rem; color: #888; font-weight: normal;">(à partir de)</span>`;
                    minLotSize = 1; // Le stock est lu à l'unité pour le matériel
                } 
                // Fin NOUVEAU
                else if (product.prices && Object.keys(product.prices).length > 0) {
                    const lots = Object.keys(product.prices).map(Number).sort((a, b) => b - a);
                    const maxLot = lots[0];
                    
                    displayLot = (preferredLot && product.prices[preferredLot] !== undefined) ? preferredLot : maxLot;
                    minLotSize = lots[lots.length - 1];
                    basePrice = product.prices[displayLot];
                    
                    lotText = displayLot === 1 
                        ? ` <span style="font-size: 0.8rem; color: #888; font-weight: normal;">(l'unité)</span>` 
                        : ` <span style="font-size: 0.8rem; color: #888; font-weight: normal;">(le lot de ${displayLot})</span>`;
                    
                } else {
                    // Rétrocompatibilité : on applique aussi la logique du lot préféré ici !
                    if (preferredLot === 10 && product.price10) { basePrice = product.price10; displayLot = 10; }
                    else if (preferredLot === 5 && product.price5) { basePrice = product.price5; displayLot = 5; }
                    else if (preferredLot === 3 && product.price3) { basePrice = product.price3; displayLot = 3; }
                    else if (preferredLot === 1 && product.price) { basePrice = product.price; displayLot = 1; }
                    // Sinon on retombe sur le plus gros disponible
                    else if (product.price10) { basePrice = product.price10; displayLot = 10; }
                    else if (product.price5) { basePrice = product.price5; displayLot = 5; }
                    else if (product.price3) { basePrice = product.price3; displayLot = 3; }
                    else { basePrice = product.price || 0; displayLot = 1; }
                    
                    if (product.price) minLotSize = 1;
                    else if (product.price3) minLotSize = 3;
                    else if (product.price5) minLotSize = 5;
                    else if (product.price10) minLotSize = 10;
                }

                // NOUVEAU : On assigne simplement la valeur sans "const" puisqu'elle a déjà été déclarée en haut
                if (!lotText) {
                    lotText = displayLot === 1 
                        ? ` <span style="font-size: 0.8rem; color: #888; font-weight: normal;">(l'unité)</span>` 
                        : ` <span style="font-size: 0.8rem; color: #888; font-weight: normal;">(le lot de ${displayLot})</span>`;
                }
                
                // NOUVEAU : Calcul cumulé du stock de la matrice et détection des alertes variantes faibles
                let totalStock = product.stock;
                let hasLowStockVariant = false;
                if (product.variantStocks && Object.keys(product.variantStocks).length > 0) {
                    totalStock = Object.values(product.variantStocks).reduce((sum, val) => sum + (parseInt(val) || 0), 0);
                    hasLowStockVariant = Object.values(product.variantStocks).some(val => {
                        const s = parseInt(val) || 0;
                        return s > 0 && s <= 2; // Seuil d'alerte si une variante repère entre 1 et 2 articles restants
                    });
                }

                const formattedBasePrice = Number(basePrice).toFixed(2);
                const oldPriceHtml = product.oldPrice ? `<span style="text-decoration: line-through; color: #a35d5d; font-size: 0.9rem; margin-right: 8px; font-weight: normal;">${Number(product.oldPrice).toFixed(2)} €</span>` : '';

                const isActuallyOutOfStock = product.variantStocks && Object.keys(product.variantStocks).length > 0
                    ? totalStock < 1
                    : product.stock < minLotSize;

                let badgeHtml = '';
                if (isActuallyOutOfStock) {
                    badgeHtml = `<span class="product-badge out-of-stock" style="position:absolute; top:10px; left:10px; background:#a35d5d; color:white; padding:5px 10px; border-radius:4px; font-size:0.75rem; font-weight:bold; z-index:2;">Épuisé</span>`;
                } else if (hasLowStockVariant) {
                    badgeHtml = `<span class="product-badge low-stock" style="position:absolute; top:10px; left:10px; background:#e67e22; color:white; padding:5px 10px; border-radius:4px; font-size:0.75rem; font-weight:bold; z-index:2;">⚠️ Stock limité</span>`;
                } else if (product.oldPrice) {
                    badgeHtml = `<span class="product-badge sale" style="position:absolute; top:10px; left:10px; background:#6d8c6d; color:white; padding:5px 10px; border-radius:4px; font-size:0.75rem; font-weight:bold; z-index:2;">PROMO</span>`;
                }
                
                // NOUVEAU : Vérifie si le produit a des options custom pour afficher le bon bouton
                const hasCustomOptions = product.customOptions && product.customOptions.variants && product.customOptions.variants.length > 0;
                const hasLots = (product.prices && Object.keys(product.prices).length > 1) || product.price5 || product.price10 || product.price3 || hasCustomOptions;
                
                const btnAction = hasLots ? `window.location.href='produit.html?id=${product.id}'` : `addToCart('${product.id}')`;
                const btnText = hasLots ? 'VOIR LES OPTIONS' : 'AJOUTER AU PANIER';
                
               const card = document.createElement('div');
                card.className = 'product-card';
                // NOUVEAU : Animation d'apparition en cascade avec délai calculé sur l'index
                card.style.opacity = '0';
                card.style.animation = `fadeInProduct 0.5s ease forwards ${index * 0.05}s`;
                card.innerHTML = `
                    <a href="produit.html?id=${product.id}" style="text-decoration: none; color: inherit; display: block; position: relative;">
                        ${badgeHtml}
                        <img src="${photoUrl}" alt="${product.name}" class="product-image">
                        <div class="product-info">
                            <p class="product-latin">${product.latinName && product.latinName !== "null" ? product.latinName : ""}</p>
                            <h3 class="product-name">${product.name}</h3>
                            <p class="product-price">${oldPriceHtml}${formattedBasePrice} €${lotText}</p>
                        </div>
                    </a>
                    <button class="btn-buy" onclick="${btnAction}" ${isActuallyOutOfStock ? 'disabled' : ''} style="${isActuallyOutOfStock ? 'background-color: #ccc; cursor: not-allowed;' : ''}; width: 100%;">
                        ${isActuallyOutOfStock ? 'ÉPUISÉ' : btnText}
                    </button>
                `;
                productGrid.appendChild(card);
            });
        };

        const filterAndSort = () => {
            let filtered = [...visibleProducts];
            
            const selectedCat = categoryFilter?.value;
            if (selectedCat && selectedCat !== 'all') {
                filtered = filtered.filter(p => p.category === selectedCat);
            }

            const searchTerm = searchInput?.value.toLowerCase() || "";
            if (searchTerm) {
                filtered = filtered.filter(p => 
                    (p.name || '').toLowerCase().includes(searchTerm) || 
                    (p.latinName || '').toLowerCase().includes(searchTerm)
                );
            }

            const sortType = sortSelect?.value;
            
            // NOUVEAU : On repousse systématiquement les articles épuisés à la fin, avant d'appliquer le tri utilisateur
            filtered.sort((a, b) => {
                const getMinLot = (p) => {
                    if (p.customOptions?.variants?.length > 0 || p.isPack) return 1;
                    if (p.prices && Object.keys(p.prices).length > 0) return Math.min(...Object.keys(p.prices).map(Number));
                    if (p.price) return 1;
                    if (p.price3) return 3;
                    if (p.price5) return 5;
                    if (p.price10) return 10;
                    return 1;
                };

                const aEpuise = getAvailableStock(a) < getMinLot(a);
                const bEpuise = getAvailableStock(b) < getMinLot(b);

                // Si a est épuisé et pas b, a descend à la fin
                if (aEpuise && !bEpuise) return 1;  
                // Si b est épuisé et pas a, a monte
                if (!aEpuise && bEpuise) return -1; 

                const getPriceForSort = (p) => {
                    if (p.customOptions?.variants?.length > 0) return Math.min(...p.customOptions.variants.map(v => Number(v.price)));
                    const cInfo = categoriesMap[p.category];
                    const pLot = cInfo ? cInfo.defaultDisplayLot : null;

                    if (p.prices && Object.keys(p.prices).length > 0) {
                        if (pLot && p.prices[pLot] !== undefined) return p.prices[pLot];
                        
                        const lots = Object.keys(p.prices).map(Number).sort((a, b) => b - a);
                        return p.prices[lots[0]]; 
                    }
                    
                    // Rétrocompatibilité tri
                    if (pLot === 10 && p.price10) return p.price10;
                    if (pLot === 5 && p.price5) return p.price5;
                    if (pLot === 3 && p.price3) return p.price3;
                
                    if (pLot === 1 && p.price) return p.price;

                    return p.price10 || p.price5 || p.price3 || p.price || 0;
                };

                if (sortType === 'price-asc') return getPriceForSort(a) - getPriceForSort(b);
                if (sortType === 'price-desc') return getPriceForSort(b) - getPriceForSort(a);
                if (sortType === 'name-asc') return a.name.localeCompare(b.name);
                
                // Tri par défaut (newest)
                return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0); 
            });

            const limit = parseInt(productGrid.dataset.limit);
            renderProducts(limit ? filtered.slice(0, limit) : filtered);
            initTilt(productGrid);
        };

        searchInput?.addEventListener('input', filterAndSort);
        sortSelect?.addEventListener('change', filterAndSort);
        categoryFilter?.addEventListener('change', filterAndSort);

        // NOUVEAU : Switcher de structure de la grille sur mobile
        const mobileGridSelector = document.getElementById('mobileGridSelector');
        if (mobileGridSelector && productGrid) {
            // On lui applique la classe initiale de 2 par ligne
            productGrid.classList.add(mobileGridSelector.value);
            
            mobileGridSelector.addEventListener('change', (e) => {
                // On met à jour proprement la classe de la grille au changement de valeur
                productGrid.className = `product-grid ${e.target.value}`;
            });
        }

        filterAndSort();

        // NOUVEAU : Restauration de la position de scroll si on revient d'une page produit
        setTimeout(() => {
            const savedScroll = sessionStorage.getItem('terraophis_scroll');
            if (savedScroll) {
                window.scrollTo({ top: parseInt(savedScroll), behavior: 'smooth' });
                sessionStorage.removeItem('terraophis_scroll');
            }
        }, 100);

    } catch (error) {
        console.error("Erreur catalogue :", error);
        productGrid.innerHTML = '<p>Erreur lors du chargement des produits.</p>';
    }
}

async function loadProductDetails() {
    const detailsContainer = document.getElementById('productDetails');
    if (!detailsContainer) return;

    const urlParams = new URLSearchParams(window.location.search);
    const productId = urlParams.get('id');

    if (!productId) {
        detailsContainer.innerHTML = '<p>Produit introuvable.</p>';
        return;
    }

    try {
        const docRef = doc(db, "products", productId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists() && docSnap.data().hidden === true) {
            detailsContainer.innerHTML = '<div style="text-align:center; padding: 60px 20px;"><p style="font-family: \'Fraunces\', serif; font-size: 1.5rem;">Cet article n\'est plus disponible pour le moment 🌿</p><a href="boutique" class="btn-buy" style="display:inline-block; text-decoration:none; padding: 14px 30px; margin-top: 15px;">Découvrir la boutique</a></div>';
        } else if (docSnap.exists()) {
            const product = docSnap.data();
            window.currentProductDetails = product; // NOUVEAU : Enregistrement global pour les calculs de changements d'options
            
            if (product.bundleItems && product.bundleItems.length > 0) {
                let virtualStock = Infinity;
                for (const bItem of product.bundleItems) {
                    const subSnap = await getDoc(doc(db, "products", bItem.productId));
                    if (subSnap.exists()) {
                        const subStock = parseInt(subSnap.data().stock) || 0;
                        const itemLot = parseInt(bItem.lot) || 1;
                        const itemQty = parseInt(bItem.qty) || 1;
                        const possiblePacks = Math.floor(subStock / (itemQty * itemLot));
                        if (possiblePacks < virtualStock) virtualStock = possiblePacks;
                    } else {
                        virtualStock = 0;
                    }
                }
                product.stock = virtualStock === Infinity ? 0 : virtualStock;
            }

            const photos = product.photos && product.photos.length > 0 ? product.photos : ['assets/img/placeholder.jpg'];
            // NOUVEAU : Formatage à 2 décimales du prix barré dans la page produit
            const oldPriceHtml = product.oldPrice ? `<span style="text-decoration: line-through; color: #a35d5d; font-size: 1.4rem; margin-right: 12px; font-weight: normal;">${Number(product.oldPrice).toFixed(2)} €</span>` : '';
            const formattedDescription = product.description.replace(/\n/g, '<br>');
            const careGuideHtml = product.careGuide ? product.careGuide.replace(/\n/g, '<br>') : 'Aucune information complémentaire.';

            let thumbnailsHtml = '';
            photos.forEach((photo, index) => {
                thumbnailsHtml += `<img src="${photo}" alt="Miniature" onclick="document.getElementById('mainProductImg').src='${photo}'">`;
            });

            // NOUVEAU : Construction dynamique du sélecteur pour les options personnalisées (Matériel)
            let lotSelectorHtml = '';
            let defaultPrice = 0;
            let canBuySomething = false; 
            
            if (product.customOptions && product.customOptions.variants && product.customOptions.variants.length > 0) {
                // Tri par prix croissant
                const variants = product.customOptions.variants.sort((a, b) => a.price - b.price);
                defaultPrice = variants[0].price;
                
                lotSelectorHtml = `
                    <div class="lot-selector">
                        <label style="display:block; font-size:0.85rem; margin-bottom:5px;">${product.customOptions.name || 'Option'}</label>
                        <select id="lotSelect" onchange="window.updateDisplayPrice()">
                            ${variants.map(v => {
                                // NOUVEAU : On calcule le stock cumulé de la variante depuis la matrice
                                let variantTotalStock = 0;
                                if (product.variantStocks && Object.keys(product.variantStocks).length > 0) {
                                    for (const [key, val] of Object.entries(product.variantStocks)) {
                                        // Si la clé de la matrice correspond à l'option ou commence par "Option_"
                                        if (key === v.label || key.startsWith(v.label + '_')) {
                                            variantTotalStock += (parseInt(val) || 0);
                                        }
                                    }
                                } else {
                                    variantTotalStock = product.stock || 0;
                                }
                                
                                const isDisabled = variantTotalStock < 1 ? 'disabled' : ''; 
                                if (!isDisabled) canBuySomething = true;
                                
                                return `<option value="${v.label}" ${isDisabled}>${v.label} - ${Number(v.price).toFixed(2)} € ${isDisabled ? '(Rupture)' : ''}</option>`;
                            }).join('')}
                        </select>
                    </div>
                `;
            }
            // Fin NOUVEAU
            else if (product.prices && Object.keys(product.prices).length > 0) {
                const sortedLots = Object.keys(product.prices).map(Number).sort((a, b) => b - a);
                
                // On cherche le plus gros lot qu'il est possible d'acheter pour le mettre par défaut
                const defaultLot = sortedLots.find(lot => lot <= product.stock) || sortedLots[sortedLots.length - 1];
                defaultPrice = product.prices[defaultLot];

                lotSelectorHtml = `
                    <div class="lot-selector">
                        <label style="display:block; font-size:0.85rem; margin-bottom:5px;">Quantité</label>
                        <select id="lotSelect" onchange="updateDisplayPrice()">
                            ${sortedLots.map(lot => {
                                const isDisabled = lot > product.stock ? 'disabled' : '';
                                const isSelected = lot === defaultLot && !isDisabled ? 'selected' : '';
                                if (!isDisabled) canBuySomething = true;
                                
                                // NOUVEAU : Formatage et ajout attribut data-stock pour la page produit
                                return `<option value="${lot}" data-stock="${product.stock}" ${isSelected} ${isDisabled}>Lot de ${lot} - ${Number(product.prices[lot]).toFixed(2)} € ${isDisabled ? '(Stock insuffisant)' : ''}</option>`;
                            }).join('')}
                        </select>
                    </div>
                `;
            } else {
                // Rétrocompatibilité anciens articles
                let options = [];
                if (product.price) options.push({ lot: 1, price: product.price, label: "À l'unité" });
                if (product.price3) options.push({ lot: 3, price: product.price3, label: "Lot de 3" });
                if (product.price5) options.push({ lot: 5, price: product.price5, label: "Lot de 5" });
                if (product.price10) options.push({ lot: 10, price: product.price10, label: "Lot de 10" });
                
                // On trie du plus grand au plus petit pour la logique de sélection par défaut
                options.sort((a, b) => b.lot - a.lot);
                const defaultOpt = options.find(opt => opt.lot <= product.stock) || options[options.length - 1];
                if (defaultOpt) defaultPrice = defaultOpt.price;

                lotSelectorHtml = `
                    <div class="lot-selector">
                        <label style="display:block; font-size:0.85rem; margin-bottom:5px;">Quantité</label>
                        <select id="lotSelect" onchange="updateDisplayPrice()">
                            ${options.map(opt => {
                                const isDisabled = opt.lot > product.stock ? 'disabled' : '';
                                const isSelected = opt.lot === defaultOpt?.lot && !isDisabled ? 'selected' : '';
                                if (!isDisabled) canBuySomething = true;
                                
                                // NOUVEAU : Formatage et ajout attribut data-stock pour la page produit
                                return `<option value="${opt.lot}" data-stock="${product.stock}" ${isSelected} ${isDisabled}>${opt.label} - ${Number(opt.price).toFixed(2)} € ${isDisabled ? '(Stock insuffisant)' : ''}</option>`;
                            }).join('')}
                        </select>
                    </div>
                `;
            }

            // NOUVEAU : Ajout du sélecteur d'options gratuites s'il y en a
            let freeSelectorHtml = '';
            if (product.freeOptions && product.freeOptions.values && product.freeOptions.values.length > 0) {
                freeSelectorHtml = `
                    <div class="lot-selector" style="margin-top: 15px;">
                        <label style="display:block; font-size:0.85rem; margin-bottom:5px;">${product.freeOptions.name}</label>
                        <select id="freeOptionSelect" onchange="window.updateDisplayPrice()">
                            ${product.freeOptions.values.map(val => `<option value="${val}">${val}</option>`).join('')}
                        </select>
                    </div>
                `;
            }

            detailsContainer.innerHTML = `
                <div class="product-page-layout">
                    <div class="product-left">
                        <div class="gallery-wrapper">
                            <div class="thumbnails">${thumbnailsHtml}</div>
                            <div class="main-image">
                                <img src="${photos[0]}" id="mainProductImg" alt="${product.name}">
                            </div>
                        </div>
                        <div class="product-description-bottom">
                            ${formattedDescription}
                        </div>
                    </div>
                    
                    <div class="product-right">
                        <h1 style="font-family: 'Fraunces', serif; font-size: 2.5rem; margin: 0 0 5px 0;">${product.name}</h1>
                        <p class="product-latin" style="font-size: 1.1rem; font-style: italic; color: #777; margin-bottom: 20px;">${product.latinName && product.latinName !== "null" ? product.latinName : ""}</p>
                        <p class="product-price" style="font-size: 1.8rem; font-weight: 600; margin-bottom: 20px;">${oldPriceHtml}<span id="displayPrice">${Number(defaultPrice).toFixed(2)} €</span></p>
                        
                        ${lotSelectorHtml}
                        ${freeSelectorHtml}

                        <button class="btn-buy" onclick="addSelectedToCart('${docSnap.id}')" style="width: 100%; padding: 18px; font-size: 1.1rem; margin-bottom: 10px;" ${!canBuySomething ? 'disabled' : ''}>
                            ${canBuySomething ? 'Ajouter au panier' : 'RUPTURE DE STOCK'}
                        </button>
                        <p id="displayStock" style="text-align: center; font-size: 0.8rem; color: #666; margin-top: 0;">Stock dispo : ${product.customOptions && product.customOptions.variants && product.customOptions.variants.length > 0 ? (product.customOptions.variants.sort((a, b) => a.price - b.price)[0].stock !== undefined && product.customOptions.variants[0].stock !== "" ? product.customOptions.variants[0].stock : product.stock) : product.stock}</p>
                        
                        <div class="care-guide-section">
                            <h3>Fiche Complémentaire</h3>
                            <div class="care-guide-content">${careGuideHtml}</div>
                        </div>
                    </div>
                </div>
            `;
            window.updateDisplayPrice(); // NOUVEAU : Synchronisation forcée des stocks au premier affichage
        } else {
            detailsContainer.innerHTML = '<p>Ce produit n\'existe plus.</p>';
        }
    } catch (error) {
        console.error("Erreur détails produit :", error);
        detailsContainer.innerHTML = '<p>Erreur lors du chargement.</p>';
    }
}

// Fonctions globales pour le fonctionnement de la page et du panier
window.updateDisplayPrice = () => {
    const select = document.getElementById('lotSelect');
    const freeSelect = document.getElementById('freeOptionSelect');
    const product = window.currentProductDetails;

    if (select && select.options && select.options.length > 0 && select.selectedIndex !== -1) {
        const selectedOption = select.options[select.selectedIndex];
        const priceText = selectedOption.text.split(' - ')[1].split(' €')[0]; 
        document.getElementById('displayPrice').textContent = Number(priceText).toFixed(2) + ' €';
        
        let currentStock = product ? product.stock : 0;
        
        if (product && product.variantStocks) {
            const customVal = select.value;
            const freeVal = freeSelect ? freeSelect.value : null;
            const combKey = freeVal ? `${customVal}_${freeVal}` : customVal;
            
            if (product.variantStocks[combKey] !== undefined && product.variantStocks[combKey] !== "") {
                currentStock = parseInt(product.variantStocks[combKey]) || 0;
            } else if (Object.keys(product.variantStocks).length > 0) {
                currentStock = 0; // Si la matrice existe mais pas cette déclinaison précise
            }
        }
        
        const stockEl = document.getElementById('displayStock');
        if (stockEl) {
            stockEl.textContent = `Stock dispo : ${currentStock}`;
        }

        // NOUVEAU : Mise à jour de l'état du bouton d'ajout au panier selon la combinaison choisie
        const buyBtn = document.querySelector('button[onclick^="addSelectedToCart"]');
        if (buyBtn) {
            if (currentStock < 1) {
                buyBtn.disabled = true;
                buyBtn.textContent = 'RUPTURE DE STOCK';
            } else {
                buyBtn.disabled = false;
                buyBtn.textContent = 'Ajouter au panier';
            }
        }
    }
};

window.addSelectedToCart = (id) => {
    const select = document.getElementById('lotSelect');
    let lotSize = null;
    if (select) {
        const val = select.value;
        lotSize = /^\d+$/.test(val) ? parseInt(val) : val;
    }
    
    // NOUVEAU : Récupération de l'option gratuite sélectionnée
    const freeSelect = document.getElementById('freeOptionSelect');
    const freeOption = freeSelect ? freeSelect.value : null;
    
    addToCart(id, lotSize, freeOption);
};

// NOUVEAU : Fonction de validation globale du stock croisé
async function validateCartStock(simulatedCart) {
    let physicalNeeds = {};
    
    const uniqueProductIds = [...new Set(simulatedCart.map(i => i.id))];
    const productDefs = {};
    
    for(const id of uniqueProductIds) {
        const snap = await getDoc(doc(db, "products", id));
        if(snap.exists()) productDefs[id] = snap.data();
    }

    if (simulatedCart.some(item => !productDefs[item.id] || productDefs[item.id].hidden === true)) return false;

    for (const simItem of simulatedCart) {
        const def = productDefs[simItem.id];
        if (!def) continue;

        if (def.bundleItems && def.bundleItems.length > 0) {
            for (const bItem of def.bundleItems) {
                if (!physicalNeeds[bItem.productId]) physicalNeeds[bItem.productId] = 0;
                const itemLot = parseInt(bItem.lot) || 1;
                const itemQty = parseInt(bItem.qty) || 1;
                physicalNeeds[bItem.productId] += simItem.quantity * itemQty * itemLot;
            }
        } else {
            // NOUVEAU : Construction de l'identifiant unique croisé pour le suivi du panier
            let trackingKey = simItem.id;
            if (typeof simItem.lotSize === 'string') {
                trackingKey = simItem.freeOption ? `${simItem.id}_${simItem.lotSize}_${simItem.freeOption}` : `${simItem.id}_${simItem.lotSize}`;
            }

            const multiplier = (typeof simItem.lotSize === 'number') ? simItem.lotSize : 1;
            if (!physicalNeeds[trackingKey]) physicalNeeds[trackingKey] = 0;
            physicalNeeds[trackingKey] += simItem.quantity * multiplier;
        }
    }

    for (const [trackingKey, neededQty] of Object.entries(physicalNeeds)) {
        let realStock = 0;
        
        if (trackingKey.includes('_')) {
            const parts = trackingKey.split('_');
            const pId = parts[0];
            const lotSize = parts[1];
            const freeOpt = parts[2] || null;
            
            const def = productDefs[pId];
            const combKey = freeOpt ? `${lotSize}_${freeOpt}` : lotSize;
            
            if (def && def.variantStocks && def.variantStocks[combKey] !== undefined) {
                realStock = def.variantStocks[combKey];
            } else if (def) {
                realStock = def.stock;
            }
        } else {
            if (productDefs[trackingKey]) {
                realStock = productDefs[trackingKey].stock;
            } else {
                const snap = await getDoc(doc(db, "products", trackingKey));
                if (snap.exists()) realStock = snap.data().stock;
            }
        }

        if (neededQty > realStock) {
            return false; 
        }
    }
    return true; 
}

// NOUVEAU : Logique du panier avec gestion du Stock Croisé
// NOUVEAU : Logique du panier avec gestion du Stock Croisé et options gratuites
window.addToCart = async (productId, lotSize = null, freeOption = null) => {
    let cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    
    // NOUVEAU : On intègre l'option gratuite dans l'ID du panier pour bien séparer les variantes
    let cartId = productId;
    if (lotSize) cartId += `_${lotSize}`;
    if (freeOption) cartId += `_${freeOption.replace(/\s+/g, '-')}`;

    // 1. On simule le panier AVEC le nouvel ajout
    let simulatedCart = JSON.parse(JSON.stringify(cart));
    const existingItem = simulatedCart.find(item => item.cartId === cartId);
    
    if (existingItem) {
        existingItem.quantity += 1;
    } else {
        simulatedCart.push({ id: productId, cartId: cartId, lotSize: lotSize, freeOption: freeOption, quantity: 1 });
    }

    // 2. On vérifie si ce panier simulé est mathématiquement possible avec les stocks réels
    const isPossible = await validateCartStock(simulatedCart);

    if (!isPossible) {
        alert("Stock insuffisant ! Certains insectes sont déjà réservés par d'autres articles ou packs de votre panier. 🌿");
        return;
    }

    // 3. Si c'est validé, on sauvegarde
    localStorage.setItem('terraophis_cart', JSON.stringify(simulatedCart));
    
    if (typeof window.updateFloatingCart === 'function') window.updateFloatingCart();
    toggleCart(true); 
};

window.updateCartQty = async (cartId, change) => {
    let cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    const itemIndex = cart.findIndex(item => item.cartId === cartId);
    
    if (itemIndex > -1) {
        const item = cart[itemIndex];
        const newQty = item.quantity + change;
        
        if (newQty <= 0) {
            cart.splice(itemIndex, 1);
            localStorage.setItem('terraophis_cart', JSON.stringify(cart));
            renderCart();
            if (typeof window.updateFloatingCart === 'function') window.updateFloatingCart();
            return;
        }

        // Si on essaie d'ajouter un article (bouton +)
        if (change > 0) {
            let simulatedCart = JSON.parse(JSON.stringify(cart));
            simulatedCart[itemIndex].quantity = newQty;

            const isPossible = await validateCartStock(simulatedCart);
            if (!isPossible) {
                alert("Stock maximum atteint compte tenu des autres articles de votre panier 🌿");
                return;
            }
        }
        
        cart[itemIndex].quantity = newQty;
        localStorage.setItem('terraophis_cart', JSON.stringify(cart));
        renderCart();
        
        if (typeof window.updateFloatingCart === 'function') window.updateFloatingCart();
    }
};

window.renderCart = async () => {
    const container = document.getElementById('cartItemsContainer');
    const totalEl = document.getElementById('cartTotalAmount');
    const btnCheckout = document.getElementById('btnCheckout');
    
    let rawCart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    let cart = rawCart.filter(item => item.cartId !== undefined && item.cartId !== null);
    
    if (cart.length !== rawCart.length) {
        localStorage.setItem('terraophis_cart', JSON.stringify(cart));
    }

    if (cart.length === 0) {
        container.innerHTML = '<p style="text-align: center; margin-top: 50px; color: #888;">Votre panier est vide.</p>';
        totalEl.textContent = '0.00 €';
        btnCheckout.disabled = true;
        btnCheckout.style.opacity = '0.5';
        return;
    }

    btnCheckout.disabled = false;
    btnCheckout.style.opacity = '1';
    container.innerHTML = '<p style="text-align: center;">Chargement de vos spécimens...</p>';
    
    let total = 0;
    let html = '';
    let cartModified = false;

    for (let i = 0; i < cart.length; i++) {
        try {
            const docSnap = await getDoc(doc(db, "products", cart[i].id));
            if (docSnap.exists()) {
                const p = docSnap.data();
                const itemLot = cart[i].lotSize; 
                
                // NOUVEAU : Sécurisation du calcul de stock virtuel pour éviter les "NaN"
                let maxStock = parseInt(p.stock) || 0;
                if (p.hidden === true) maxStock = 0; // Article masqué depuis l'admin : retiré du panier
                else if (p.bundleItems && p.bundleItems.length > 0) {
                    let virtualStock = Infinity;
                    for (const bItem of p.bundleItems) {
                        const subSnap = await getDoc(doc(db, "products", bItem.productId));
                        const subStock = subSnap.exists() ? (parseInt(subSnap.data().stock) || 0) : 0;
                        const possiblePacks = Math.floor(subStock / ((parseInt(bItem.qty) || 1) * (parseInt(bItem.lot) || 1)));
                        if (possiblePacks < virtualStock) virtualStock = possiblePacks;
                    }
                    maxStock = virtualStock === Infinity ? 0 : virtualStock;
                }

                // NOUVEAU : Récupération du prix si c'est une option personnalisée texte
                let itemPrice = 0;
                if (p.customOptions && p.customOptions.variants && typeof itemLot === 'string') {
                    const variant = p.customOptions.variants.find(v => v.label === itemLot);
                    if (variant) itemPrice = variant.price;
                    
                    // NOUVEAU : Application de la limite de stock croisée précise dans le panier
                    if (p.variantStocks) {
                        const freeOpt = cart[i].freeOption;
                        const combKey = freeOpt ? `${itemLot}_${freeOpt}` : itemLot;
                        if (p.variantStocks[combKey] !== undefined) {
                            maxStock = p.variantStocks[combKey];
                        }
                    }
                } else if (p.prices && p.prices[itemLot] !== undefined) {
                    itemPrice = p.prices[itemLot];
                } else {
                    itemPrice = itemLot === 1 ? p.price : p[`price${itemLot}`] || p.price || 0;
                }

                // NOUVEAU : Multiplicateur à 1 si c'est du matériel
                const multiplier = (typeof itemLot === 'number') ? itemLot : 1;
                
                if ((cart[i].quantity * multiplier) > maxStock) {
                    cart[i].quantity = Math.floor(maxStock / multiplier);
                    cartModified = true;
                }
                
                if (cart[i].quantity <= 0) {
                    cart.splice(i, 1);
                    cartModified = true;
                    i--; 
                    continue; 
                }
                
                const itemTotal = itemPrice * cart[i].quantity;
                total += itemTotal;
                const photo = p.photos?.length > 0 ? p.photos[0] : 'assets/img/placeholder.jpg';
                
                // NOUVEAU : Affichage textuel propre selon si c'est un lot ou une option matérielle
                let lotText = '';
                if (typeof itemLot === 'string') {
                    lotText = `<br><span style="font-size:0.75rem; color:#888;">Option : ${itemLot}</span>`;
                } else if (itemLot && itemLot > 1) {
                    lotText = `<br><span style="font-size:0.75rem; color:#888;">Lot de ${itemLot}</span>`;
                }
                const freeOptText = cart[i].freeOption ? `<br><span style="font-size:0.75rem; color:#888;">${cart[i].freeOption}</span>` : '';

                const oldPriceHtml = p.oldPrice ? `<span style="text-decoration: line-through; color: #a35d5d; font-size: 0.85rem; margin-right: 6px; font-weight: normal;">${Number(p.oldPrice).toFixed(2)} €</span>` : '';

                html += `
                    <div class="cart-item" style="position: relative;">
                        <img src="${photo}" alt="${p.name}">
                        <div class="cart-item-details">
                            <button onclick="removeFromCart('${cart[i].cartId}')" style="position: absolute; top: 10px; right: 10px; background: none; border: none; color: #a35d5d; font-size: 1.5rem; cursor: pointer; line-height: 1;">&times;</button>
                            <p class="cart-item-title" style="padding-right: 20px; margin-bottom: 2px;">${p.name}${lotText}${freeOptText}</p>
                            <p class="cart-item-price">${oldPriceHtml}${Number(itemPrice).toFixed(2)} €</p>
                            <div class="cart-qty-controls">
                                <button onclick="updateCartQty('${cart[i].cartId}', -1)">-</button>
                                <span>${cart[i].quantity}</span>
                                <button onclick="updateCartQty('${cart[i].cartId}', 1)">+</button>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                cart.splice(i, 1);
                cartModified = true;
                i--;
            }
        } catch (e) { console.error("Erreur panier :", e); }
    }

    if (cartModified) {
        localStorage.setItem('terraophis_cart', JSON.stringify(cart));
        if (typeof window.updateFloatingCart === 'function') window.updateFloatingCart();
    }

    if (cart.length === 0) {
        renderCart();
        return;
    }

    container.innerHTML = html;
    totalEl.textContent = total.toFixed(2) + ' €';
    localStorage.setItem('terraophis_cart_total', total);
};

// Ligne précédente
window.removeFromCart = (cartId) => {
    let cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    cart = cart.filter(item => item.cartId !== cartId);
    localStorage.setItem('terraophis_cart', JSON.stringify(cart));
    renderCart();
    
    // NOUVEAU : Synchronisation de la bulle après suppression
    if (typeof window.updateFloatingCart === 'function') window.updateFloatingCart();
};

// NOUVEAU : Fonction centralisée pour mettre à jour la bulle flottante
window.updateFloatingCart = () => {
    let cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    cart = cart.filter(item => item.cartId !== undefined && item.cartId !== null);
    
    // Calcule la quantité totale d'articles distincts
    let totalItemsCount = cart.reduce((sum, item) => sum + item.quantity, 0);
    
    const floatBtn = document.getElementById('floatingCartBtn');
    const floatBadge = document.getElementById('floatingCartBadge');
    
    if (floatBtn && floatBadge) {
        if (totalItemsCount > 0) {
            floatBtn.classList.add('visible');
            floatBadge.textContent = totalItemsCount;
            // Animation de rebond
            floatBtn.classList.add('bounce');
            setTimeout(() => floatBtn.classList.remove('bounce'), 300);
        } else {
            floatBtn.classList.remove('visible');
        }
    }
};

// NOUVEAU: Gestion complète du panier
// Ligne suivante
window.toggleCart = (forceOpen = false) => {
    const overlay = document.getElementById('cartOverlay');
    const sidebar = document.getElementById('cartSidebar');
    
    if (forceOpen || !sidebar.classList.contains('open')) {
        overlay.classList.add('active');
        sidebar.classList.add('open');
        renderCart();
    } else {
        overlay.classList.remove('active');
        sidebar.classList.remove('open');
    }
};

window.processCheckout = async () => {
    const cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    const totalValue = parseFloat(localStorage.getItem('terraophis_cart_total') || 0);

    if (cart.length === 0 || totalValue <= 0) return;

    const user = auth.currentUser;
    if (!user) {
            alert("Veuillez vous connecter pour valider votre panier 🌿");
            window.location.href = 'connexion.html';
            return;
        }

        window.location.href = 'checkout.html';
    };

async function loadHeroSlider() {
    const heroHeader = document.querySelector('.hero-slider');
    if (!heroHeader) return; 

    try {
        const docRef = doc(db, "settings", "heroSlider");
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists() && docSnap.data().photos?.length > 0) {
            const photos = docSnap.data().photos;
            let sliderHtml = '';
            
            if (photos.length > 1) {
                sliderHtml += `
                    <div style="position: absolute; top:0; left:0; width:100%; height:100%; z-index: 10; pointer-events: none;">
                        <button class="slider-arrow prev" style="pointer-events: auto;">‹</button>
                        <button class="slider-arrow next" style="pointer-events: auto;">›</button>
                    </div>`;
            }

            photos.forEach((photoData, index) => {
                const isObject = typeof photoData === 'object' && photoData !== null;
                const url = isObject ? photoData.url : photoData;
                const text = isObject ? (photoData.text || '') : '';
                const link = isObject ? (photoData.link || '') : '';

                const bannerHtml = text ? `<div class="slide-banner">${text}</div>` : '';
                
                const tag = link.trim() ? 'a' : 'div';
                const hrefAttr = link.trim() ? `href="${link}"` : '';
                
                sliderHtml += `
                    <${tag} ${hrefAttr} class="slide" style="display: block; text-decoration: none; background-image: url('${url}'); position: absolute; top:0; left:0; width: 100%; height: 100%; opacity: ${index === 0 ? 1 : 0}; pointer-events: ${index === 0 ? 'auto' : 'none'}; transition: opacity 1s ease-in-out; background-size: cover; background-position: center; z-index: 1;">
                        ${bannerHtml}
                    </${tag}>
                `;
            });
            
            heroHeader.innerHTML = sliderHtml;
            
            const slides = heroHeader.querySelectorAll('.slide');
            if (slides.length > 1) {
                let current = 0;
                let sliderInterval;

                const goToSlide = (n) => {
                    slides[current].style.opacity = 0;
                    slides[current].style.pointerEvents = 'none'; 
                    current = (n + slides.length) % slides.length;
                    slides[current].style.opacity = 1;
                    slides[current].style.pointerEvents = 'auto'; 
                };

                const nextSlide = () => goToSlide(current + 1);
                const prevSlide = () => goToSlide(current - 1);

                heroHeader.querySelector('.next').addEventListener('click', (e) => { 
                    e.preventDefault();
                    nextSlide(); 
                    resetInterval(); 
                });
                heroHeader.querySelector('.prev').addEventListener('click', (e) => { 
                    e.preventDefault();
                    prevSlide(); 
                    resetInterval(); 
                });

                const resetInterval = () => {
                    clearInterval(sliderInterval);
                    sliderInterval = setInterval(nextSlide, 8000); // NOUVEAU : Délai augmenté à 8 secondes
                };
                
                sliderInterval = setInterval(nextSlide, 8000); // NOUVEAU : Délai augmenté à 8 secondes
            }
        } else {
            (heroHeader.closest('.banner-section') || heroHeader).style.display = 'none';
        }
    } catch (error) {
        console.error("Erreur de chargement du slider :", error);
    }
}

/**
 * Récupère les configurations de la grille "Features" et les applique
 */
async function loadFeaturesGrid() {
    const boutiqueCard = document.getElementById('boutique-feature');
    const conseilCard = document.getElementById('conseil-feature');
    if (!boutiqueCard || !conseilCard) return;

    try {
        const docRef = doc(db, "settings", "featureGrid");
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            const data = docSnap.data();
            
            const applyImages = (container, urls) => {
                if (!urls) return;
                const imgs = container.querySelectorAll('img');
                urls.forEach((url, i) => {
                    if (imgs[i]) imgs[i].src = url;
                });
            };

            applyImages(boutiqueCard, data.boutique);
            applyImages(conseilCard, data.conseil);
        }
    } catch (e) {
        console.error("Erreur de chargement de la grille :", e);
    }
}


async function loadNavbar() {
    const navElement = document.getElementById('main-navbar');
    if (!navElement) return;

    try {
        const response = await fetch('components/navbar.html');
        const html = await response.text();
        navElement.innerHTML = html;

        const dropdownContent = navElement.querySelector('.dropdown-content');
        if (dropdownContent) {
            const categoriesSnap = await getDocs(collection(db, "categories"));
            
            // NOUVEAU : Retour aux textes purs, non-cliquables
            let animauxHtml = '';
            let materielsHtml = '';
            let packsHtml = '';
            
            categoriesSnap.forEach(catDoc => {
                const cat = catDoc.data();
                const itemHtml = `<li><a href="boutique.html?cat=${catDoc.id}">→ ${cat.name.toUpperCase()}</a></li>`;
                
                if (cat.type === 'materiels') {
                    materielsHtml += itemHtml;
                } else if (cat.type === 'packs') {
                    packsHtml += itemHtml;
                } else {
                    animauxHtml += itemHtml;
                }
            });
            
            // Un groupe n'apparaît que s'il contient au moins une catégorie
            const group = (title, items) => items ? `<li class="dropdown-divider"></li><li class="dropdown-subtitle">${title}</li>${items}` : '';
            dropdownContent.innerHTML = '<li><a href="boutique"><strong>Toute la boutique</strong></a></li>'
                + group('ANIMAUX', animauxHtml) + group('MATÉRIELS & ACCESSOIRES', materielsHtml) + group('KITS & PACKS', packsHtml);
        }

        applyContent(navElement);

        // Lien actif : on compare le nom de la page (fonctionne aussi depuis /test/)
        const pageName = (path) => (path.split('/').pop() || 'index').replace(/\.html$/, '') || 'index';
        const currentPage = pageName(window.location.pathname);
        navElement.querySelectorAll('.nav-links > li > a').forEach(link => {
            const target = pageName(new URL(link.getAttribute('href'), window.location.href).pathname);
            if (target === currentPage && !link.getAttribute('href').startsWith('#')) link.classList.add('active');
        });

        const hamburgerBtn = navElement.querySelector('#hamburger-btn');
        const navLinks = navElement.querySelector('#nav-links');

        if (hamburgerBtn && navLinks) {
            hamburgerBtn.addEventListener('click', () => {
                const open = navLinks.classList.toggle('open');
                hamburgerBtn.classList.toggle('active', open);
                hamburgerBtn.setAttribute('aria-expanded', String(open));
            });
            navLinks.querySelectorAll('a').forEach(a => a.addEventListener('click', (e) => {
                if (a.parentElement.classList.contains('dropdown') && window.innerWidth <= 960) return;
                navLinks.classList.remove('open');
                hamburgerBtn.classList.remove('active');
            }));
        }

        const onScroll = () => navElement.classList.toggle('scrolled', window.scrollY > 20);
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();

        const dropdowns = navElement.querySelectorAll('.dropdown');
        dropdowns.forEach(dropdown => {
            dropdown.querySelector(':scope > a').addEventListener('click', (e) => {
                if (window.innerWidth <= 960) {
                    e.preventDefault();
                    dropdown.classList.toggle('active-mobile');
                }
            });
        });

        if (typeof window.updateNavAuthUI === 'function') {
            window.updateNavAuthUI(auth.currentUser);
        }

    } catch (error) {
        console.error("Erreur lors du chargement de la navbar :", error);
    }
}

// Ajoute ceci à ton fichier app.js
async function loadFooter() {
    const footerElement = document.getElementById('main-footer');
    if (!footerElement) return;

    try {
        const response = await fetch('components/footer.html');
        const html = await response.text();
        footerElement.innerHTML = html;
        applyContent(footerElement);
        footerElement.querySelectorAll('.js-year').forEach(el => { el.textContent = new Date().getFullYear(); });
        if (window.location.hash === '#contact') document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' });

        // Gestion de l'envoi du formulaire de contact
        const contactForm = document.getElementById('footer-contact-form');
        if (contactForm) {
            contactForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const btn = contactForm.querySelector('button[type="submit"]');
                const status = contactForm.querySelector('.form-status');
                btn.disabled = true;
                status.className = 'form-status';
                status.textContent = 'Envoi en cours…';
                try {
                    const formData = new FormData(contactForm);
                    const res = await fetch('/api/contact', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: formData.get('name'), email: formData.get('email'), message: formData.get('message') })
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data.error || "Envoi impossible");
                    status.classList.add('ok');
                    status.textContent = 'Merci ! Votre message est bien parti, on vous répond très vite 🌿';
                    contactForm.reset();
                } catch (err) {
                    status.classList.add('err');
                    status.textContent = `Votre message n'a pas pu être envoyé (${err.message}). Écrivez-nous directement à terra.ophis@gmail.com`;
                } finally {
                    btn.disabled = false;
                }
            });
        }
    } catch (error) {
        console.error("Erreur chargement footer :", error);
    }
}
// Fonction pour charger la galerie (Simulée pour l'instant)
async function loadInstaGallery() {
    const feed = document.getElementById('instafeed');
    if (!feed) return;

    // REMPLACE par ton URL générée sur Behold.so
    const BEHOLD_API_URL = "https://behold.so/api/v1/posts?api_key=TON_CLE_ICI";

    try {
        const response = await fetch(BEHOLD_API_URL);
        
        if (!response.ok) throw new Error("Erreur lors de la récupération Instagram");
        
        const posts = await response.json();
        
        // On ne garde que les 4 premiers pour la grille
        const lastFour = posts.slice(0, 4);

        feed.innerHTML = lastFour.map(post => `
            <div class="insta-item">
                <a href="${post.permalink}" target="_blank">
                    <img src="${post.media_url}" alt="Post Terraophis" loading="lazy">
                </a>
            </div>
        `).join('');

    } catch (error) {
        console.error("Erreur Galerie Instagram :", error);
        // Fallback : on affiche des images par défaut ou un message si l'API échoue
        feed.innerHTML = `
            <div class="insta-placeholder" style="grid-column: 1/-1; padding: 20px; opacity: 0.5;">
                Impossible de charger le flux Instagram pour le moment.
            </div>
        `;
    }
}


// NOUVEAU : Charge la grille de tous les guides pour la page conseils.html avec vérification de l'activation
async function loadGuidesList() {
    const grid = document.getElementById('guidesGrid');
    if (!grid) return;
    
    grid.innerHTML = '<p class="loading-note">Chargement des fiches… 🌿</p>';
    
    try {
        // Vérification de l'activation globale de la page
        const configSnap = await getDoc(doc(db, "settings", "guidesConfig"));
        if (configSnap.exists() && configSnap.data().isActive === false) {
            grid.innerHTML = '<p class="loading-note" style="animation:none">Nos fiches détaillées arrivent bientôt 🌿</p>';
            return;
        }

        const q = query(collection(db, "guides"), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        
        if (snap.empty) {
            grid.innerHTML = '<p style="text-align:center; grid-column: 1/-1; color: #888;">Aucun guide publié pour le moment.</p>';
            return;
        }
        
        grid.innerHTML = '';
        snap.forEach(docSnap => {
            const g = docSnap.data();
            
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = g.content;
            let excerpt = tempDiv.textContent || tempDiv.innerText || "";
            excerpt = excerpt.length > 150 ? excerpt.substring(0, 150) + "..." : excerpt;
            
            const cover = g.imageUrl || 'assets/img/placeholder.jpg';
            
            const card = document.createElement('div');
            card.className = 'product-card';
            card.innerHTML = `
                <a href="guide.html?id=${docSnap.id}" style="text-decoration: none; color: inherit; display: block; position: relative;">
                    <img src="${cover}" alt="${g.title}" class="product-image">
                    <div class="product-info">
                        <h3 class="product-name">${g.title}</h3>
                        <p style="font-size: 0.85rem; color: #777; line-height: 1.5; margin: 8px 0 0;">${excerpt}</p>
                    </div>
                </a>
                <a href="guide.html?id=${docSnap.id}" class="btn-buy" style="display: block; text-align: center; text-decoration: none; width: 100%; box-sizing: border-box;">LIRE LA FICHE</a>
            `;
            grid.appendChild(card);
        });
    } catch (error) {
        console.error("Erreur chargement guides:", error);
        grid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Erreur lors du chargement.</p>';
    }
}

// NOUVEAU : Charge un guide spécifique en entier pour la page guide.html
async function loadSingleGuide() {
    const container = document.getElementById('singleGuideContainer');
    if (!container) return;

    const urlParams = new URLSearchParams(window.location.search);
    const guideId = urlParams.get('id');

    if (!guideId) {
        container.innerHTML = '<p style="text-align:center;">Guide introuvable.</p>';
        return;
    }

    try {
        const docRef = doc(db, "guides", guideId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            const g = docSnap.data();
            const dateObj = g.createdAt?.toDate() ? g.createdAt.toDate().toLocaleDateString('fr-FR') : '';
            const cover = g.imageUrl ? `<img src="${g.imageUrl}" alt="${g.title}" class="guide-hero-img">` : '';

            container.innerHTML = `
                <header class="guide-header">
                    <h1>${g.title}</h1>
                    <p class="guide-meta">Publié le ${dateObj}</p>
                </header>
                ${cover}
                <div class="guide-content-body">
                    ${g.content}
                </div>
            `;
        } else {
            container.innerHTML = '<p style="text-align:center;">Cette fiche conseil n\'existe plus.</p>';
        }
    } catch (error) {
        console.error("Erreur détails guide :", error);
        container.innerHTML = '<p style="text-align:center;">Erreur lors du chargement.</p>';
    }
}

// NOUVEAU : Injection automatique du bouton flottant sur tout le site
function initFloatingCart() {
    if (document.getElementById('floatingCartBtn')) return;
    
    const btn = document.createElement('div');
    btn.id = 'floatingCartBtn';
    btn.className = 'floating-cart-btn';
    btn.onclick = () => toggleCart(true);
    btn.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
        <span id="floatingCartBadge" class="floating-cart-badge">0</span>
    `;
    document.body.appendChild(btn);
    if (typeof window.updateFloatingCart === 'function') window.updateFloatingCart();
}

// =========================================================
// VIE & MOUVEMENT
// =========================================================
function renderFaq() {
    const list = document.getElementById('faqList');
    if (!list) return;
    list.innerHTML = site.faq.map(item => `
        <details>
            <summary>${escapeHtml(item.question)}</summary>
            <div class="faq-body">${item.reponse}</div>
        </details>`).join('');
    const items = list.querySelectorAll('details');
    items.forEach(d => d.addEventListener('toggle', () => {
        if (d.open) items.forEach(o => { if (o !== d) o.open = false; });
    }));
}

const revealObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        revealObserver.unobserve(entry.target);
    }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' })
    : null;

function initReveal() {
    document.querySelectorAll('.reveal:not(.in)').forEach(el => {
        if (revealObserver) revealObserver.observe(el); else el.classList.add('in');
    });
}

function initCounters() {
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        observer.unobserve(el);
        // Le nombre est lu dans le texte (modifiable depuis l'admin) : "3 ans" -> 3 + " ans"
        const match = el.textContent.trim().match(/^(\D*)(\d+)(.*)$/s);
        if (!match) return;
        const [, prefix, number, suffix] = match;
        const target = parseInt(number);
        const start = performance.now();
        const tick = (now) => {
            const p = Math.min((now - start) / 1400, 1);
            el.textContent = prefix + Math.round(target * (1 - Math.pow(1 - p, 3))) + suffix;
            if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }), { threshold: 0.5 });
    document.querySelectorAll('[data-count]').forEach(el => observer.observe(el));
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Effet 3D léger qui suit la souris sur les cartes
function initTilt(root = document) {
    if (reducedMotion || !window.matchMedia('(hover: hover)').matches) return;
    root.querySelectorAll('.product-card, .feature-card, .card').forEach(card => {
        if (card.dataset.tilt) return;
        card.dataset.tilt = '1';
        card.addEventListener('mousemove', (e) => {
            const r = card.getBoundingClientRect();
            const x = (e.clientX - r.left) / r.width - 0.5;
            const y = (e.clientY - r.top) / r.height - 0.5;
            card.style.setProperty('--rx', `${(-y * 6).toFixed(2)}deg`);
            card.style.setProperty('--ry', `${(x * 8).toFixed(2)}deg`);
        });
        card.addEventListener('mouseleave', () => {
            card.style.removeProperty('--rx');
            card.style.removeProperty('--ry');
        });
    });
}

// Barre de progression de lecture
function initScrollProgress() {
    const bar = document.createElement('div');
    bar.className = 'scroll-progress';
    document.body.appendChild(bar);
    const update = () => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        bar.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
    };
    window.addEventListener('scroll', update, { passive: true });
    update();
}

// Le cloporte de l'accueil se met en boule quand on clique dessus
function initIsopodWalker() {
    document.querySelectorAll('.isopod-walker').forEach(walker => {
        let timer;
        walker.addEventListener('click', () => {
            walker.classList.add('rolled');
            clearTimeout(timer);
            timer = setTimeout(() => walker.classList.remove('rolled'), 2600);
        });
    });
}

// =========================================================
// LANCEMENT
// =========================================================
async function boot() {
    const cached = readContentCache();
    if (cached) {
        try { siteContent = JSON.parse(cached); } catch { siteContent = {}; }
        applyContent();
        document.documentElement.classList.add('cms-ready');
    }

    loadFooter();
    loadFeaturesGrid();
    loadHeroSlider();
    loadProductDetails();
    loadCatalogue();
    loadGuidesList();
    loadSingleGuide();
    loadNavbar();
    initFloatingCart();
    initScrollProgress();
    initIsopodWalker();
    initTilt();

    if (!cached) await refreshContent();
    renderFaq();
    initReveal();
    initCounters();
    document.documentElement.classList.add('cms-ready');
    if (cached) refreshContent().then(changed => { if (changed) { renderFaq(); initReveal(); } });
}

boot();

// NOUVEAU : Sauvegarde du scroll avant de quitter la boutique ou l'accueil
window.addEventListener('beforeunload', () => {
    if (window.location.pathname.includes('boutique') || /\/(index(\.html)?)?$/.test(window.location.pathname) || window.location.search.includes('cat=')) {
        sessionStorage.setItem('terraophis_scroll', window.scrollY);
    }
});