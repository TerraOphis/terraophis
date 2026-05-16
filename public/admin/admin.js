import { db, auth } from '../firebase-config.js';
import { collection, addDoc, getDocs, deleteDoc, doc, updateDoc, getDoc, setDoc, serverTimestamp, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";


let editProductId = null;
const productForm = document.getElementById('productForm');
const statusMsg = document.getElementById('uploadStatus');

// --- SÉCURITÉ & AUTHENTIFICATION ---

onAuthStateChanged(auth, (user) => {
    if (user) {
        // L'utilisateur est connecté, on vérifie si c'est le bon email
        if (user.email === "martin.stuis11@gmail.com") {
            console.log("Accès Admin accordé :", user.email);
            loadInventory(); 
            // NOUVEAU : Chargement des commandes à la connexion
            loadOrders();
            loadSliderPreview();
            loadGridPreviews();
        } else {
            // Connecté mais pas avec le bon compte
            console.warn("Accès refusé pour :", user.email);
            // NOUVEAU : Redirection vers l'URL propre
            window.location.href = "/login?error=forbidden";
        }
    } else {
        // Pas de session trouvée, on attend un tout petit peu ou on redirige
        // Firebase a besoin d'un instant pour vérifier le cache local
        setTimeout(() => {
            if (!auth.currentUser) {
                // NOUVEAU : Redirection vers l'URL propre
                window.location.href = "/login";
            }
        }, 1000); // On laisse 1 seconde de battement
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
        // On n'affiche le message d'upload que si de nouveaux fichiers sont détectés
        statusMsg.textContent = files.length > 0 ? "Téléchargement des images vers R2... ⏳" : "Enregistrement en cours...";

        let photoUrls = [];

        // Upload conditionnel (utile en mode édition si on ne change pas les photos)
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

        const productData = {
            name: formData.get('name'),
            latinName: formData.get('latinName'),
            price: parseFloat(formData.get('price')),
            stock: parseInt(formData.get('stock')),
            category: formData.get('category'),
            difficulty: formData.get('difficulty'),
            description: formData.get('description'),
        };

        // Branchement de la logique Mise à jour VS Création
        if (editProductId) {
            if (photoUrls.length > 0) {
                productData.photos = photoUrls;
            }
            await updateDoc(doc(db, "products", editProductId), productData);
            statusMsg.textContent = "✅ Produit mis à jour !";
            
            // Réinitialisation de l'état
            editProductId = null;
            btn.textContent = "PUBLIER LE PRODUIT";
            document.getElementById('productFiles').required = true;
        } else {
            if (photoUrls.length === 0) throw new Error("Les photos sont obligatoires.");
            
            productData.photos = photoUrls;
            productData.createdAt = serverTimestamp();
            await addDoc(collection(db, "products"), productData);
            statusMsg.textContent = "✅ Produit ajouté !";
        }

        productForm.reset();
        loadInventory();
    } catch (err) {
        console.error(err);
        statusMsg.textContent = "❌ Erreur : " + err.message;
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
        div.style.cssText = "display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid #ddd; align-items:center;";
        
        // Affichage dynamique pour rupture de stock
        const stockText = p.stock > 0 ? `(${p.stock} en stock)` : `<strong style="color:red;">(Sold Out)</strong>`;
        
        // Ajout de l'appel à la fonction editProduct
        div.innerHTML = `
            <span><strong>${p.name}</strong> ${stockText} - ${p.price}€</span>
            <div>
                <button onclick="editProduct('${productDoc.id}')" style="color:blue; background:none; border:none; cursor:pointer; margin-right:15px;">Modifier</button>
                <button onclick="deleteProduct('${productDoc.id}')" style="color:red; background:none; border:none; cursor:pointer;">Supprimer</button>
            </div>
        `;
        container.appendChild(div);
    });
}

window.editProduct = async (id) => {
    try {
        const docRef = doc(db, "products", id);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            const p = docSnap.data();
            
            // Pré-remplissage des champs
            productForm.elements['name'].value = p.name;
            productForm.elements['latinName'].value = p.latinName;
            productForm.elements['price'].value = p.price;
            productForm.elements['stock'].value = p.stock;
            productForm.elements['category'].value = p.category;
            productForm.elements['difficulty'].value = p.difficulty;
            productForm.elements['description'].value = p.description;
            
            // Passage de l'interface en mode édition
            editProductId = id;
            document.getElementById('btnSubmit').textContent = "METTRE À JOUR LE PRODUIT";
            document.getElementById('productFiles').required = false; 
            
            window.scrollTo(0, 0);
        }
    } catch (error) {
        console.error("Erreur de chargement :", error);
        alert("Impossible de charger le produit.");
    }
};

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
                    itemsHtml += `<li><strong>x${item.quantity}</strong> - ${prodName}</li>`;
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

        // Si une image est sélectionnée, on l'envoie sur R2 via ton API d'upload existante
        if (fileInput.files.length > 0) {
            guideStatusMsg.textContent = "Téléchargement de l'image... ⏳";
            const uploadData = new FormData();
            
            // On utilise la clé 'photos' attendue par ton middleware multer côté serveur
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

        // Création du document dans la nouvelle collection 'guides'
        guideStatusMsg.textContent = "Création de la fiche...";
        await addDoc(collection(db, "guides"), {
            title: formData.get('guideTitle'),
            content: formData.get('guideContent'),
            imageUrl: imageUrl,
            createdAt: serverTimestamp()
        });

        guideStatusMsg.textContent = "✅ Fiche conseil publiée avec succès !";
        guideForm.reset();
        
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