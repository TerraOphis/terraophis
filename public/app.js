import { db, auth } from './firebase-config.js';
import { collection, query, getDocs, orderBy, doc, getDoc, addDoc, setDoc, updateDoc, increment, serverTimestamp, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

let allProducts = []; // Stockage local pour filtrer sans requêter Firebase en boucle

// NOUVEAU : Gestion de l'état de connexion client et injection de l'icône de profil
// NOUVEAU : Mise à jour dynamique du bouton de la navbar selon l'état
window.updateNavAuthUI = (user) => {
    const authBtn = document.getElementById('nav-auth-btn');
    if (!authBtn) return; 

    if (user) {
        // NOUVEAU : Si connecté, on met l'icône profil (verte) vers la page profil
        authBtn.href = '/profil.html';
        authBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#586d32" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    } else {
        // NOUVEAU : Si déconnecté, on remet le texte Connexion
        authBtn.href = '/connexion.html';
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
        
        // Sauvegarde ou mise à jour automatique des infos de base dans Firestore
        await setDoc(doc(db, "users", result.user.uid), {
            name: result.user.displayName,
            email: result.user.email,
            updatedAt: serverTimestamp()
        }, { merge: true });
        
        alert(`Ravi de vous revoir, ${result.user.displayName} ! 🌿`);
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

    // NOUVEAU : Remplissage dynamique des options du filtre de catégorie depuis Firestore
    // Ligne précédente
    if (categoryFilter) {
        const categoriesSnap = await getDocs(collection(db, "categories"));
        let optionsHtml = '<option value="all">Toutes les catégories</option>';
        categoriesSnap.forEach(catDoc => {
            // NOUVEAU : Utilisation des backticks (`) pour que les variables soient bien injectées
            optionsHtml += `<option value="${catDoc.id}">${catDoc.data().name}</option>`;
        });
        categoryFilter.innerHTML = optionsHtml;
    }

    if (initialCat && categoryFilter) {
        categoryFilter.value = initialCat;
    }

    productGrid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Préparation du vivarium... 🌿</p>';

    try {
        const q = query(collection(db, "products"), orderBy("createdAt", "desc"));
        const querySnapshot = await getDocs(q);
        
        const allProducts = querySnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        const renderProducts = (productsToDisplay) => {
            productGrid.innerHTML = ''; 
            if (productsToDisplay.length === 0) {
                productGrid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Aucun spécimen ne correspond.</p>';
                return;
            }

            productsToDisplay.forEach((product) => {
                const photoUrl = product.photos && product.photos.length > 0 ? product.photos[0] : 'assets/img/placeholder.jpg';
                
                let basePrice = 0;
                let lotText = '';
                
                if (product.prices && Object.keys(product.prices).length > 0) {
                    const lots = Object.keys(product.prices).map(Number).sort((a, b) => b - a);
                    const maxLot = lots[0];
                    basePrice = product.prices[maxLot];
                    lotText = maxLot > 1 ? ` <span style="font-size: 0.8rem; color: #888; font-weight: normal;">(les ${maxLot})</span>` : '';
                } else {
                    if (product.price10) { basePrice = product.price10; lotText = ' (les 10)'; }
                    else if (product.price5) { basePrice = product.price5; lotText = ' (les 5)'; }
                    else if (product.price3) { basePrice = product.price3; lotText = ' (les 3)'; }
                    else { basePrice = product.price || 0; }
                }
                
                const hasLots = (product.prices && Object.keys(product.prices).length > 1) || product.price5 || product.price10 || product.price3;
                const btnAction = hasLots ? `window.location.href='/produit.html?id=${product.id}'` : `addToCart('${product.id}')`;
                const btnText = hasLots ? 'VOIR LES OPTIONS' : 'AJOUTER AU PANIER';
                const isLowStock = product.stock > 0 && product.stock <= 10;
                const badgeHtml = isLowStock ? '<span class="low-stock-badge">Bientôt épuisé</span>' : '';

                const card = document.createElement('div');
                card.className = 'product-card';
                card.innerHTML = `
                    <a href="/produit.html?id=${product.id}" style="text-decoration: none; color: inherit; display: block; position: relative;">
                        ${badgeHtml}
                        <img src="${photoUrl}" alt="${product.name}" class="product-image">
                        <div class="product-info">
                            <p class="product-latin">${product.latinName}</p>
                            <h3 class="product-name">${product.name}</h3>
                            <p class="product-price">${basePrice} €${lotText}</p>
                        </div>
                    </a>
                    <button class="btn-buy" onclick="${btnAction}" ${product.stock <= 0 ? 'disabled' : ''} style="${product.stock <= 0 ? 'background-color: #ccc; cursor: not-allowed;' : ''}; width: 100%;">
                        ${product.stock > 0 ? btnText : 'ÉPUISÉ'}
                    </button>
                `;
                productGrid.appendChild(card);
            });
        };

        const filterAndSort = () => {
            let filtered = [...allProducts];
            
            const selectedCat = categoryFilter?.value;
            if (selectedCat && selectedCat !== 'all') {
                filtered = filtered.filter(p => p.category === selectedCat);
            }

            const searchTerm = searchInput?.value.toLowerCase() || "";
            if (searchTerm) {
                filtered = filtered.filter(p => 
                    p.name.toLowerCase().includes(searchTerm) || 
                    p.latinName.toLowerCase().includes(searchTerm)
                );
            }

            const sortType = sortSelect?.value;
            
            // NOUVEAU : On repousse systématiquement les articles épuisés à la fin, avant d'appliquer le tri utilisateur
            filtered.sort((a, b) => {
                const aEpuise = a.stock <= 0;
                const bEpuise = b.stock <= 0;

                // Si a est épuisé et pas b, a descend à la fin
                if (aEpuise && !bEpuise) return 1;  
                // Si b est épuisé et pas a, a monte
                if (!aEpuise && bEpuise) return -1; 

                const getPriceForSort = (p) => {
                    if (p.prices && Object.keys(p.prices).length > 0) {
                        return p.prices[Object.keys(p.prices)[0]]; 
                    }
                    return p.price || p.price5 || p.price10 || p.price3 || 0;
                };

                if (sortType === 'price-asc') return getPriceForSort(a) - getPriceForSort(b);
                if (sortType === 'price-desc') return getPriceForSort(b) - getPriceForSort(a);
                if (sortType === 'name-asc') return a.name.localeCompare(b.name);
                
                // Tri par défaut (newest)
                return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0); 
            });

            renderProducts(filtered);
        };

        searchInput?.addEventListener('input', filterAndSort);
        sortSelect?.addEventListener('change', filterAndSort);
        categoryFilter?.addEventListener('change', filterAndSort);

        filterAndSort();

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

        if (docSnap.exists()) {
            const product = docSnap.data();
            const photos = product.photos && product.photos.length > 0 ? product.photos : ['assets/img/placeholder.jpg'];
            const formattedDescription = product.description.replace(/\n/g, '<br>');
            const careGuideHtml = product.careGuide ? product.careGuide.replace(/\n/g, '<br>') : 'Aucune information complémentaire.';

            let thumbnailsHtml = '';
            photos.forEach((photo, index) => {
                thumbnailsHtml += `<img src="${photo}" alt="Miniature" onclick="document.getElementById('mainProductImg').src='${photo}'">`;
            });

            // NOUVEAU : Construction dynamique du sélecteur de lots
            let lotSelectorHtml = '';
            let defaultPrice = 0;
            
            if (product.prices && Object.keys(product.prices).length > 0) {
                const sortedLots = Object.keys(product.prices).map(Number).sort((a, b) => b - a);
                defaultPrice = product.prices[sortedLots[0]];

                lotSelectorHtml = `
                    <div class="lot-selector">
                        <label style="display:block; font-size:0.85rem; margin-bottom:5px;">Quantité</label>
                        <select id="lotSelect" onchange="updateDisplayPrice()">
                            ${Object.entries(product.prices).map(([lot, price]) => `
                                <option value="${lot}" ${Number(lot) === sortedLots[0] ? 'selected' : ''}>Lot de ${lot} - ${price} €</option>
                            `).join('')}
                        </select>
                    </div>
                `;
            } else {
                // Rétrocompatibilité anciens articles
                defaultPrice = product.price10 || product.price5 || product.price3 || product.price || 0;
                lotSelectorHtml = `
                    <div class="lot-selector">
                        <label style="display:block; font-size:0.85rem; margin-bottom:5px;">Quantité</label>
                        <select id="lotSelect" onchange="updateDisplayPrice()">
                            ${product.price ? `<option value="1">À l'unité - ${product.price} €</option>` : ''}
                            ${product.price3 ? `<option value="3" ${defaultPrice === product.price3 ? 'selected' : ''}>Lot de 3 - ${product.price3} €</option>` : ''}
                            ${product.price5 ? `<option value="5" ${defaultPrice === product.price5 ? 'selected' : ''}>Lot de 5 - ${product.price5} €</option>` : ''}
                            ${product.price10 ? `<option value="10" ${defaultPrice === product.price10 ? 'selected' : ''}>Lot de 10 - ${product.price10} €</option>` : ''}
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
                        <h1 style="font-family: 'Playfair Display', serif; font-size: 2.5rem; margin: 0 0 5px 0;">${product.name}</h1>
                        <p class="product-latin" style="font-size: 1.1rem; font-style: italic; color: #777; margin-bottom: 20px;">${product.latinName}</p>
                        <p class="product-price" id="displayPrice" style="font-size: 1.8rem; font-weight: 600; margin-bottom: 20px;">${defaultPrice} €</p>
                        
                        ${lotSelectorHtml}

                        <button class="btn-buy" onclick="addSelectedToCart('${docSnap.id}')" style="width: 100%; padding: 18px; font-size: 1.1rem; margin-bottom: 10px;" ${product.stock <= 0 ? 'disabled' : ''}>
                            ${product.stock > 0 ? 'Ajouter au panier' : 'RUPTURE DE STOCK'}
                        </button>
                        <p style="text-align: center; font-size: 0.8rem; color: #666; margin-top: 0;">Stock dispo : ${product.stock}</p>
                        
                        <div class="care-guide-section">
                            <h3>Fiche Complémentaire</h3>
                            <div class="care-guide-content">${careGuideHtml}</div>
                        </div>
                    </div>
                </div>
            `;
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
    if (select) {
        const selectedOption = select.options[select.selectedIndex];
        const priceText = selectedOption.text.split(' - ')[1]; 
        document.getElementById('displayPrice').textContent = priceText;
    }
};

window.addSelectedToCart = (id) => {
    const select = document.getElementById('lotSelect');
    const lotSize = select ? parseInt(select.value) : null;
    addToCart(id, lotSize);
};

// NOUVEAU : Logique du panier mise à jour pour inclure les lots
window.addToCart = async (productId, lotSize = null) => {
    const docSnap = await getDoc(doc(db, "products", productId));
    if (!docSnap.exists()) return;
    const maxStock = docSnap.data().stock;

    let cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    
    const cartId = lotSize ? `${productId}_${lotSize}` : productId;
    const existingItem = cart.find(item => item.cartId === cartId);
    
    // NOUVEAU : On calcule le total d'insectes que l'utilisateur essaie d'ajouter
    const multiplier = lotSize || 1;
    const currentCartQty = existingItem ? existingItem.quantity : 0;
    const projectedTotalInsects = (currentCartQty + 1) * multiplier;

    if (projectedTotalInsects > maxStock) {
        alert("Stock insuffisant pour ajouter cette quantité 🌿");
        return;
    }

    if (existingItem) {
        existingItem.quantity += 1;
    } else {
        cart.push({ id: productId, cartId: cartId, lotSize: lotSize, quantity: 1 });
    }
    
    localStorage.setItem('terraophis_cart', JSON.stringify(cart));
    
    // NOUVEAU : Mise à jour de la bulle avant l'ouverture de la barre latérale
    if (typeof window.updateFloatingCart === 'function') window.updateFloatingCart();
    
    toggleCart(true); 
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

    for (let i = 0; i < cart.length; i++) {
        try {
            const docSnap = await getDoc(doc(db, "products", cart[i].id));
            if (docSnap.exists()) {
                const p = docSnap.data();
                const itemLot = cart[i].lotSize;
                
                // NOUVEAU : Récupération dynamique du prix depuis l'objet ou rétrocompatibilité
                let itemPrice = 0;
                if (p.prices && p.prices[itemLot] !== undefined) {
                    itemPrice = p.prices[itemLot];
                } else {
                    itemPrice = itemLot === 1 ? p.price : p[`price${itemLot}`] || p.price || 0;
                }

                const multiplier = itemLot || 1;
                if ((cart[i].quantity * multiplier) > p.stock) {
                    cart[i].quantity = Math.floor(p.stock / multiplier);
                    localStorage.setItem('terraophis_cart', JSON.stringify(cart));
                }
                
                if (cart[i].quantity > 0) {
                    const itemTotal = itemPrice * cart[i].quantity;
                    total += itemTotal;
                    const photo = p.photos?.length > 0 ? p.photos[0] : 'assets/img/placeholder.jpg';
                    const lotText = itemLot ? `<br><span style="font-size:0.75rem; color:#888;">Lot de ${itemLot}</span>` : '';

                    html += `
                        <div class="cart-item" style="position: relative;">
                            <img src="${photo}" alt="${p.name}">
                            <div class="cart-item-details">
                                <button onclick="removeFromCart('${cart[i].cartId}')" style="position: absolute; top: 10px; right: 10px; background: none; border: none; color: #a35d5d; font-size: 1.5rem; cursor: pointer; line-height: 1;">&times;</button>
                                <p class="cart-item-title" style="padding-right: 20px; margin-bottom: 2px;">${p.name}${lotText}</p>
                                <p class="cart-item-price">${itemPrice} €</p>
                                <div class="cart-qty-controls">
                                    <button onclick="updateCartQty('${cart[i].cartId}', -1, ${p.stock})">-</button>
                                    <span>${cart[i].quantity}</span>
                                    <button onclick="updateCartQty('${cart[i].cartId}', 1, ${p.stock})">+</button>
                                </div>
                            </div>
                        </div>
                    `;
                }
            }
        } catch (e) { console.error("Erreur panier :", e); }
    }

    container.innerHTML = html || '<p style="text-align: center; color: #888;">Panier obsolète.</p>';
    totalEl.textContent = total.toFixed(2) + ' €';
    localStorage.setItem('terraophis_cart_total', total);
};

window.updateCartQty = (cartId, change, maxStock) => {
    let cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    const itemIndex = cart.findIndex(item => item.cartId === cartId);
    
    if (itemIndex > -1) {
        const item = cart[itemIndex];
        const multiplier = item.lotSize || 1;
        const newQty = item.quantity + change;
        
        // NOUVEAU : Vérification de la nouvelle quantité selon le lot
        if (change > 0 && (newQty * multiplier) > maxStock) {
            alert("Stock maximum atteint pour ce spécimen 🌿");
            return;
        }
        
        cart[itemIndex].quantity = newQty;
        if (cart[itemIndex].quantity <= 0) cart.splice(itemIndex, 1);
        
        localStorage.setItem('terraophis_cart', JSON.stringify(cart));
        renderCart();
        
        // NOUVEAU : Synchronisation après ajustement manuel (+ / -)
        if (typeof window.updateFloatingCart === 'function') window.updateFloatingCart();
    }
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
        window.location.href = '/connexion.html';
        return;
    }

    // NOUVEAU : Déduction automatique et mathématique des stocks pour chaque article du panier
    try {
        for (const item of cart) {
            const multiplier = item.lotSize || 1;
            const totalDeduction = item.quantity * multiplier;
            
            const productRef = doc(db, "products", item.id);
            await updateDoc(productRef, {
                stock: increment(-totalDeduction)
            });
        }
    } catch (error) {
        console.error("Erreur lors de la mise à jour des stocks :", error);
        alert("Une erreur est survenue lors de la vérification des stocks.");
        return;
    }

    window.location.href = '/checkout.html';
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
                
                // NOUVEAU : Ajout de pointer-events (auto/none) pour éviter de bloquer le clic
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
                    slides[current].style.pointerEvents = 'none'; // NOUVEAU : Bloque le clic de l'ancienne
                    current = (n + slides.length) % slides.length;
                    slides[current].style.opacity = 1;
                    slides[current].style.pointerEvents = 'auto'; // NOUVEAU : Autorise le clic de la nouvelle
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
                    sliderInterval = setInterval(nextSlide, 5000);
                };
                
                sliderInterval = setInterval(nextSlide, 5000);
            }
        } else {
            heroHeader.style.display = 'none';
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

        // NOUVEAU : Chargement et construction dynamique des catégories dans le menu de la navbar
        const dropdownContent = navElement.querySelector('.dropdown-content');
        if (dropdownContent) {
            const categoriesSnap = await getDocs(collection(db, "categories"));
            let animauxHtml = '<li class="dropdown-subtitle">ANIMAUX</li>';
            let materielsHtml = '<li class="dropdown-divider"></li><li class="dropdown-subtitle">MATÉRIELS</li>';
            
            categoriesSnap.forEach(catDoc => {
                const cat = catDoc.data();
                const itemHtml = `<li><a href="boutique.html?cat=${catDoc.id}">→ ${cat.name.toUpperCase()}</a></li>`;
                if (cat.type === 'materiels') {
                    materielsHtml += itemHtml;
                } else {
                    animauxHtml += itemHtml;
                }
            });
            
            dropdownContent.innerHTML = animauxHtml + materielsHtml;
        }

        const currentPage = window.location.pathname;
        const links = navElement.querySelectorAll('.nav-links a');
        links.forEach(link => {
            if (link.getAttribute('href') === currentPage || 
               (currentPage === "/" && link.id === "nav-accueil")) {
                link.classList.add('active');
            }
        });

        const hamburgerBtn = navElement.querySelector('#hamburger-btn');
        const navLinks = navElement.querySelector('#nav-links');

        if (hamburgerBtn && navLinks) {
            hamburgerBtn.addEventListener('click', () => {
                navLinks.classList.toggle('open');
                hamburgerBtn.classList.toggle('active');
            });
        }

        const dropdowns = navElement.querySelectorAll('.dropdown');
        dropdowns.forEach(dropdown => {
            dropdown.addEventListener('click', (e) => {
                if (window.innerWidth <= 768) {
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

        // Gestion de l'envoi du formulaire de contact
        const contactForm = document.getElementById('footer-contact-form');
        if (contactForm) {
            contactForm.addEventListener('submit', (e) => {
                e.preventDefault();
                alert("Merci ! Votre message a bien été envoyé à terra.ophis@gmail.com");
                contactForm.reset();
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


// NOUVEAU : Charge la grille de tous les guides pour la page conseils.html
async function loadGuidesList() {
    const grid = document.getElementById('guidesGrid');
    if (!grid) return;
    
    grid.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Chargement des guides... 🌿</p>';
    
    try {
        const q = query(collection(db, "guides"), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        
        if (snap.empty) {
            grid.innerHTML = '<p style="text-align:center; grid-column: 1/-1; color: #888;">Aucun guide publié pour le moment.</p>';
            return;
        }
        
        grid.innerHTML = '';
        snap.forEach(docSnap => {
            const g = docSnap.data();
            
            // Astuce pour créer un extrait texte propre sans les balises HTML de l'éditeur
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = g.content;
            let excerpt = tempDiv.textContent || tempDiv.innerText || "";
            excerpt = excerpt.length > 150 ? excerpt.substring(0, 150) + "..." : excerpt;
            
            const cover = g.imageUrl || 'assets/img/placeholder.jpg';
            
            const card = document.createElement('div');
            card.className = 'guide-card';
            card.innerHTML = `
                <a href="/guide.html?id=${docSnap.id}" style="text-decoration: none; color: inherit;">
                    <img src="${cover}" alt="${g.title}" class="guide-image">
                    <div class="guide-info">
                        <h3>${g.title}</h3>
                        <p>${excerpt}</p>
                        <span class="read-more">Lire la suite →</span>
                    </div>
                </a>
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

// On lance les fonctions
loadFooter();
loadFeaturesGrid();
loadHeroSlider();
loadProductDetails();
loadCatalogue();
loadGuidesList();
loadSingleGuide(); 
loadNavbar();

// NOUVEAU : Lancement de l'initialisation du panier
initFloatingCart();
