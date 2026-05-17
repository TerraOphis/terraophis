import { db, auth } from '../firebase-config.js';
import { collection, addDoc, getDocs, deleteDoc, doc, updateDoc, getDoc, setDoc, serverTimestamp, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const productForm = document.getElementById('productForm');
const statusMsg = document.getElementById('uploadStatus');

// --- SÉCURITÉ & AUTHENTIFICATION ---

// --- SÉCURITÉ & AUTHENTIFICATION ---

onAuthStateChanged(auth, (user) => {
    if (user) {
        // L'utilisateur est connecté, on vérifie si c'est l'un des bons emails
        if (user.email === "martin.stuis11@gmail.com" || user.email === "terra.ophis@gmail.com") {
            console.log("Accès Admin accordé :", user.email);
            
            // NOUVEAU : On lève le rideau de fer uniquement si l'accès est validé
            document.getElementById('adminLoader').style.display = 'none';
            document.getElementById('adminNav').style.display = 'flex';
            document.getElementById('adminMain').style.display = 'block';

            loadAdminCategories();
            loadInventory(); 
            loadOrders();
            loadSliderPreview();
            loadGridPreviews();
            loadGuides();
            loadAdminWeather();
        } else {
            console.warn("Accès refusé pour :", user.email);
            // NOUVEAU : replace() au lieu de href pour bloquer le bouton Retour + redirection propre
            window.location.replace("/connexion.html");
        }
    } else {
        setTimeout(() => {
            if (!auth.currentUser) {
                // NOUVEAU : replace() au lieu de href pour bloquer le bouton Retour + redirection propre
                window.location.replace("/connexion.html");
            }
        }, 1000); 
    }
});

// 2. Création de produit
productForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnSubmit');
    const formData = new FormData(productForm);
    const files = document.getElementById('productFiles').files;

    try {
        btn.disabled = true;
        statusMsg.textContent = files.length > 0 ? "Téléchargement des images vers R2... ⏳" : "Enregistrement en cours...";

        let photoUrls = [];

        if (files.length > 0) {
            const uploadData = new FormData();
            for (let i = 0; i < files.length; i++) { uploadData.append('photos', files[i]); }
            
            const token = await auth.currentUser.getIdToken();
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: uploadData
            });

            if (!response.ok) throw new Error("Échec de l'upload");
            const { files: uploadedFiles } = await response.json();
            photoUrls = uploadedFiles.map(f => f.url);
        }

        if (photoUrls.length === 0) throw new Error("Les photos sont obligatoires pour un nouveau produit.");

        const careGuideHtml = document.getElementById('productCareGuideEditor').innerHTML;

        // NOUVEAU : Capture des inputs de prix générés dynamiquement
        const prices = {};
        document.querySelectorAll('#dynamicPricesContainer .lot-price-input').forEach(input => {
            prices[input.dataset.lot] = parseFloat(input.value) || 0;
        });

        const productData = {
            name: formData.get('name'),
            latinName: formData.get('latinName'),
            stock: parseInt(formData.get('stock')),
            category: formData.get('category'),
            difficulty: formData.get('difficulty'),
            description: formData.get('description'),
            careGuide: careGuideHtml,
            prices: prices, // Enregistrement de la map complète
            photos: photoUrls,
            createdAt: serverTimestamp()
        };

        await addDoc(collection(db, "products"), productData);
        statusMsg.textContent = "✅ Produit ajouté avec succès !";

        productForm.reset();
        document.getElementById('productCareGuideEditor').innerHTML = ''; 
        loadInventory();
    } catch (err) {
        console.error(err);
        statusMsg.textContent = "❌ Erreur : " + err.message;
    } finally {
        btn.disabled = false;
    }
});

window.editProduct = async (id) => {
    try {
        const docRef = doc(db, "products", id);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            const p = docSnap.data();
            
            // Assignation sécurisée des valeurs textuelles et sélecteurs
            if (document.getElementById('editProductId')) document.getElementById('editProductId').value = id;
            if (document.getElementById('editName')) document.getElementById('editName').value = p.name || '';
            if (document.getElementById('editLatinName')) document.getElementById('editLatinName').value = p.latinName || '';
            if (document.getElementById('editStock')) document.getElementById('editStock').value = p.stock || '';
            if (document.getElementById('editCategory')) document.getElementById('editCategory').value = p.category || '';
            if (document.getElementById('editDifficulty')) document.getElementById('editDifficulty').value = p.difficulty || '';
            if (document.getElementById('editDescription')) document.getElementById('editDescription').value = p.description || '';
            if (document.getElementById('editCareGuideEditor')) document.getElementById('editCareGuideEditor').innerHTML = p.careGuide || '';
            
            // Génération des inputs de lots spécifiques à la catégorie du produit chargé
            await generatePriceInputs('editDynamicPricesContainer', p.category, p.prices || {
                "1": p.price, "3": p.price3, "5": p.price5, "10": p.price10
            });
            
            renderEditPhotos(p.photos || [], id);
            document.getElementById('editProductModal').style.display = 'flex';
        }
    } catch (error) {
        console.error("Erreur de chargement :", error);
        alert("Impossible de charger le produit.");
    }
};

window.closeEditModal = () => {
    document.getElementById('editProductModal').style.display = 'none';
    document.getElementById('editProductForm').reset();
    // Nouveau : Remise à zéro propre de l'éditeur de texte enrichi
    document.getElementById('editCareGuideEditor').innerHTML = ''; 
    document.getElementById('editUploadStatus').textContent = '';
};

// NOUVEAU : Gère l'affichage dynamique des photos existantes avec visibilité masquée aux extrémités
function renderEditPhotos(photos, productId) {
    const container = document.getElementById('editPhotosPreview');
    container.innerHTML = '';
    
    if (photos.length === 0) {
        container.innerHTML = '<p style="font-size:0.85rem; color:#888;">Aucune photo actuellement.</p>';
        return;
    }

    photos.forEach((url, index) => {
        // On détermine la position de la photo
        const isFirst = index === 0;
        const isLast = index === photos.length - 1;
        
        const div = document.createElement('div');
        div.className = 'edit-photo-item';
        div.style.cssText = 'height: auto; display: flex; flex-direction: column; gap: 8px;';
        
        div.innerHTML = `
            <div style="position: relative; width: 100px; height: 100px;">
                <img src="${url}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px; border: 2px solid white;">
                <button type="button" onclick="deleteProductPhoto('${productId}', ${index}, '${url}')" title="Supprimer cette photo" style="position: absolute; top: -8px; right: -8px; background: #a35d5d; color: white; border: none; border-radius: 50%; width: 24px; height: 24px; font-size: 12px; cursor: pointer; box-shadow: 0 2px 4px rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center;">×</button>
            </div>
            <div style="display: flex; justify-content: space-between; width: 100px;">
                <button type="button" onclick="moveProductPhoto('${productId}', ${index}, -1)" style="padding: 2px 8px; border: none; background: #e0ddd5; border-radius: 4px; color: var(--accent-brown); cursor: pointer; font-weight: bold; visibility: ${isFirst ? 'hidden' : 'visible'};" title="Déplacer à gauche">←</button>
                
                <button type="button" onclick="moveProductPhoto('${productId}', ${index}, 1)" style="padding: 2px 8px; border: none; background: #e0ddd5; border-radius: 4px; color: var(--accent-brown); cursor: pointer; font-weight: bold; visibility: ${isLast ? 'hidden' : 'visible'};" title="Déplacer à droite">→</button>
            </div>
        `;
        container.appendChild(div);
    });
}

// Gère la suppression individuelle d'une photo depuis R2 et Firestore
window.deleteProductPhoto = async (productId, photoIndex, photoUrl) => {
    if (!confirm("Voulez-vous vraiment supprimer cette photo ?")) return;

    try {
        const key = new URL(photoUrl).pathname.substring(1);
        const token = await auth.currentUser.getIdToken();
        
        // Suppression depuis le stockage R2
        await fetch('/api/delete', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ keys: [key] })
        });

        // Mise à jour de Firestore
        const docRef = doc(db, "products", productId);
        const docSnap = await getDoc(docRef);
        const photos = docSnap.data().photos || [];
        
        photos.splice(photoIndex, 1);
        await updateDoc(docRef, { photos: photos });
        
        // Rafraîchissement visuel
        renderEditPhotos(photos, productId);
        
    } catch (error) {
        console.error("Erreur lors de la suppression de l'image :", error);
        alert("Erreur lors de la suppression de l'image.");
    }
};

// NOUVEAU : Gère le déplacement (réorganisation) d'une photo et sauvegarde en base
window.moveProductPhoto = async (productId, index, direction) => {
    try {
        const docRef = doc(db, "products", productId);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            let photos = docSnap.data().photos || [];
            const newIndex = index + direction;
            
            // Vérification de sécurité pour ne pas sortir du tableau
            if (newIndex >= 0 && newIndex < photos.length) {
                // On échange la place des deux éléments
                [photos[index], photos[newIndex]] = [photos[newIndex], photos[index]];
                
                // Sauvegarde immédiate dans Firestore
                await updateDoc(docRef, { photos: photos });
                
                // On rafraîchit l'affichage
                renderEditPhotos(photos, productId);
            }
        }
    } catch (error) {
        console.error("Erreur lors de la réorganisation :", error);
        alert("Erreur lors de la réorganisation des photos.");
    }
};

// Soumission du formulaire de modification
document.getElementById('editProductForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnSubmitEdit');
    const statusText = document.getElementById('editUploadStatus');
    const formData = new FormData(e.target);
    const files = document.getElementById('editProductFiles').files;
    const productId = document.getElementById('editProductId').value;

    try {
        btn.disabled = true;
        statusText.textContent = files.length > 0 ? "Upload des nouvelles images... ⏳" : "Mise à jour en cours...";

        let newUrls = [];

        if (files.length > 0) {
            const uploadData = new FormData();
            for (let i = 0; i < files.length; i++) { uploadData.append('photos', files[i]); }
            
            const token = await auth.currentUser.getIdToken();
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: uploadData
            });

            if (!response.ok) throw new Error("Échec de l'upload");
            const { files: uploadedFiles } = await response.json();
            newUrls = uploadedFiles.map(f => f.url);
        }

        const docRef = doc(db, "products", productId);
        const docSnap = await getDoc(docRef);
        const currentPhotos = docSnap.exists() ? (docSnap.data().photos || []) : [];
        
        const finalPhotos = [...currentPhotos, ...newUrls];

        // Nouveau : Capture du code HTML enrichi pour l'envoyer vers Firestore
        const careGuideHtml = document.getElementById('editCareGuideEditor').innerHTML;

        const prices = {};
                document.querySelectorAll('#editDynamicPricesContainer .lot-price-input').forEach(input => {
                    prices[input.dataset.lot] = parseFloat(input.value) || 0;
                });

                await updateDoc(docRef, {
                    name: formData.get('name'),
                    latinName: formData.get('latinName'),
                    stock: parseInt(formData.get('stock')),
                    category: formData.get('category'),
                    difficulty: formData.get('difficulty'),
                    description: formData.get('description'),
                    careGuide: careGuideHtml,
                    prices: prices, 
                    photos: finalPhotos
                });

        statusText.textContent = "✅ Produit mis à jour !";
        loadInventory();
        setTimeout(() => closeEditModal(), 1500);

    } catch (err) {
        console.error(err);
        statusText.textContent = "❌ Erreur : " + err.message;
    } finally {
        btn.disabled = false;
    }
});

// 3. Charger l'inventaire pour pouvoir supprimer/gérer
async function loadInventory() {
    const container = document.getElementById('adminInventory');
    container.innerHTML = '<p>Chargement des stocks...</p>';
    
    const q = query(collection(db, "products"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    
    container.innerHTML = '';
    snap.forEach(productDoc => {
        const p = productDoc.data();
        const div = document.createElement('div');
        div.className = 'inventory-item';
        
        let stockClass = "stock-out";
        let stockText = "Rupture";
        if (p.stock > 10) {
            stockClass = "stock-high";
            stockText = `${p.stock} en stock`;
        } else if (p.stock > 0) {
            stockClass = "stock-low";
            stockText = `Reste ${p.stock}`;
        }
        
        // Nouveau : Logique d'affichage dynamique des prix (si pas de prix unitaire, affiche les lots)
        let priceContent = '';
        if (p.prices && Object.keys(p.prices).length > 0) {
            priceContent = Object.entries(p.prices).map(([lot, pr]) => `<span>Lot x${lot}: ${pr} €</span>`).join('<br>');
        } else {
            let lots = [];
            if (p.price) lots.push(`Unité: ${p.price} €`);
            if (p.price3) lots.push(`Lot x3: ${p.price3} €`);
            if (p.price5) lots.push(`Lot x5: ${p.price5} €`);
            if (p.price10) lots.push(`Lot x10: ${p.price10} €`);
            priceContent = lots.length > 0 ? lots.join('<br>') : '<strong>-</strong>';
        }

        // Nouveau : Extraction de la première photo pour l'aperçu miniature
        const firstPhoto = p.photos && p.photos.length > 0 ? p.photos[0] : '../assets/img/placeholder.jpg';
        
        div.innerHTML = `
            <img src="${firstPhoto}" style="width:50px; height:50px; object-fit:cover; border-radius:6px; border:1px solid var(--border-color);">
            <div style="display:flex; flex-direction:column; gap:5px;">
                <span style="font-weight:600; font-size:1.1rem;">${p.name}</span>
                <span style="font-size:0.85rem; color:#888; text-transform:capitalize;">${p.category} | ${p.latinName || 'N/A'}</span>
            </div>
            <div>
                ${priceContent}
            </div>
            <div>
                <span class="stock-badge ${stockClass}">${stockText}</span>
            </div>
            <div style="display:flex; gap:10px; justify-content:flex-end;">
                <button onclick="editProduct('${productDoc.id}')" class="btn-outline">Gérer</button>
                <button onclick="deleteProduct('${productDoc.id}')" class="btn-logout" style="border:none;">Supprimer</button>
            </div>
        `;
        container.appendChild(div);
    });
}

window.deleteProduct = async (id) => {
    if(confirm("Êtes-vous sûr de vouloir supprimer définitivement cet insecte et ses photos ?")) {
        try {
            // NOUVEAU : Récupération du document pour cibler les photos à supprimer
            const docRef = doc(db, "products", id);
            const docSnap = await getDoc(docRef);
            
            if (docSnap.exists()) {
                const product = docSnap.data();
                
                // NOUVEAU : Extraction des clés R2 et appel de l'API de suppression
                if (product.photos && product.photos.length > 0) {
                    const keys = product.photos.map(url => {
                        return new URL(url).pathname.substring(1); 
                    });
                    
                    const token = await auth.currentUser.getIdToken();
                    await fetch('/api/delete', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}` 
                        },
                        body: JSON.stringify({ keys })
                    });
                }
            }
            
            // NOUVEAU : Suppression finale du document Firestore
            await deleteDoc(docRef);
            loadInventory();
            
        } catch (error) {
            console.error("Erreur lors de la suppression :", error);
            alert("Une erreur est survenue lors de la suppression du produit.");
        }
    }
};

// NOUVEAU : Fonction pour récupérer et afficher les commandes
async function loadOrders() {
    const container = document.getElementById('adminOrders');
    if (!container) return;
    container.innerHTML = '<p>Chargement des commandes...</p>';
    
    try {
        const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        
        container.innerHTML = '';
        
        if (snap.empty) {
            container.innerHTML = '<p>Aucune commande pour le moment.</p>';
            return;
        }

        // NOUVEAU : Boucle asynchrone pour traiter et afficher chaque commande de façon détaillée
        for (const orderDoc of snap.docs) {
            const order = orderDoc.data();
            const orderId = orderDoc.id;
            const dateObj = order.createdAt?.toDate() ? order.createdAt.toDate().toLocaleDateString('fr-FR', {hour: '2-digit', minute:'2-digit'}) : 'Date inconnue';

            // Récupération des noms des produits du panier
            let itemsHtml = '';
            if (order.items && order.items.length > 0) {
                for (const item of order.items) {
                    const prodSnap = await getDoc(doc(db, "products", item.id));
                    const prodName = prodSnap.exists() ? prodSnap.data().name : "Spécimen supprimé";
                    // NOUVEAU : Affichage du Lot sélectionné dans le pannel admin
                    const lotText = item.lotSize ? ` (Lot de ${item.lotSize})` : '';
                    itemsHtml += `<li><strong>x${item.quantity}</strong> - ${prodName}${lotText}</li>`;
                }
            }

            // Formatage de l'adresse de livraison si elle existe
            let addressHtml = '<em>Pas d\'adresse (Paiement incomplet ou service)</em>';
            if (order.shippingAddress) {
                const addr = order.shippingAddress;
                addressHtml = `
                    ${order.customerName}<br>
                    ${addr.line1} ${addr.line2 ? '<br>' + addr.line2 : ''}<br>
                    ${addr.postalCode} ${addr.city}, ${addr.country}
                `;
            }

            const div = document.createElement('div');
            div.className = 'order-card'; // Changement de classe pour appliquer un style de carte isolée
            
            div.innerHTML = `
                <div class="order-card-header">
                    <div>
                        <span class="order-id">CMD #${orderId.slice(0,6).toUpperCase()}</span>
                        <span class="order-date">${dateObj}</span>
                    </div>
                    <select onchange="updateOrderStatus('${orderId}', this.value)" class="status-select">
                        <option value="En attente de paiement" ${order.status === 'En attente de paiement' ? 'selected' : ''}>En attente</option>
                        <option value="Payé" ${order.status === 'Payé' ? 'selected' : ''}>Payé (À préparer)</option>
                        <option value="En préparation" ${order.status === 'En preparation' ? 'selected' : ''}>En préparation</option>
                        <option value="Expédié" ${order.status === 'Expédié' ? 'selected' : ''}>Expédié</option>
                    </select>
                </div>
                <div class="order-card-body">
                    <div class="order-col">
                        <h4>Contenu du colis :</h4>
                        <ul>${itemsHtml}</ul>
                        <p class="order-price-total">Montant total : <strong>${order.amountValue || 0} €</strong></p>
                    </div>
                    <div class="order-col">
                        <h4>Adresse de livraison :</h4>
                        <p class="order-address-text">${addressHtml}</p>
                        <p class="order-contact-email">✉️ ${order.customerEmail || 'Anonyme'}</p>
                    </div>
                </div>
            `;
            container.appendChild(div);
        }
    } catch (error) {
        console.error("Erreur de chargement du tableau des commandes :", error);
        container.innerHTML = '<p>Erreur lors du chargement des informations.</p>';
    }
}

// NOUVEAU : Fonction pour mettre à jour le statut en base de données
window.updateOrderStatus = async (id, newStatus) => {
    try {
        await updateDoc(doc(db, "orders", id), { status: newStatus });
        // Optionnel : Tu pourras ajouter ici l'envoi d'un email automatique au client pour le prévenir de l'expédition
    } catch (error) {
        console.error("Erreur mise à jour statut :", error);
        alert("Erreur lors de la mise à jour du statut.");
    }
};

document.getElementById('btnLogout').addEventListener('click', () => signOut(auth));

// NOUVEAU: Gestion du système d'onglets
window.switchTab = (tabId, btnElement) => {
    // Masquer tous les contenus
    document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
    // Réinitialiser le style des boutons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.style.background = 'transparent';
        btn.style.color = 'var(--accent-brown)';
    });
    
    // Afficher le bon onglet et styliser le bouton actif
    document.getElementById(tabId).style.display = 'block';
    btnElement.style.background = 'var(--accent-brown)';
    btnElement.style.color = 'white';
};

// NOUVEAU: Upload et sauvegarde des images du Hero Slider
const sliderForm = document.getElementById('sliderForm');
const sliderStatusMsg = document.getElementById('sliderUploadStatus');

if(sliderForm) {
    sliderForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnSubmitSlider');
    const files = document.getElementById('sliderFiles').files;
    if (files.length === 0) return;
    
    try {
        btn.disabled = true;
        sliderStatusMsg.textContent = "Ajout des images... ⏳";
        
        const uploadData = new FormData();
        for (let i = 0; i < files.length; i++) { uploadData.append('photos', files[i]); }
        
        const token = await auth.currentUser.getIdToken();
        const response = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: uploadData
        });

        if (!response.ok) throw new Error("Échec de l'upload");
        const { files: uploadedFiles } = await response.json();
        const newUrls = uploadedFiles.map(f => f.url);

        // RÉCUPÉRATION ET FUSION
        const docRef = doc(db, "settings", "heroSlider");
        const docSnap = await getDoc(docRef);
        let finalPhotos = newUrls;

        if (docSnap.exists() && docSnap.data().photos) {
            // On concatène les nouvelles photos aux anciennes au lieu de les remplacer
            const existingPhotos = docSnap.data().photos;
            finalPhotos = [...existingPhotos, ...newUrls];
        }

        await setDoc(docRef, {
            photos: finalPhotos,
            updatedAt: serverTimestamp()
        });

        sliderStatusMsg.textContent = "✅ Images ajoutées avec succès !";
        sliderForm.reset();
        loadSliderPreview(); // On rafraîchit l'aperçu immédiatement
    } catch (err) {
        console.error("Erreur Slider :", err);
        sliderStatusMsg.textContent = "❌ Erreur : " + err.message;
    } finally {
        btn.disabled = false;
    }
});
}

const guideForm = document.getElementById('guideForm');
const guideStatusMsg = document.getElementById('guideUploadStatus');

// Logique de création pour les fiches conseils
guideForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnSubmitGuide');
    const formData = new FormData(guideForm);
    const fileInput = document.getElementById('guideFile');
    
    try {
        btn.disabled = true;
        guideStatusMsg.textContent = "Enregistrement de la fiche... ⏳";
        let imageUrl = null;

        if (fileInput.files.length > 0) {
            guideStatusMsg.textContent = "Téléchargement de l'image de couverture... ⏳";
            const uploadData = new FormData();
            uploadData.append('photos', fileInput.files[0]); 
            
            const token = await auth.currentUser.getIdToken();
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: uploadData
            });

            if (!response.ok) throw new Error("Échec de l'upload de l'image");
            
            const { files: uploadedFiles } = await response.json();
            if (uploadedFiles && uploadedFiles.length > 0) {
                imageUrl = uploadedFiles[0].url;
            }
        }

        guideStatusMsg.textContent = "Création de la fiche...";
        const guideContentHtml = document.getElementById('guideCareEditor').innerHTML;

        await addDoc(collection(db, "guides"), {
            title: formData.get('guideTitle'),
            content: guideContentHtml,
            imageUrl: imageUrl,
            createdAt: serverTimestamp()
        });

        guideStatusMsg.textContent = "✅ Fiche conseil publiée avec succès !";
        guideForm.reset();
        document.getElementById('guideCareEditor').innerHTML = '';
        loadGuides();
        
    } catch (err) {
        console.error("Erreur lors de la création de la fiche :", err);
        guideStatusMsg.textContent = "❌ Erreur : " + err.message;
    } finally {
        btn.disabled = false;
    }
});

async function loadSliderPreview() {
    const preview = document.getElementById('sliderPreview');
    if (!preview) return;

    try {
        const docSnap = await getDoc(doc(db, "settings", "heroSlider"));
        if (docSnap.exists() && docSnap.data().photos?.length > 0) {
            const photos = docSnap.data().photos;
            preview.innerHTML = '';
            photos.forEach((photoData, index) => {
                const isObject = typeof photoData === 'object' && photoData !== null;
                const url = isObject ? photoData.url : photoData;
                
                const div = document.createElement('div');
                // NOUVEAU : Alignement horizontal avec flèches aux extrémités
                div.style.cssText = "display: flex; align-items: center; gap: 8px; background: #fff; padding: 10px; border-radius: 8px; border: 1px solid #ddd; box-shadow: 0 2px 4px rgba(0,0,0,0.05);";
                
                div.innerHTML = `
                    <button onclick="moveSlider(${index}, -1)" class="btn-outline" style="padding: 2px 8px; font-size: 1rem; height: 30px; border: none; background: #f0f0f0; cursor: pointer;" ${index === 0 ? 'disabled' : ''}>‹</button>
                    
                    <div style="position: relative; width: 120px; height: 80px;">
                        <img src="${url}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px;">
                        <button onclick="deleteSliderImg(${index})" class="btn-delete-img" style="position: absolute; top: -8px; right: -8px; width: 22px; height: 22px; font-size: 12px; display: flex; align-items: center; justify-content: center; padding: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">×</button>
                        <button onclick="openSliderModal(${index})" style="position: absolute; bottom: -8px; right: -8px; background: #6d8c6d; color: white; border: none; border-radius: 50%; width: 26px; height: 26px; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">✎</button>
                    </div>
                    
                    <button onclick="moveSlider(${index}, 1)" class="btn-outline" style="padding: 2px 8px; font-size: 1rem; height: 30px; border: none; background: #f0f0f0; cursor: pointer;" ${index === photos.length - 1 ? 'disabled' : ''}>›</button>
                `;
                preview.appendChild(div);
            });
        } else {
            preview.innerHTML = '<p>Aucun visuel configuré.</p>';
        }
    } catch (e) { console.error(e); }
}

// NOUVEAU: Logique de la modale Slider
window.openSliderModal = async (index) => {
    const docSnap = await getDoc(doc(db, "settings", "heroSlider"));
    const photos = docSnap.data().photos;
    const photoData = photos[index];
    
    document.getElementById('modalSlideIndex').value = index;
    // Si c'est un objet, on charge ses données, sinon c'est vide
    document.getElementById('modalSlideLink').value = photoData.link || '';
    document.getElementById('modalSlideText').value = photoData.text || '';
    
    document.getElementById('sliderModal').style.display = 'flex';
};

window.closeSliderModal = () => {
    document.getElementById('sliderModal').style.display = 'none';
};

document.getElementById('sliderModalForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const index = document.getElementById('modalSlideIndex').value;
    const link = document.getElementById('modalSlideLink').value;
    const text = document.getElementById('modalSlideText').value;
    
    const docRef = doc(db, "settings", "heroSlider");
    const docSnap = await getDoc(docRef);
    const photos = docSnap.data().photos;
    
    const url = typeof photos[index] === 'string' ? photos[index] : photos[index].url;
    photos[index] = { url, link, text }; // On met à jour avec l'objet formaté
    
    await updateDoc(docRef, { photos });
    closeSliderModal();
    loadSliderPreview();
});

if(sliderForm) {
    sliderForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('btnSubmitSlider');
        const files = document.getElementById('sliderFiles').files;
        if (files.length === 0) return;
        
        try {
            btn.disabled = true;
            sliderStatusMsg.textContent = "Upload des nouvelles images... ⏳";
            
            const uploadData = new FormData();
            for (let i = 0; i < files.length; i++) { uploadData.append('photos', files[i]); }
            
            const token = await auth.currentUser.getIdToken();
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: uploadData
            });

            if (!response.ok) throw new Error("Échec de l'upload");
            const { files: uploadedFiles } = await response.json();
            
            // NOUVEAU: Stockage sous forme d'objet avec texte et lien vides
            const newPhotos = uploadedFiles.map(f => ({ url: f.url, text: '', link: '' }));

            const docRef = doc(db, "settings", "heroSlider");
            const docSnap = await getDoc(docRef);
            let finalPhotos = newPhotos;

            if (docSnap.exists() && docSnap.data().photos) {
                finalPhotos = [...docSnap.data().photos, ...newPhotos];
            }

            await setDoc(docRef, {
                photos: finalPhotos,
                updatedAt: serverTimestamp()
            });

            sliderStatusMsg.textContent = "✅ Slider mis à jour !";
            sliderForm.reset();
            loadSliderPreview();
        } catch (err) {
            sliderStatusMsg.textContent = "❌ Erreur : " + err.message;
        } finally {
            btn.disabled = false;
        }
    });
}

// NOUVEAU: Logique d'upload individuel pour les grilles
async function handleGridUpload(type, files, statusId) {
    const status = document.getElementById(statusId);
    if (files.length === 0) return;

    try {
        status.textContent = "Upload de l'image... ⏳";
        const docRef = doc(db, "settings", "featureGrid");
        const docSnap = await getDoc(docRef);
        let currentGrid = docSnap.exists() && docSnap.data()[type] ? docSnap.data()[type] : [];

        if (currentGrid.length >= 4) {
            status.textContent = "❌ Limite de 4 images atteinte. Supprimez-en une d'abord.";
            return;
        }

        const uploadData = new FormData();
        uploadData.append('photos', files[0]); // Un seul fichier ajouté à la fois
        
        const token = await auth.currentUser.getIdToken();
        const response = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: uploadData
        });

        const { files: uploadedFiles } = await response.json();
        currentGrid.push(uploadedFiles[0].url);

        await setDoc(docRef, { [type]: currentGrid }, { merge: true });
        
        status.textContent = "✅ Image ajoutée !";
        document.getElementById(`${type}GridForm`).reset();
        loadGridPreviews();
    } catch (err) {
        status.textContent = "❌ Erreur : " + err.message;
    }
}

document.getElementById('boutiqueGridForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleGridUpload('boutique', document.getElementById('boutiqueFiles').files, 'boutiqueUploadStatus');
});

document.getElementById('conseilGridForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleGridUpload('conseil', document.getElementById('conseilFiles').files, 'conseilUploadStatus');
});

async function loadGridPreviews() {
    const docSnap = await getDoc(doc(db, "settings", "featureGrid"));
    if (!docSnap.exists()) return;
    const data = docSnap.data();

    const renderGridControls = (id, type, urls) => {
        const el = document.getElementById(id);
        if (el && urls) {
            el.innerHTML = urls.map((url, index) => `
                <div class="preview-item">
                    <img src="${url}">
                    <div class="preview-controls" style="display: flex; justify-content: space-between; align-items: center; margin-top: 5px; gap: 2px;">
                        <button onclick="moveGridImg('${type}', ${index}, -1)" style="padding: 2px 6px; font-size: 0.9rem; height: 24px; border: none; background: #f0f0f0; cursor: pointer; display: flex; align-items: center; justify-content: center; border-radius: 4px;" ${index === 0 ? 'disabled' : ''}>‹</button>
                        
                        <button onclick="deleteGridImg('${type}', ${index})" class="btn-delete-img">×</button>
                        
                        <button onclick="moveGridImg('${type}', ${index}, 1)" style="padding: 2px 6px; font-size: 0.9rem; height: 24px; border: none; background: #f0f0f0; cursor: pointer; display: flex; align-items: center; justify-content: center; border-radius: 4px;" ${index === urls.length - 1 ? 'disabled' : ''}>›</button>
                    </div>
                </div>
            `).join('');
        }
    };

    renderGridControls('boutiquePreview', 'boutique', data.boutique);
    renderGridControls('conseilPreview', 'conseil', data.conseil);
}

// NOUVEAU: Fonctions de déplacement et de suppression de la grille
window.deleteGridImg = async (type, index) => {
    if (!confirm("Supprimer cette image de la grille ?")) return;
    const docRef = doc(db, "settings", "featureGrid");
    const docSnap = await getDoc(docRef);
    const grid = docSnap.data()[type];
    grid.splice(index, 1);
    await updateDoc(docRef, { [type]: grid });
    loadGridPreviews();
};

window.moveGridImg = async (type, index, direction) => {
    const docRef = doc(db, "settings", "featureGrid");
    const docSnap = await getDoc(docRef);
    const grid = [...docSnap.data()[type]];
    const newIndex = index + direction;
    [grid[index], grid[newIndex]] = [grid[newIndex], grid[index]];
    await updateDoc(docRef, { [type]: grid });
    loadGridPreviews();
};

// Nouveau : Fonction globale de formatage à la volée du texte sélectionné
window.formatDoc = (cmd) => {
    document.execCommand(cmd, false, null);
};

async function loadGuides() {
    const container = document.getElementById('adminGuides');
    if (!container) return;
    container.innerHTML = '<p>Chargement des fiches conseils...</p>';
    
    try {
        const q = query(collection(db, "guides"), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        
        container.innerHTML = '';
        if (snap.empty) {
            container.innerHTML = '<p style="font-size:0.9rem; color:#888;">Aucune fiche conseil publiée pour le moment.</p>';
            return;
        }

        snap.forEach(guideDoc => {
            const g = guideDoc.data();
            const div = document.createElement('div');
            div.className = 'inventory-item';
            
            const coverPhoto = g.imageUrl || '../assets/img/placeholder.jpg';
            const dateObj = g.createdAt?.toDate() ? g.createdAt.toDate().toLocaleDateString('fr-FR') : 'Date inconnue';
            
            div.innerHTML = `
                <img src="${coverPhoto}" style="width:50px; height:50px; object-fit:cover; border-radius:6px; border:1px solid var(--border-color);">
                <div style="display:flex; flex-direction:column; gap:5px;">
                    <span style="font-weight:600; font-size:1.1rem;">${g.title}</span>
                    <span style="font-size:0.85rem; color:#888;">Publié le ${dateObj}</span>
                </div>
                <div></div>
                <div></div>
                <div style="display:flex; gap:10px; justify-content:flex-end;">
                    <button onclick="editGuide('${guideDoc.id}')" class="btn-outline">Gérer</button>
                    <button onclick="deleteGuide('${guideDoc.id}')" class="btn-logout" style="border:none;">Supprimer</button>
                </div>
            `;
            container.appendChild(div);
        });
    } catch (error) {
        console.error("Erreur lors du chargement des guides :", error);
        container.innerHTML = '<p>Erreur lors du chargement des fiches.</p>';
    }
}

window.editGuide = async (id) => {
    try {
        const docRef = doc(db, "guides", id);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            const g = docSnap.data();
            
            document.getElementById('editGuideId').value = id;
            document.getElementById('editGuideTitle').value = g.title || '';
            document.getElementById('editGuideCareEditor').innerHTML = g.content || '';
            
            const previewContainer = document.getElementById('editGuideImagePreview');
            if (g.imageUrl) {
                previewContainer.innerHTML = `
                    <img src="${g.imageUrl}" style="width:100px; height:60px; object-fit:cover; border-radius:4px; border:1px solid var(--border-color); display:block; margin-bottom:5px;">
                    <span style="font-size:0.8rem; color:#666;">Couverture actuelle</span>
                `;
            } else {
                previewContainer.innerHTML = '<p style="font-size:0.85rem; color:#888;">Aucune image de couverture actuelle.</p>';
            }
            
            document.getElementById('editGuideModal').style.display = 'flex';
        }
    } catch (error) {
        console.error("Erreur de chargement de la fiche :", error);
        alert("Impossible de charger la fiche conseil.");
    }
};

window.closeEditGuideModal = () => {
    document.getElementById('editGuideModal').style.display = 'none';
    document.getElementById('editGuideForm').reset();
    document.getElementById('editGuideCareEditor').innerHTML = '';
    document.getElementById('editGuideUploadStatus').textContent = '';
};

document.getElementById('editGuideForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnSubmitEditGuide');
    const statusText = document.getElementById('editGuideUploadStatus');
    const formData = new FormData(e.target);
    const fileInput = document.getElementById('editGuideFile');
    const guideId = document.getElementById('editGuideId').value;

    try {
        btn.disabled = true;
        statusText.textContent = fileInput.files.length > 0 ? "Téléchargement de la nouvelle couverture... ⏳" : "Mise à jour de la fiche... ⏳";

        const docRef = doc(db, "guides", guideId);
        const docSnap = await getDoc(docRef);
        let imageUrl = docSnap.exists() ? docSnap.data().imageUrl : null;

        if (fileInput.files.length > 0) {
            const uploadData = new FormData();
            uploadData.append('photos', fileInput.files[0]);
            
            const token = await auth.currentUser.getIdToken();
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: uploadData
            });

            if (!response.ok) throw new Error("Échec de l'upload de la nouvelle couverture");
            const { files: uploadedFiles } = await response.json();
            if (uploadedFiles && uploadedFiles.length > 0) {
                imageUrl = uploadedFiles[0].url;
            }
        }

        const guideContentHtml = document.getElementById('editGuideCareEditor').innerHTML;

        await updateDoc(docRef, {
            title: formData.get('guideTitle'),
            content: guideContentHtml,
            imageUrl: imageUrl
        });

        statusText.textContent = "✅ Fiche conseil mise à jour !";
        loadGuides();
        setTimeout(() => closeEditGuideModal(), 1500);
    } catch (err) {
        console.error(err);
        statusText.textContent = "❌ Erreur : " + err.message;
    } finally {
        btn.disabled = false;
    }
});

window.deleteGuide = async (id) => {
    if (confirm("Êtes-vous sûr de vouloir supprimer définitivement cette fiche conseil ?")) {
        try {
            const docRef = doc(db, "guides", id);
            const docSnap = await getDoc(docRef);
            
            if (docSnap.exists()) {
                const guide = docSnap.data();
                if (guide.imageUrl) {
                    const key = new URL(guide.imageUrl).pathname.substring(1);
                    const token = await auth.currentUser.getIdToken();
                    await fetch('/api/delete', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}` 
                        },
                        body: JSON.stringify({ keys: [key] })
                    });
                }
            }
            
            await deleteDoc(docRef);
            loadGuides();
        } catch (error) {
            console.error("Erreur lors de la suppression de la fiche :", error);
            alert("Une erreur est survenue lors de la suppression.");
        }
    }
};

window.triggerInlineImageUpload = (editorId) => {
    document.getElementById(`inlineImageInput_${editorId}`).click();
};

window.handleInlineImageUpload = async (input, editorId) => {
    const file = input.files[0];
    if (!file) return;

    const editor = document.getElementById(editorId);
    editor.focus();

    try {
        const uploadData = new FormData();
        uploadData.append('photos', file);

        const token = await auth.currentUser.getIdToken();
        const response = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: uploadData
        });

        if (!response.ok) throw new Error("Échec de l'upload de l'image insérée");

        const { files: uploadedFiles } = await response.json();
        if (uploadedFiles && uploadedFiles.length > 0) {
            const imageUrl = uploadedFiles[0].url;
            document.execCommand('insertImage', false, imageUrl);
        }
    } catch (err) {
        console.error("Erreur lors de l'insertion de l'image :", err);
        alert("Impossible d'insérer l'image à cet emplacement.");
    } finally {
        input.value = '';
    }
};

// Modification de l'utilitaire existant pour accepter les paramètres optionnels (ex: types de blocs ou alignements)
window.formatDoc = (cmd, value = null) => {
    document.execCommand(cmd, false, value);
};

// NOUVEAU : Logique complète d'administration des catégories et d'inputs dynamiques

window.loadAdminCategories = async () => {
    const listContainer = document.getElementById('adminCategoriesList');
    const productCatSelect = document.getElementById('adminProductCategory');
    const editCatSelect = document.getElementById('editCategory');
    
    if (!listContainer) return;
    
    const categoriesSnap = await getDocs(collection(db, "categories"));
    
    let listHtml = '';
    let selectOptionsHtml = '<option value="" disabled selected>Choisir une catégorie...</option>';
    let editOptionsHtml = '';

    categoriesSnap.forEach(catDoc => {
        const cat = catDoc.data();
        
        // NOUVEAU : Ajout du bouton "Modifier" à côté du bouton "Supprimer"
        listHtml += `
            <div class="inventory-item" style="grid-template-columns: 2fr 1fr 1fr auto; align-items: center;">
                <div><strong>${cat.name}</strong> <span style="font-size:0.8rem; color:#888;">(${catDoc.id})</span></div>
                <div>Type: ${cat.type}</div>
                <div>Lots configurés: [${cat.lots.join(', ')}]</div>
                <div style="display: flex; gap: 10px;">
                    <button onclick="openEditCategory('${catDoc.id}')" class="btn-buy" style="padding: 6px 12px; font-size: 0.85rem; border-radius: 4px;">Modifier</button>
                    <button onclick="deleteCategory('${catDoc.id}')" class="btn-logout" style="border:none; padding: 6px 12px;">Supprimer</button>
                </div>
            </div>
        `;
        selectOptionsHtml += `<option value="${catDoc.id}">${cat.name}</option>`;
        editOptionsHtml += `<option value="${catDoc.id}">${cat.name}</option>`;
    });

    listContainer.innerHTML = listHtml || '<p>Aucune catégorie configurée.</p>';
    if (productCatSelect) productCatSelect.innerHTML = selectOptionsHtml;
    if (editCatSelect) editCatSelect.innerHTML = editOptionsHtml;
};

window.generatePriceInputs = async (containerId, categoryId, existingPrices = null) => {
    const container = document.getElementById(containerId);
    if (!container || !categoryId) return;

    const catSnap = await getDoc(doc(db, "categories", categoryId));
    if (!catSnap.exists()) return;

    const lots = catSnap.data().lots;
    container.innerHTML = lots.map(lot => {
        const value = existingPrices && existingPrices[lot] !== undefined ? existingPrices[lot] : '';
        return `
            <div style="flex: 1; min-width: 120px;">
                <label style="font-size:0.8rem; font-weight:600; display:block; margin-bottom:5px;">Prix Lot de ${lot} (€)</label>
                <input type="number" class="lot-price-input" data-lot="${lot}" placeholder="Ex: 15.00" step="0.01" value="${value}" required>
            </div>
        `;
    }).join('');
};

document.getElementById('categoryForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('newCatId').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const name = document.getElementById('newCatName').value.trim();
    const type = document.getElementById('newCatType').value;
    const lotsRaw = document.getElementById('newCatLots').value;
    
    const lots = lotsRaw.split(',').map(l => parseInt(l.trim())).filter(l => !isNaN(l));

    if (!id || !name || lots.length === 0) return alert("Veuillez remplir correctement tous les champs.");

    await setDoc(doc(db, "categories", id), { name, type, lots });
    document.getElementById('categoryForm').reset();
    loadAdminCategories();
    alert("Catégorie créée et liée avec succès ! 🎉");
});

window.deleteCategory = async (id) => {
    if (confirm("Confirmer la suppression de la catégorie ? Les articles liés ne seront pas supprimés mais devront être réassignés.")) {
// Ligne précédente
        await deleteDoc(doc(db, "categories", id));
        loadAdminCategories();
    }
};

// NOUVEAU : Fonctions pour gérer la modale d'édition de catégorie
window.openEditCategory = async (id) => {
    const catSnap = await getDoc(doc(db, "categories", id));
    if (catSnap.exists()) {
        const cat = catSnap.data();
        document.getElementById('editCatId').value = id;
        document.getElementById('editCatName').value = cat.name;
        document.getElementById('editCatType').value = cat.type;
        document.getElementById('editCatLots').value = cat.lots.join(', ');
        document.getElementById('editCategoryModal').style.display = 'flex';
    }
};

window.closeEditCategoryModal = () => {
    document.getElementById('editCategoryModal').style.display = 'none';
};

document.getElementById('editCategoryForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('editCatId').value;
    const name = document.getElementById('editCatName').value.trim();
    const type = document.getElementById('editCatType').value;
    const lotsRaw = document.getElementById('editCatLots').value;
    
    const lots = lotsRaw.split(',').map(l => parseInt(l.trim())).filter(l => !isNaN(l));

    if (!name || lots.length === 0) return alert("Veuillez remplir correctement tous les champs.");

    await updateDoc(doc(db, "categories", id), { name, type, lots });
    closeEditCategoryModal();
    loadAdminCategories();
    alert("Catégorie mise à jour avec succès ! ✏️");
});

// NOUVEAU : Fonction pour le widget météo du Panel Admin
async function loadAdminWeather() {
    try {
        const API_KEY = '12e08b31287d3ae1e88369638b92d921'; // Ta clé API ici aussi
        const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Nîmes,FR&units=metric&lang=fr&appid=${API_KEY}`);
        if (!response.ok) throw new Error("Erreur météo");
        
        const data = await response.json();
        const temp = Math.round(data.main.temp);
        const desc = data.weather[0].description;
        const iconCode = data.weather[0].icon; 
        
        const iconEl = document.getElementById('adminWeatherIcon');
        const tempEl = document.getElementById('adminWeatherTemp');
        
        if (iconEl && tempEl) {
            iconEl.innerHTML = `<img src="https://openweathermap.org/img/wn/${iconCode}.png" style="width: 30px; height: 30px; margin-bottom: -5px; filter: drop-shadow(0 2px 2px rgba(0,0,0,0.1));">`;
            
            // Changement de couleur selon la gravité
            let color = "var(--accent-brown)";
            if (temp >= 28) color = "#d9534f"; // Rouge canicule
            if (temp <= 10) color = "#4d5d30"; // Vert/Bleu pour le froid (en gardant ton code couleur)
            
            tempEl.innerHTML = `<span style="color: ${color}; font-size: 1rem;">${temp}°C</span> <span style="opacity: 0.7; font-weight: 400; text-transform: capitalize;">- ${desc}</span>`;
        }
    } catch (e) {
        console.error("Impossible de charger la météo admin:", e);
        const tempEl = document.getElementById('adminWeatherTemp');
        if (tempEl) tempEl.textContent = "Météo indisponible";
    }
}