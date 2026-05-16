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
                
                if (product.price) {
                    basePrice = product.price;
                } else if (product.price5) {
                    basePrice = product.price5;
                    lotText = ' <span style="font-size: 0.8rem; color: #888; font-weight: normal;">(les 5)</span>';
                } else if (product.price10) {
                    basePrice = product.price10;
                    lotText = ' <span style="font-size: 0.8rem; color: #888; font-weight: normal;">(les 10)</span>';
                }
                
                const hasLots = product.price5 || product.price10;
                const btnAction = hasLots ? `window.location.href='/produit.html?id=${product.id}'` : `addToCart('${product.id}')`;
                const btnText = hasLots ? 'VOIR LES OPTIONS' : 'AJOUTER AU PANIER';

                // NOUVEAU : Génération du badge "Bientôt épuisé" si le stock est entre 1 et 10
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

                // Si les deux sont dispos (ou les deux épuisés), on applique le tri normal choisi par le client
                if (sortType === 'price-asc') return (a.price || a.price5 || a.price10) - (b.price || b.price5 || b.price10);
                if (sortType === 'price-desc') return (b.price || b.price5 || b.price10) - (a.price || a.price5 || a.price10);
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

            // NOUVEAU : Construction de la liste des miniatures cliquables
            let thumbnailsHtml = '';
            photos.forEach((photo, index) => {
                thumbnailsHtml += `<img src="${photo}" alt="Miniature" onclick="document.getElementById('mainProductImg').src='${photo}'">`;
            });

            // NOUVEAU : Sélecteur dynamique de Lots
            let basePrice = product.price || product.price5 || 0;
            let lotSelectorHtml = '';
            
            if (product.price5 || product.price10) {
                lotSelectorHtml = `
                    <div class="lot-selector">
                        <label style="display:block; font-size:0.85rem; margin-bottom:5px;">Quantité</label>
                        <select id="lotSelect" onchange="updateDisplayPrice(this.value, ${product.price5 || 0}, ${product.price10 || 0})">
                            ${product.price5 ? `<option value="5">Lot de 5 - ${product.price5} €</option>` : ''}
                            ${product.price10 ? `<option value="10">Lot de 10 - ${product.price10} €</option>` : ''}
                        </select>
                    </div>
                `;
            }

            // NOUVEAU : Grille structurée (Image/Desc à gauche, Achat/Fiche à droite)
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
                        <p class="product-price" id="displayPrice" style="font-size: 1.8rem; font-weight: 600; margin-bottom: 20px;">${basePrice} €</p>
                        
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
window.updateDisplayPrice = (val, p5, p10) => {
    const p = val == 10 ? p10 : p5;
    document.getElementById('displayPrice').textContent = p + ' €';
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
    toggleCart(true); 
};

window.renderCart = async () => {
    const container = document.getElementById('cartItemsContainer');
    const totalEl = document.getElementById('cartTotalAmount');
    const btnCheckout = document.getElementById('btnCheckout');
    
    // On récupère le panier brut
    let rawCart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];

    // NOUVEAU : Sécurité pour nettoyer les anciens articles qui n'ont pas de cartId
    let cart = rawCart.filter(item => item.cartId !== undefined && item.cartId !== null);
    
    // Si on a supprimé des articles obsolètes, on met à jour la sauvegarde
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
                let itemPrice = p.price;
                if (itemLot === 5) itemPrice = p.price5;
                if (itemLot === 10) itemPrice = p.price10;

                // NOUVEAU : Réajustement automatique du panier si le stock a baissé entre temps, en prenant en compte les lots
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
    }
};

window.removeFromCart = (cartId) => {
    let cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    cart = cart.filter(item => item.cartId !== cartId);
    localStorage.setItem('terraophis_cart', JSON.stringify(cart));
    renderCart();
};

// NOUVEAU: Gestion complète du panier
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

        // NOUVEAU : On applique l'état de session dès que la navbar est injectée dans la page
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

// On lance les fonctions
loadFooter();
loadFeaturesGrid();
loadHeroSlider();
loadProductDetails();
loadCatalogue();
loadNavbar();