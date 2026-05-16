import { db } from './firebase-config.js';
import { collection, query, getDocs, orderBy, doc, getDoc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let allProducts = []; // Stockage local pour filtrer sans requêter Firebase en boucle

async function loadCatalogue() {
    const productGrid = document.getElementById('productGrid');
    const searchInput = document.getElementById('shopSearch');
    const sortSelect = document.getElementById('shopSort');
    const categoryFilter = document.getElementById('categoryFilter');
    
    const urlParams = new URLSearchParams(window.location.search);
    let initialCat = urlParams.get('cat');

    if (!productGrid) return;

    // Synchronisation du select avec l'URL au chargement
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
                const card = document.createElement('div');
                card.className = 'product-card';
                card.innerHTML = `
                    <a href="/produit?id=${product.id}" style="text-decoration: none; color: inherit; display: block;">
                        <img src="${photoUrl}" alt="${product.name}" class="product-image">
                        <div class="product-info">
                            <p class="product-latin">${product.latinName}</p>
                            <h3 class="product-name">${product.name}</h3>
                            <p class="product-price">${product.price} €</p>
                        </div>
                    </a>
                    <button class="btn-buy" onclick="addToCart('${product.id}')" ${product.stock <= 0 ? 'disabled' : ''} style="${product.stock <= 0 ? 'background-color: #ccc; cursor: not-allowed;' : ''}">
                        ${product.stock > 0 ? 'AJOUTER AU PANIER' : 'ÉPUISÉ'}
                    </button>
                `;
                productGrid.appendChild(card);
            });
        };

        const filterAndSort = () => {
            let filtered = [...allProducts];
            
            // 1. Filtrage par Catégorie (priorité au select)
            const selectedCat = categoryFilter?.value;
            if (selectedCat && selectedCat !== 'all') {
                filtered = filtered.filter(p => p.category === selectedCat);
            }

            // 2. Recherche par texte
            const searchTerm = searchInput?.value.toLowerCase() || "";
            if (searchTerm) {
                filtered = filtered.filter(p => 
                    p.name.toLowerCase().includes(searchTerm) || 
                    p.latinName.toLowerCase().includes(searchTerm)
                );
            }

            // 3. Tri
            const sortType = sortSelect?.value;
            if (sortType === 'price-asc') filtered.sort((a, b) => a.price - b.price);
            else if (sortType === 'price-desc') filtered.sort((a, b) => b.price - a.price);
            else if (sortType === 'name-asc') filtered.sort((a, b) => a.name.localeCompare(b.name));
            else if (sortType === 'newest') filtered.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

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

window.addToCart = async (productId) => {
    // NOUVEAU : On vérifie le stock réel en direct sur Firestore
    const docSnap = await getDoc(doc(db, "products", productId));
    if (!docSnap.exists()) return;
    const maxStock = docSnap.data().stock;

    let cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    const existingItem = cart.find(item => item.id === productId);
    
    if (existingItem) {
        // NOUVEAU : Blocage de l'ajout si le stock maximum est atteint
        if (existingItem.quantity >= maxStock) {
            alert("Stock maximum atteint pour ce spécimen 🌿");
            return;
        }
        existingItem.quantity += 1;
    } else {
        if (maxStock < 1) return; // Sécurité anti-rupture
        cart.push({ id: productId, quantity: 1 });
    }
    
    localStorage.setItem('terraophis_cart', JSON.stringify(cart));
    toggleCart(true); 
};

window.renderCart = async () => {
    const container = document.getElementById('cartItemsContainer');
    const totalEl = document.getElementById('cartTotalAmount');
    const btnCheckout = document.getElementById('btnCheckout');
    let cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];

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
                
                // NOUVEAU : Ajustement automatique si le stock a baissé sur le site
                if (cart[i].quantity > p.stock) {
                    cart[i].quantity = p.stock;
                    localStorage.setItem('terraophis_cart', JSON.stringify(cart));
                }
                
                if (cart[i].quantity > 0) {
                    const itemTotal = p.price * cart[i].quantity;
                    total += itemTotal;
                    const photo = p.photos?.length > 0 ? p.photos[0] : 'assets/img/placeholder.jpg';

                    // NOUVEAU : Ajout de la croix de suppression et de maxStock pour le bouton +
                    html += `
                        <div class="cart-item" style="position: relative;">
                            <img src="${photo}" alt="${p.name}">
                            <div class="cart-item-details">
                                <button onclick="removeFromCart('${cart[i].id}')" style="position: absolute; top: 10px; right: 10px; background: none; border: none; color: #a35d5d; font-size: 1.5rem; cursor: pointer; line-height: 1;">&times;</button>
                                <p class="cart-item-title" style="padding-right: 20px;">${p.name}</p>
                                <p class="cart-item-price">${p.price} €</p>
                                <div class="cart-qty-controls">
                                    <button onclick="updateCartQty('${cart[i].id}', -1, ${p.stock})">-</button>
                                    <span>${cart[i].quantity}</span>
                                    <button onclick="updateCartQty('${cart[i].id}', 1, ${p.stock})">+</button>
                                </div>
                            </div>
                        </div>
                    `;
                }
            }
        } catch (e) {
            console.error("Erreur panier :", e);
        }
    }

    container.innerHTML = html || '<p style="text-align: center; margin-top: 50px; color: #888;">Les articles de votre panier ne sont plus en stock.</p>';
    totalEl.textContent = total.toFixed(2) + ' €';
    localStorage.setItem('terraophis_cart_total', total);
};

// NOUVEAU : Transmission du maxStock pour bloquer l'incrémentation dans le panier
window.updateCartQty = (productId, change, maxStock) => {
    let cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    const itemIndex = cart.findIndex(item => item.id === productId);
    
    if (itemIndex > -1) {
        const newQty = cart[itemIndex].quantity + change;
        
        // NOUVEAU : Alerte si on essaye d'augmenter au-delà du dispo
        if (change > 0 && newQty > maxStock) {
            alert("Stock maximum atteint pour ce spécimen 🌿");
            return;
        }
        
        cart[itemIndex].quantity = newQty;
        if (cart[itemIndex].quantity <= 0) {
            cart.splice(itemIndex, 1);
        }
        localStorage.setItem('terraophis_cart', JSON.stringify(cart));
        renderCart();
    }
};

// NOUVEAU : Fonction de suppression totale de l'article
window.removeFromCart = (productId) => {
    let cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    cart = cart.filter(item => item.id !== productId);
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
    const btn = document.getElementById('btnCheckout');
    const cart = JSON.parse(localStorage.getItem('terraophis_cart')) || [];
    const totalValue = parseFloat(localStorage.getItem('terraophis_cart_total') || 0);

    if (cart.length === 0 || totalValue <= 0) return;

    try {
        btn.disabled = true;
        btn.textContent = 'PRÉPARATION... ⏳';

        // 1. Création de la commande "En attente" dans Firestore
        const orderRef = await addDoc(collection(db, "orders"), {
            items: cart,
            amountValue: totalValue,
            status: 'En attente de paiement',
            createdAt: serverTimestamp()
        });

        // 2. Appel au serveur pour générer la session Stripe
        const response = await fetch('/api/create-checkout-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: orderRef.id })
        });

        const data = await response.json();

        if (data.url) {
            // Redirection vers la page de paiement sécurisée Stripe
            window.location.href = data.url;
        } else {
            throw new Error(data.error || "Erreur de connexion à Stripe");
        }

    } catch (error) {
        console.error("Erreur Checkout :", error);
        alert("Une erreur est survenue lors de la création de la commande.");
        btn.disabled = false;
        btn.textContent = 'VALIDER LA COMMANDE';
    }
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

// NOUVEAU : Fonction pour charger les détails d'un produit spécifique sur produit.html
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
            
            // NOUVEAU : Récupération de toutes les photos (ou placeholder par défaut)
            const photos = product.photos && product.photos.length > 0 ? product.photos : ['assets/img/placeholder.jpg'];
            const formattedDescription = product.description.replace(/\n/g, '<br>');

            // NOUVEAU : Construction dynamique du HTML du carrousel avec gestion des flèches si besoin
            let sliderHtml = `<div class="product-slider-container" style="position: relative; overflow: hidden; border-radius: 12px; width: 100%; aspect-ratio: 1/1;">`;
            
            photos.forEach((photo, index) => {
                sliderHtml += `<img src="${photo}" alt="${product.name} - Photo ${index + 1}" class="product-slide" style="width: 100%; height: 100%; object-fit: cover; position: absolute; top: 0; left: 0; opacity: ${index === 0 ? 1 : 0}; transition: opacity 0.8s ease-in-out;">`;
            });

            if (photos.length > 1) {
                sliderHtml += `
                    <button class="slider-arrow prev" style="position: absolute; top: 50%; left: 10px; transform: translateY(-50%); background: rgba(255,255,255,0.7); border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; font-size: 1.5rem; display: flex; align-items: center; justify-content: center; color: var(--accent-brown); z-index: 10;">‹</button>
                    <button class="slider-arrow next" style="position: absolute; top: 50%; right: 10px; transform: translateY(-50%); background: rgba(255,255,255,0.7); border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; font-size: 1.5rem; display: flex; align-items: center; justify-content: center; color: var(--accent-brown); z-index: 10;">›</button>
                `;
            }
            sliderHtml += `</div>`;

            detailsContainer.innerHTML = `
                <div class="product-gallery">
                    ${sliderHtml}
                </div>
                
                <div class="product-info-full">
                    <p class="product-latin" style="font-size: 1.2rem;">${product.latinName}</p>
                    <h1 style="font-family: 'Playfair Display', serif; font-size: 2.5rem; margin-top: 5px;">${product.name}</h1>
                    <p class="product-price" style="font-size: 1.5rem;">${product.price} €</p>
                    
                    <div style="margin: 20px 0; padding: 15px; background: #fff; border-radius: 8px; border: 1px solid var(--border-light);">
                        <strong>Difficulté :</strong> <span style="text-transform: capitalize;">${product.difficulty}</span>
                    </div>

                    <div style="margin-bottom: 30px; line-height: 1.6;">
                        ${formattedDescription}
                    </div>

                    <button class="btn-buy" onclick="addToCart('${docSnap.id}')" style="width: 100%; padding: 20px; font-size: 1.2rem;" ${product.stock <= 0 ? 'disabled' : ''}>
                        ${product.stock > 0 ? 'AJOUTER AU PANIER' : 'RUPTURE DE STOCK'}
                    </button>
                    
                    <p style="text-align: center; font-size: 0.8rem; margin-top: 10px; color: #666;">
                        En stock : ${product.stock}
                    </p>
                </div>
            `;

            // NOUVEAU : Logique de défilement (manuel et automatique) pour la galerie
            if (photos.length > 1) {
                let currentSlide = 0;
                const slides = detailsContainer.querySelectorAll('.product-slide');
                const btnPrev = detailsContainer.querySelector('.slider-arrow.prev');
                const btnNext = detailsContainer.querySelector('.slider-arrow.next');
                let slideInterval;

                const goToSlide = (n) => {
                    slides[currentSlide].style.opacity = 0;
                    currentSlide = (n + slides.length) % slides.length;
                    slides[currentSlide].style.opacity = 1;
                };

                const nextSlide = () => goToSlide(currentSlide + 1);
                const prevSlide = () => goToSlide(currentSlide - 1);

                btnNext.addEventListener('click', () => { nextSlide(); resetInterval(); });
                btnPrev.addEventListener('click', () => { prevSlide(); resetInterval(); });

                // Défilement automatique toutes les 5 secondes
                const startInterval = () => {
                    slideInterval = setInterval(nextSlide, 5000); 
                };

                // Réinitialise le chrono si l'utilisateur clique sur une flèche
                const resetInterval = () => {
                    clearInterval(slideInterval);
                    startInterval();
                };

                startInterval();
            }

        } else {
            detailsContainer.innerHTML = '<p>Ce produit n\'existe plus.</p>';
        }
    } catch (error) {
        console.error("Erreur détails produit :", error);
        detailsContainer.innerHTML = '<p>Erreur lors du chargement.</p>';
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

        dropdowns.forEach(dropdown => {
            dropdown.addEventListener('click', (e) => {
                // Sur mobile, cliquer sur "BOUTIQUE" ouvre le sous-menu au lieu de rediriger direct
                if (window.innerWidth <= 768) {
                    dropdown.classList.toggle('active-mobile');
                }
            });
        });

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