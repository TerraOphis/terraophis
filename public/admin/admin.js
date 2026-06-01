import { db, auth } from '../firebase-config.js';
import { collection, addDoc, getDocs, deleteDoc, doc, updateDoc, getDoc, setDoc, serverTimestamp, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const productForm = document.getElementById('productForm');
const statusMsg = document.getElementById('uploadStatus');

// --- SÉCURITÉ & AUTHENTIFICATION ---

// NOUVEAU: Logique globale pour les Options Personnalisées et Gratuites combinées
window.currentCustomOptions = { name: "", variants: [] };
window.currentFreeOptions = { name: "", values: [] };
window.currentVariantStocks = {}; // Stockage temporaire de la matrice de stock courante

// NOUVEAU : Capture en temps réel de ce qui est écrit dans les inputs générés de la matrice
window.saveCurrentMatrixInputs = (isEdit = false) => {
    const selector = isEdit ? '.edit-matrix-stock-input' : '.matrix-stock-input';
    document.querySelectorAll(selector).forEach(input => {
        window.currentVariantStocks[input.dataset.comb] = input.value !== "" ? parseInt(input.value) : "";
    });
};

// NOUVEAU : Générateur visuel de la matrice de stock croisée (Option Custom x Option Gratuite)
window.renderStockMatrix = (containerId, isEdit = false) => {
    const container = document.getElementById(containerId);
    if (!container) return;

    const variants = window.currentCustomOptions.variants || [];
    const freeValues = window.currentFreeOptions.values || [];

    if (variants.length === 0) {
        container.innerHTML = '';
        return;
    }

    let html = `
        <div style="background: #faf9f5; padding: 15px; border-radius: 8px; width: 100%; border: 1px dashed var(--accent-brown); box-sizing: border-box; margin-bottom: 15px;">
            <h4 style="margin-top: 0; margin-bottom: 12px; font-family: 'Playfair Display', serif; color: var(--accent-brown);">Grille des stocks détaillés</h4>
    `;

    // Cas A : Il y a des options gratuites renseignées -> On croise les dimensions et les couleurs
    if (freeValues.length > 0) {
        html += '<div style="display:flex; flex-direction:column; gap:12px;">';
        freeValues.forEach(freeVal => {
            html += `
                <div style="background: #fff; padding: 10px; border-radius: 6px; border: 1px solid var(--border-color);">
                    <strong style="color: #4d5d30; display: block; margin-bottom: 8px; font-size: 0.85rem; text-transform: uppercase;">Déclinaison : ${freeVal}</strong>
                    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 10px;">
            `;
            variants.forEach(v => {
                const combKey = `${v.label}_${freeVal}`;
                const currentVal = window.currentVariantStocks[combKey] !== undefined ? window.currentVariantStocks[combKey] : "";
                html += `
                    <div>
                        <label style="font-size: 0.75rem; display: block; margin-bottom: 3px; color: #666;">${v.label}</label>
                        <input type="number" class="${isEdit ? 'edit-' : ''}matrix-stock-input" data-comb="${combKey}" placeholder="Stock" value="${currentVal}" style="padding: 6px; font-size: 0.85rem;">
                    </div>
                `;
            });
            html += `</div></div>`;
        });
        html += '</div>';
    } 
    // Cas B : Uniquement des options Custom (ex: Dimensions simples, pas de free options)
    else {
        html += '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px;">';
        variants.forEach(v => {
            const combKey = v.label;
            const currentVal = window.currentVariantStocks[combKey] !== undefined ? window.currentVariantStocks[combKey] : "";
            html += `
                <div style="background: #fff; padding: 10px; border-radius: 6px; border: 1px solid var(--border-color);">
                    <label style="font-size: 0.85rem; font-weight: 600; display: block; margin-bottom: 5px; color: var(--accent-brown);">${v.label}</label>
                    <input type="number" class="${isEdit ? 'edit-' : ''}matrix-stock-input" data-comb="${combKey}" placeholder="Stock" value="${currentVal}" style="padding: 6px; font-size: 0.85rem;">
                </div>
            `;
        });
        html += '</div>';
    }

    html += '</div>';
    container.innerHTML = html;
};

window.addCustomOption = (valueId, priceId, listId) => {
    const valueInput = document.getElementById(valueId);
    const priceInput = document.getElementById(priceId);
    if (!valueInput || !priceInput || !valueInput.value || !priceInput.value) return;

    const isEdit = valueId.startsWith('edit');
    window.saveCurrentMatrixInputs(isEdit);

    window.currentCustomOptions.variants.push({
        label: valueInput.value.trim(),
        price: parseFloat(priceInput.value)
    });

    valueInput.value = '';
    priceInput.value = '';
    window.renderCustomOptions(listId);
    window.renderStockMatrix(isEdit ? 'editMatrixStockContainer' : 'matrixStockContainer', isEdit);
};

window.removeCustomOption = (index, listId) => {
    const isEdit = listId.startsWith('edit');
    window.saveCurrentMatrixInputs(isEdit);

    window.currentCustomOptions.variants.splice(index, 1);
    window.renderCustomOptions(listId);
    window.renderStockMatrix(isEdit ? 'editMatrixStockContainer' : 'matrixStockContainer', isEdit);
};

window.renderCustomOptions = (listId) => {
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = window.currentCustomOptions.variants.map((variant, index) => `
        <li style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-light);">
            <span><strong>${variant.label}</strong> : ${variant.price.toFixed(2)} €</span>
            <button type="button" onclick="window.removeCustomOption(${index}, '${listId}')" style="color: #a35d5d; border: none; background: none; cursor: pointer; font-weight: bold; font-size: 1.2rem;">&times;</button>
        </li>
    `).join('');
};

window.addFreeOption = (valueId, listId) => {
    const valueInput = document.getElementById(valueId);
    if (!valueInput || !valueInput.value) return;

    const isEdit = valueId.startsWith('edit');
    window.saveCurrentMatrixInputs(isEdit);

    window.currentFreeOptions.values.push(valueInput.value.trim());
    valueInput.value = '';
    window.renderFreeOptions(listId);
    window.renderStockMatrix(isEdit ? 'editMatrixStockContainer' : 'matrixStockContainer', isEdit);
};

window.removeFreeOption = (index, listId) => {
    const isEdit = listId.startsWith('edit');
    window.saveCurrentMatrixInputs(isEdit);

    window.currentFreeOptions.values.splice(index, 1);
    window.renderFreeOptions(listId);
    window.renderStockMatrix(isEdit ? 'editMatrixStockContainer' : 'matrixStockContainer', isEdit);
};

window.renderFreeOptions = (listId) => {
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = window.currentFreeOptions.values.map((val, index) => `
        <li style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-light);">
            <span><strong>${val}</strong></span>
            <button type="button" onclick="window.removeFreeOption(${index}, '${listId}')" style="color: #a35d5d; border: none; background: none; cursor: pointer; font-weight: bold; font-size: 1.2rem;">&times;</button>
        </li>
    `).join('');
};


window.toggleCustomOptions = (selectElement, builderId, pricesContainerId) => {
    const builder = document.getElementById(builderId);
    const pricesContainer = document.getElementById(pricesContainerId);
    const freeBuilderId = builderId.replace('customOptionsBuilder', 'freeOptionsBuilder');
    const freeBuilder = document.getElementById(freeBuilderId);
    
    if (!builder || !pricesContainer) return;
    
    const selectedOption = selectElement.options[selectElement.selectedIndex];
    const isEdit = builderId.includes('edit');
    
    // NOUVEAU : Ciblage dynamique du champ stock selon le contexte (Création vs Édition)
    const stockInput = isEdit 
        ? document.getElementById('editStock') 
        : document.querySelector('#productForm input[name="stock"]');

    // On récupère le type de catégorie à partir de l'option sélectionnée
    const type = selectedOption.getAttribute('data-type') || '';

    if (type === 'materiels') {
        builder.style.display = 'block';
        pricesContainer.style.display = 'none';
        if (freeBuilder) freeBuilder.style.display = 'block';
        
        // NOUVEAU : Rendre le stock global invisible et non obligatoire car la grille prend le relais
        if (stockInput) {
            stockInput.style.display = 'none';
            stockInput.required = false;
            stockInput.value = '';
        }
    } else {
        builder.style.display = 'none';
        pricesContainer.style.display = 'block';
        if (freeBuilder) freeBuilder.style.display = 'none';
        
        // NOUVEAU : Réafficher et réimposer le stock global pour les articles classiques (ex: Animaux)
        if (stockInput) {
            stockInput.style.display = 'inline-block';
            stockInput.required = true;
        }
    }
};

// NOUVEAU: Fonction radicale pour unifier et nettoyer le texte d'un éditeur
window.unifyEditorText = (editorId) => {
    const editor = document.getElementById(editorId);
    if (!editor) return;

    // 1. Nettoyage HTML pur : suppression des attributs style résiduels
    editor.querySelectorAll('*').forEach(el => {
        el.removeAttribute('style');
        el.removeAttribute('class');
        el.removeAttribute('face');
        el.removeAttribute('size');
        el.removeAttribute('color');
    });

    // 2. Sélection de tout le contenu
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    // 3. Application forcée de la police de base
    document.execCommand('fontName', false, 'Montserrat, sans-serif');
    document.execCommand('fontSize', false, '3');
    document.execCommand('foreColor', false, '#4a4238'); // var(--accent-brown)
    
    selection.removeAllRanges();
    alert("Texte nettoyé et unifié avec succès ! ✨");
};

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
            loadShippingConfig();
            loadGridPreviews();
            loadGuides();
            loadAdminWeather();
            loadAboutPageAdmin()
            loadGlobalGuideToggle();
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

        // NOUVEAU : Sauvegarde des options personnalisées si c'est du matériel
        const selectCat = document.getElementById('adminProductCategory');
        const isMateriel = selectCat.options[selectCat.selectedIndex].getAttribute('data-type') === 'materiels';
        let customOpts = null;
        if (isMateriel && window.currentCustomOptions.variants.length > 0) {
            customOpts = {
                name: document.getElementById('customOptionName').value || "Option",
                variants: window.currentCustomOptions.variants
            };
        }

        // NOUVEAU : Sauvegarde des options gratuites si c'est du matériel
        let freeOpts = null;
        if (isMateriel && window.currentFreeOptions.values.length > 0) {
            freeOpts = {
                name: document.getElementById('freeOptionName').value || "Option supplémentaire",
                values: window.currentFreeOptions.values
            };
        }

        // NOUVEAU : Récupération et nettoyage des valeurs de la grille de stock croisée
        window.saveCurrentMatrixInputs(false);
        const cleanVariantStocks = {};
        for (const [key, val] of Object.entries(window.currentVariantStocks)) {
            if (val !== "") cleanVariantStocks[key] = parseInt(val);
        }

        const productData = {
            name: formData.get('name'),
            latinName: formData.get('latinName') || null, 
            stock: formData.get('stock') ? parseInt(formData.get('stock')) : 0,
            oldPrice: formData.get('oldPrice') ? parseFloat(formData.get('oldPrice')) : null,
            category: formData.get('category'),
            difficulty: formData.get('difficulty') || null, 
            bundleItems: window.currentBundleItems.length > 0 ? window.currentBundleItems : null,
            customOptions: customOpts, 
            freeOptions: freeOpts, 
            variantStocks: cleanVariantStocks, // NOUVEAU : Injection en BDD
            description: formData.get('description'),
            careGuide: careGuideHtml,
            prices: prices,
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
            
            if (document.getElementById('editProductId')) document.getElementById('editProductId').value = id;
            if (document.getElementById('editName')) document.getElementById('editName').value = p.name || '';
            if (document.getElementById('editLatinName')) document.getElementById('editLatinName').value = p.latinName || '';
            
            const editStockInput = document.getElementById('editStock');
            
            if (document.getElementById('editOldPrice')) document.getElementById('editOldPrice').value = p.oldPrice || '';
            if (document.getElementById('editCategory')) document.getElementById('editCategory').value = p.category || '';
            if (document.getElementById('editDifficulty')) document.getElementById('editDifficulty').value = p.difficulty || '';
            if (document.getElementById('editDescription')) document.getElementById('editDescription').value = p.description || '';
            if (document.getElementById('editCareGuideEditor')) document.getElementById('editCareGuideEditor').innerHTML = p.careGuide || '';
            
            await generatePriceInputs('editDynamicPricesContainer', p.category, p.prices || {
                "1": p.price, "3": p.price3, "5": p.price5, "10": p.price10
            });

            window.currentCustomOptions = { name: "", variants: [] };
            if (p.customOptions && p.customOptions.variants) {
                window.currentCustomOptions = p.customOptions;
                document.getElementById('editCustomOptionName').value = p.customOptions.name || "";
                window.renderCustomOptions('editCustomOptionsList');
                
                document.getElementById('editCustomOptionsBuilder').style.display = 'block';
                document.getElementById('editDynamicPricesContainer').style.display = 'none';
                
                // NOUVEAU : Masquage et désactivation stricte du champ editStock si options présentes
                if (editStockInput) {
                    editStockInput.style.display = 'none';
                    editStockInput.required = false;
                    editStockInput.value = '';
                }
            } else {
                document.getElementById('editCustomOptionsBuilder').style.display = 'none';
                document.getElementById('editDynamicPricesContainer').style.display = 'block';
                
                // NOUVEAU : Gestion de l'affichage du stock pour les produits simples ou packs
                if (editStockInput) {
                    if (p.bundleItems && p.bundleItems.length > 0) {
                        editStockInput.style.display = 'none';
                        editStockInput.required = false;
                    } else {
                        editStockInput.style.display = 'inline-block';
                        editStockInput.required = true;
                        editStockInput.value = p.stock || 0;
                    }
                }
            }
            
            window.currentFreeOptions = { name: "", values: [] };
            const editFreeBuilder = document.getElementById('editFreeOptionsBuilder');
            if (p.freeOptions && p.freeOptions.values) {
                window.currentFreeOptions = p.freeOptions;
                document.getElementById('editFreeOptionName').value = p.freeOptions.name || "";
                window.renderFreeOptions('editFreeOptionsList');
                if (editFreeBuilder) editFreeBuilder.style.display = 'block';
            } else {
                if (editFreeBuilder) editFreeBuilder.style.display = 'none';
            }
            
            window.currentVariantStocks = p.variantStocks || {};
            window.renderStockMatrix('editMatrixStockContainer', true);

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
    document.getElementById('editCareGuideEditor').innerHTML = ''; 
    document.getElementById('editUploadStatus').textContent = '';
    
    // NOUVEAU : Réinitialisation propre de tous les états de la matrice à la fermeture
    window.currentCustomOptions = { name: "", variants: [] };
    window.currentFreeOptions = { name: "", values: [] };
    window.currentVariantStocks = {};
    if (document.getElementById('matrixStockContainer')) document.getElementById('matrixStockContainer').innerHTML = '';
    if (document.getElementById('editMatrixStockContainer')) document.getElementById('editMatrixStockContainer').innerHTML = '';
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
        const isFirst = index === 0;
        const isLast = index === photos.length - 1;
        
        const div = document.createElement('div');
        div.className = 'edit-photo-item';
        div.style.cssText = 'height: auto; display: flex; flex-direction: column; gap: 8px;';
        
        // Correction : Ajout de la classe "btn-delete-photo" pour isoler son CSS des flèches de navigation
        div.innerHTML = `
            <div style="position: relative; width: 100px; height: 100px;">
                <img src="${url}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px; border: 2px solid white;">
                <button type="button" class="btn-delete-photo" onclick="deleteProductPhoto('${productId}', ${index}, '${url}')" title="Supprimer cette photo">×</button>
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

        const careGuideHtml = document.getElementById('editCareGuideEditor').innerHTML;

        const prices = {};
        document.querySelectorAll('#editDynamicPricesContainer .lot-price-input').forEach(input => {
            prices[input.dataset.lot] = parseFloat(input.value) || 0;
        });

        // NOUVEAU : Sauvegarde des options personnalisées à l'édition
        const editSelectCat = document.getElementById('editCategory');
        const isMaterielEdit = editSelectCat.options[editSelectCat.selectedIndex].getAttribute('data-type') === 'materiels';
        let customOptsEdit = null;
        if (isMaterielEdit && window.currentCustomOptions.variants.length > 0) {
            customOptsEdit = {
                name: document.getElementById('editCustomOptionName').value || "Option",
                variants: window.currentCustomOptions.variants
            };
        }

        // NOUVEAU : Sauvegarde des options gratuites à l'édition
        let freeOptsEdit = null;
        if (isMaterielEdit && window.currentFreeOptions.values.length > 0) {
            freeOptsEdit = {
                name: document.getElementById('editFreeOptionName').value || "Option supplémentaire",
                values: window.currentFreeOptions.values
            };
        }

        // NOUVEAU : Sauvegarde de la matrice modifiée
        window.saveCurrentMatrixInputs(true);
        const cleanVariantStocksEdit = {};
        for (const [key, val] of Object.entries(window.currentVariantStocks)) {
            if (val !== "") cleanVariantStocksEdit[key] = parseInt(val);
        }

        const editBundleBuilder = document.getElementById('editBundleBuilder');
        const isPack = editBundleBuilder && editBundleBuilder.style.display === 'block';
        const finalStock = isPack ? 0 : (formData.get('stock') ? parseInt(formData.get('stock')) : 0);

        await updateDoc(docRef, {
            name: formData.get('name'),
            latinName: formData.get('latinName') || null,
            stock: finalStock,
            oldPrice: formData.get('oldPrice') ? parseFloat(formData.get('oldPrice')) : null,
            category: formData.get('category'),
            difficulty: formData.get('difficulty') || null,
            description: formData.get('description'),
            careGuide: careGuideHtml,
            prices: prices, 
            customOptions: customOptsEdit, 
            freeOptions: freeOptsEdit,
            variantStocks: cleanVariantStocksEdit, // NOUVEAU : Enregistrement de la matrice mise à jour
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

async function loadInventory() {
    const container = document.getElementById('adminInventory');
    container.innerHTML = '<p>Chargement des stocks...</p>';
    
    const q = query(collection(db, "products"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    
    const allProducts = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    allProducts.forEach(p => {
        if (p.bundleItems && p.bundleItems.length > 0) {
            let virtualStock = Infinity;
            p.bundleItems.forEach(bItem => {
                const subProduct = allProducts.find(sub => sub.id === bItem.productId);
                if (subProduct) {
                    const possiblePacks = Math.floor(subProduct.stock / (bItem.qty * bItem.lot));
                    if (possiblePacks < virtualStock) virtualStock = possiblePacks;
                } else {
                    virtualStock = 0;
                }
            });
            p.stock = virtualStock === Infinity ? 0 : virtualStock;
            p.isPack = true;
        }
    });

    container.innerHTML = '';
    allProducts.forEach(p => {
        const div = document.createElement('div');
        div.className = 'inventory-item';
        
        // NOUVEAU : Calcul dynamique du stock global si le produit utilise une matrice
        let displayStock = p.stock || 0;
        let isMatrix = false;
        
        if (p.variantStocks && Object.keys(p.variantStocks).length > 0) {
            displayStock = Object.values(p.variantStocks).reduce((sum, val) => sum + (parseInt(val) || 0), 0);
            isMatrix = true;
        }

        let stockClass = "stock-out";
        let stockText = p.isPack ? "Rupture (Composants)" : "Rupture";
        
        // NOUVEAU : Utilisation du displayStock calculé
        if (displayStock > 10) {
            stockClass = "stock-high";
            stockText = p.isPack ? `${displayStock} packs possibles` : (isMatrix ? `${displayStock} en stock (Options)` : `${displayStock} en stock`);
        } else if (displayStock > 0) {
            stockClass = "stock-low";
            stockText = p.isPack ? `Max ${displayStock} packs` : (isMatrix ? `Reste ${displayStock} (Options)` : `Reste ${displayStock}`);
        }
        
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

        const firstPhoto = p.photos && p.photos.length > 0 ? p.photos[0] : '../assets/img/placeholder.jpg';
        
        div.innerHTML = `
            <img src="${firstPhoto}" style="width:50px; height:50px; object-fit:cover; border-radius:6px; border:1px solid var(--border-color);">
            <div style="display:flex; flex-direction:column; gap:5px;">
                <span style="font-weight:600; font-size:1.1rem;">${p.name} ${p.isPack ? '📦' : ''}</span>
                <span style="font-size:0.85rem; color:#888; text-transform:capitalize;">${p.category} | ${p.latinName || 'N/A'}</span>
            </div>
            <div>
                ${priceContent}
            </div>
            <div>
                <span class="stock-badge ${stockClass}">${stockText}</span>
            </div>
            <div style="display:flex; gap:10px; justify-content:flex-end;">
                <button onclick="editProduct('${p.id}')" class="btn-outline">Gérer</button>
                <button onclick="deleteProduct('${p.id}')" class="btn-logout" style="border:none;">Supprimer</button>
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

        for (const orderDoc of snap.docs) {
            const order = orderDoc.data();
            const orderId = orderDoc.id;
            const dateObj = order.createdAt?.toDate() ? order.createdAt.toDate().toLocaleDateString('fr-FR', {hour: '2-digit', minute:'2-digit'}) : 'Date inconnue';

            let itemsHtml = '';
            if (order.items && order.items.length > 0) {
                for (const item of order.items) {
                    const prodSnap = await getDoc(doc(db, "products", item.id));
                    const prodName = prodSnap.exists() ? prodSnap.data().name : "Spécimen supprimé";
                    
                    // NOUVEAU : Gestion de l'affichage textuel propre selon s'il s'agit d'une dimension (string) ou d'un lot d'insectes (number)
                    const lotText = item.lotSize ? (typeof item.lotSize === 'string' ? ` (Option : ${item.lotSize})` : ` (Lot de ${item.lotSize})`) : '';
                    
                    // NOUVEAU : Récupération et affichage de la variante gratuite choisie par le client
                    const freeOptText = item.freeOption ? ` (+ ${item.freeOption})` : '';
                    
                    itemsHtml += `<li><strong>x${item.quantity}</strong> - ${prodName}${lotText}${freeOptText}</li>`;
                }
            }

            const shippingBadge = order.shippingMethod === 'chrono18' ? '🚀 Chrono 18' : (order.shippingMethod === 'retrait' ? '📦 Retrait sur place' : '🚚 Colissimo');
            
            let addressHtml = `
                <div style="background: #eef2f5; padding: 8px 12px; border-radius: 6px; margin-bottom: 10px; display: inline-block;">
                    <span style="color:#4a7599; font-weight:bold; font-size: 1.05rem;">${shippingBadge}</span>
                </div>
                <br><strong>Nom du client :</strong> ${order.customerName || 'Client'}<br>
            `;

            if (order.shippingMethod !== 'retrait' && order.shippingAddress) {
                const addr = order.shippingAddress;
                addressHtml += `
                    ${addr.line1} ${addr.line2 ? '<br>' + addr.line2 : ''}<br>
                    ${addr.postalCode} ${addr.city}, ${addr.country}
                `;
            } else if (order.shippingMethod === 'retrait') {
                addressHtml += `<span style="color: #888; font-size: 0.85rem;">KM4 CENTER, Route d'Arles, Bouillargues</span>`;
            } else {
                addressHtml += '<em>Pas d\'adresse (Paiement incomplet ou service)</em>';
            }

            const div = document.createElement('div');
            div.className = 'order-card'; 
            
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
                        <option value="Expédié" ${order.status === 'Expédié' ? 'selected' : ''}>Expédié / Prêt au retrait</option>
                    </select>
                </div>
                <div class="order-card-body">
                    <div class="order-col">
                        <h4>Contenu du colis :</h4>
                        <ul>${itemsHtml}</ul>
                        <p class="order-price-total">Montant total : <strong>${Number(order.amountValue || 0).toFixed(2)} €</strong></p>
                    </div>
                    <div class="order-col">
                        <h4>Adresse / Livraison :</h4>
                        <p class="order-address-text">${addressHtml}</p>
                        <p class="order-contact-email">
                            ✉️ ${order.customerEmail || 'Anonyme'}<br>
                            📞 <strong>${order.customerPhone || 'Non renseigné'}</strong>
                        </p>
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

window.updateOrderStatus = async (id, newStatus) => {
    try {
        const orderRef = doc(db, "orders", id);
        const orderSnap = await getDoc(orderRef);

        await updateDoc(orderRef, { status: newStatus });

        if (orderSnap.exists()) {
            const order = orderSnap.data();
            const email = order.customerEmail;
            const name = order.customerName || 'Client';

            if (email && email !== 'Anonyme' && email !== 'Non renseigné') {
                let subject = '';
                let statusTitle = '';
                let statusText = '';

                if (newStatus === 'En préparation') {
                    subject = `Votre commande #${id.slice(0,6).toUpperCase()} est en préparation 🌿`;
                    statusTitle = `Préparation en cours...`;
                    statusText = `Votre sélection d'insectes et arthropodes est actuellement prise en charge au sein de notre élevage. Nous composons votre colis avec le plus grand soin en veillant aux paramètres d'aération et d'isothermie nécessaires à leur bien-être. Vous recevrez un nouvel e-mail dès la remise de vos spécimens au transporteur.`;
                } else if (newStatus === 'Expédié') {
                    subject = `Votre commande #${id.slice(0,6).toUpperCase()} est en route ! 📦`;
                    statusTitle = `Vos spécimens voyagent !`;
                    statusText = `Bonne nouvelle ! Votre colis a été remis à notre transporteur partenaire. Vos spécimens voyagent dans des conditions adaptées et sécurisées. Veillez à bien préparer leurs terrariums ou vivariums d'accueil afin de garantir une acclimatation douce dès leur arrivée.`;
                }

                if (subject && statusText) {
                    const htmlTemplate = `
                        <div style="background-color: #fcf8f2; padding: 40px 10px; font-family: 'Helvetica Neue', Arial, sans-serif;">
                            <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e0ddd5; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(74,66,56,0.05);">
                                <div style="background-color: #4d5d30; padding: 30px; text-align: center;">
                                    <img src="https://working.terraophis.fr/assets/img/logo_carre.png" alt="Terraophis" style="max-width: 120px; height: auto; display: block; margin: 0 auto;">
                                    <p style="color: #eadb9d; margin: 15px 0 0 0; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase;">Suivi de votre commande</p>
                                </div>
                                <div style="padding: 35px; color: #4a4238; text-align: center;">
                                    <h2 style="font-size: 20px; margin-top: 0; color: #4d5d30; font-weight: 600;">${statusTitle}</h2>
                                    <p style="font-size: 15px; line-height: 1.6; color: #555; text-align: left; background: #faf9f5; padding: 20px; border-radius: 8px; border-left: 3px solid #4d5d30;">
                                        Bonjour ${name},<br><br>
                                        ${statusText}
                                    </p>
                                    <p style="font-size: 14px; color: #666; margin-top: 25px;">Numéro de suivi et historique disponibles dans votre espace client.</p>
                                    <hr style="border: none; border-top: 1px solid #e0ddd5; margin: 30px 0;">
                                    <p style="margin: 0; font-size: 14px; color: #888; font-style: italic;">L'équipe Terraophis</p>
                                </div>
                            </div>
                        </div>
                    `;

                    const token = await auth.currentUser.getIdToken();
                    await fetch('/api/send-email', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({
                            to: email,
                            subject: subject,
                            html: htmlTemplate
                        })
                    });
                    console.log(`✅ Email de statut envoyé à ${email} pour le statut : ${newStatus}`);
                }
            }
        }
        alert("Statut mis à jour avec succès et e-mail envoyé !");
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
    
    // NOUVEAU : Retour aux optgroups classiques (Titres non-sélectionnables)
    let optionsAnimaux = '<optgroup label="▶ ANIMAUX">';
    let optionsMateriels = '<optgroup label="▶ MATÉRIELS & ACCESSOIRES">';
    let optionsPacks = '<optgroup label="▶ KITS & PACKS">';

    categoriesSnap.forEach(catDoc => {
        const cat = catDoc.data();
        
        listHtml += `
            <div class="inventory-item" style="grid-template-columns: 2fr 1fr 1fr 1fr auto; align-items: center;">
                <div><strong>${cat.name}</strong> <span style="font-size:0.8rem; color:#888;">(${catDoc.id})</span></div>
                <div>Type: ${cat.type}</div>
                <div>Lots configurés: [${cat.lots.join(', ')}]</div>
                <div>Affichage: x${cat.defaultDisplayLot || 'Max'}</div>
                <div style="display: flex; gap: 10px;">
                    <button onclick="openEditCategory('${catDoc.id}')" class="btn-buy" style="padding: 6px 12px; font-size: 0.85rem; border-radius: 4px;">Modifier</button>
                    <button onclick="deleteCategory('${catDoc.id}')" class="btn-logout" style="border:none; padding: 6px 12px;">Supprimer</button>
                </div>
            </div>
        `;
        
        const optionHtml = `<option value="${catDoc.id}" data-type="${cat.type}">${cat.name}</option>`;
        
        if (cat.type === 'materiels') {
            optionsMateriels += optionHtml;
        } else if (cat.type === 'packs') {
            optionsPacks += optionHtml;
        } else {
            optionsAnimaux += optionHtml;
        }
    });

    // Fermeture des balises optgroup
    optionsAnimaux += '</optgroup>';
    optionsMateriels += '</optgroup>';
    optionsPacks += '</optgroup>';

    const defaultOption = '<option value="" disabled selected>Choisir une catégorie...</option>';
    const fullOptionsHtml = defaultOption + optionsAnimaux + optionsMateriels + optionsPacks;

    listContainer.innerHTML = listHtml || '<p>Aucune catégorie configurée.</p>';
    if (productCatSelect) productCatSelect.innerHTML = fullOptionsHtml;
    if (editCatSelect) editCatSelect.innerHTML = fullOptionsHtml;
};

window.generatePriceInputs = async (containerId, categoryId, existingPrices = null) => {
    const container = document.getElementById(containerId);
    if (!container || !categoryId) return;

    const catSnap = await getDoc(doc(db, "categories", categoryId));
    if (!catSnap.exists()) return;

    const catData = catSnap.data();
    let lots = catData.lots;
    
    // Sécurité anti-bug. Si la catégorie n'a pas de lots (ou tableau vide), on force un lot de 1.
    if (!lots || lots.length === 0) {
        lots = [1];
    }

    const isPack = catData.type === 'packs';
    // NOUVEAU : On vérifie immédiatement si c'est du matériel
    const isMateriel = catData.type === 'materiels'; 

    container.innerHTML = lots.map(lot => {
        const value = existingPrices && existingPrices[lot] !== undefined ? existingPrices[lot] : '';
        
        const labelText = isPack && lot === 1 ? "Prix de vente du Kit / Pack (€)" : `Prix Lot de ${lot} (€)`;
        const labelColor = isPack ? "#4d5d30" : "var(--accent-brown)";
        
        // NOUVEAU : On applique l'attribut required UNIQUEMENT si ce n'est pas du matériel
        const requiredAttr = isMateriel ? '' : 'required';

        return `
            <div style="flex: 1; min-width: 120px;">
                <label style="font-size:0.8rem; font-weight:700; display:block; margin-bottom:5px; color: ${labelColor};">${labelText}</label>
                <input type="number" class="lot-price-input" data-lot="${lot}" placeholder="Ex: 29.90" step="0.01" value="${value}" ${requiredAttr}>
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
    const defaultDisplayLot = parseInt(document.getElementById('newCatDefaultLot').value) || 1;
    
    const lots = lotsRaw.split(',').map(l => parseInt(l.trim())).filter(l => !isNaN(l));

    if (!id || !name || lots.length === 0) return alert("Veuillez remplir correctement tous les champs.");

    await setDoc(doc(db, "categories", id), { name, type, lots, defaultDisplayLot });
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
        document.getElementById('editCatDefaultLot').value = cat.defaultDisplayLot || 1;
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
    const defaultDisplayLot = parseInt(document.getElementById('editCatDefaultLot').value) || 1;
    
    const lots = lotsRaw.split(',').map(l => parseInt(l.trim())).filter(l => !isNaN(l));

    if (!name || lots.length === 0) return alert("Veuillez remplir correctement tous les champs.");

    await updateDoc(doc(db, "categories", id), { name, type, lots, defaultDisplayLot });
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

async function loadAboutPageAdmin() {
    const teamField = document.getElementById('aboutTopTeamText');
    if (!teamField) return;

    try {
        const docSnap = await getDoc(doc(db, "settings", "aboutPage"));
        if (!docSnap.exists()) return;

        const data = docSnap.data();
        document.getElementById('aboutTopTeamText').value = data.topTeamText || '';
        document.getElementById('aboutPassionText').value = data.passionText || '';
        document.getElementById('aboutObjectifText').value = data.objectifText || '';

        // Affichage de la galerie supérieure
        const topGalleryPreview = document.getElementById('aboutTopGalleryPreview');
        const topGallery = data.topGallery || [];
        topGalleryPreview.innerHTML = topGallery.map((url, idx) => `
            <div class="preview-item" style="position:relative; display:inline-block; margin-right:10px;">
                <img src="${url}" style="width:100px; height:70px; object-fit:cover; border-radius:4px;">
                <button type="button" onclick="deleteAboutGalleryImg('topGallery', ${idx})" style="position:absolute; top:-5px; right:-5px; background:#d9534f; color:white; border:none; border-radius:50%; width:18px; height:18px; cursor:pointer; font-size:12px; line-height:15px; text-align:center;">×</button>
            </div>
        `).join('');

        // Affichage de la galerie inférieure
        const bottomGalleryPreview = document.getElementById('aboutBottomGalleryPreview');
        const bottomGallery = data.bottomGallery || [];
        bottomGalleryPreview.innerHTML = bottomGallery.map((url, idx) => `
            <div class="preview-item" style="position:relative; display:inline-block; margin-right:10px;">
                <img src="${url}" style="width:100px; height:70px; object-fit:cover; border-radius:4px;">
                <button type="button" onclick="deleteAboutGalleryImg('bottomGallery', ${idx})" style="position:absolute; top:-5px; right:-5px; background:#d9534f; color:white; border:none; border-radius:50%; width:18px; height:18px; cursor:pointer; font-size:12px; line-height:15px; text-align:center;">×</button>
            </div>
        `).join('');

        // Rendu du gestionnaire de l'équipe
        const teamListContainer = document.getElementById('adminTeamList');
        const members = data.members || [];
        if (members.length === 0) {
            teamListContainer.innerHTML = '<p style="font-size:0.9rem; color:#888; font-style:italic;">Aucun membre configuré.</p>';
        } else {
            teamListContainer.innerHTML = members.map((m, idx) => `
                <div class="inventory-item" style="display:grid; grid-template-columns: 60px 2fr 2fr auto; align-items: center; background: white; padding: 10px; border-radius: 6px; border:1px solid #eee; margin-bottom:8px;">
                    <img src="${m.photo || '../assets/img/placeholder.jpg'}" style="width:45px; height:45px; border-radius:50%; object-fit:cover;">
                    <div><strong>${m.name}</strong></div>
                    <div style="color:#666; font-size:0.9rem;">${m.role}</div>
                    <button type="button" onclick="deleteTeamMember(${idx})" style="padding: 5px 10px; background:#d9534f; color:white; border:none; border-radius:4px; font-size:0.85rem; cursor:pointer;">Supprimer</button>
                </div>
            `).join('');
        }
    } catch (err) {
        console.error("Erreur d'initialisation À Propos :", err);
    }
}


// ==========================================
// NOUVEAU : SYSTÈME DE GESTION DES PACKS
// ==========================================
window.currentBundleItems = []; // Stocke les articles du pack en cours de création

window.toggleBundleBuilder = async (selectElement, builderId) => {
    const builder = document.getElementById(builderId);
    const selectedOption = selectElement.options[selectElement.selectedIndex];
    const type = selectedOption.getAttribute('data-type');

    // NOUVEAU : On cible le champ stock selon si on est dans la création ou l'édition
    const stockInput = builderId === 'bundleBuilder' 
        ? document.querySelector('#productForm input[name="stock"]') 
        : document.getElementById('editStock');

    if (type === 'packs') {
        builder.style.display = 'block';
        // NOUVEAU : On masque le champ stock et on le rend facultatif
        if (stockInput) {
            stockInput.style.display = 'none';
            stockInput.required = false;
            stockInput.value = '0'; // On force à 0 en base de données
        }
        await loadAllProductsForBundle();
    } else {
        builder.style.display = 'none';
        // NOUVEAU : On réaffiche le champ stock
        if (stockInput) {
            stockInput.style.display = ''; // Retour au style par défaut
            stockInput.required = true;
        }
        window.currentBundleItems = [];
        const listEl = document.getElementById('bundleItemsList');
        if (listEl) listEl.innerHTML = '';
    }
};

async function loadAllProductsForBundle() {
    const datalist = document.getElementById('bundleDataList');
    if (datalist.options.length > 0) return; // Évite de recharger si déjà fait

    try {
        const snap = await getDocs(collection(db, "products"));
        let optionsHtml = '';
        
        snap.forEach(docSnap => {
            const p = docSnap.data();
            if (p.bundleItems && p.bundleItems.length > 0) return; // On ne met pas un pack dans un pack
            
            let lots = p.prices ? Object.keys(p.prices).map(Number) : [1];
            
            lots.sort((a, b) => a - b).forEach(lot => {
                // Le texte visible dans la recherche (value) et l'ID caché (data-id)
                optionsHtml += `<option value="${p.name} (Lot de ${lot})" data-id="${docSnap.id}_${lot}"></option>`;
            });
        });
        datalist.innerHTML = optionsHtml;
    } catch (error) {
        console.error("Erreur de chargement des articles pour le pack :", error);
    }
}

window.addBundleItem = (inputId, qtyId, listId) => {
    const input = document.getElementById(inputId);
    const qtyInput = document.getElementById(qtyId);
    const datalist = document.getElementById('bundleDataList');
    
    if (!input.value) return;

    // On cherche l'option exacte que l'utilisateur a cliquée/tapée
    const option = Array.from(datalist.options).find(opt => opt.value === input.value);
    
    if (!option) {
        alert("Veuillez sélectionner un article suggéré dans la liste.");
        return;
    }

    const [productId, lot] = option.getAttribute('data-id').split('_');
    const name = input.value.split(' (Lot')[0]; // Récupère juste le nom
    const qty = parseInt(qtyInput.value);

    window.currentBundleItems.push({
        productId: productId,
        name: name,
        lot: parseInt(lot),
        qty: qty
    });

    // Remise à zéro pour le prochain ajout
    input.value = '';
    qtyInput.value = '1';

    renderBundleItems(listId);
};

window.removeBundleItem = (index, listId) => {
    window.currentBundleItems.splice(index, 1);
    renderBundleItems(listId);
};

function renderBundleItems(listId) {
    const list = document.getElementById(listId);
    list.innerHTML = window.currentBundleItems.map((item, index) => `
        <li style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border-light);">
            <span>${item.qty}x ${item.name} (Lot de ${item.lot})</span>
            <button type="button" onclick="window.removeBundleItem(${index}, '${listId}')" style="color: var(--error-red); border: none; background: none; cursor: pointer; font-weight: bold; font-size: 1.2rem;">&times;</button>
        </li>
    `).join('');
}

// NOUVEAU : Intercepte la validation pour uploader les fichiers dans leurs tableaux respectifs
document.getElementById('aboutPageForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnSubmitAbout');
    const statusText = document.getElementById('aboutStatusMsg');
    const topFiles = document.getElementById('aboutTopGalleryFiles').files;
    const bottomFiles = document.getElementById('aboutBottomGalleryFiles').files;

    try {
        btn.disabled = true;
        statusText.textContent = "Sauvegarde en cours... ⏳";

        const docRef = doc(db, "settings", "aboutPage");
        const docSnap = await getDoc(docRef);
        let currentTopGallery = docSnap.exists() ? (docSnap.data().topGallery || []) : [];
        let currentBottomGallery = docSnap.exists() ? (docSnap.data().bottomGallery || []) : [];

        const token = await auth.currentUser.getIdToken();

        // Envoi des images de la galerie haute
        if (topFiles.length > 0) {
            statusText.textContent = "Téléchargement de la galerie haute... ⏳";
            const uploadData = new FormData();
            for (let i = 0; i < topFiles.length; i++) { uploadData.append('photos', topFiles[i]); }
            
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: uploadData
            });
            if (!response.ok) throw new Error("Échec upload galerie haute");
            const { files: uploadedFiles } = await response.json();
            currentTopGallery = [...currentTopGallery, ...uploadedFiles.map(f => f.url)];
        }

        // Envoi des images de la galerie basse
        if (bottomFiles.length > 0) {
            statusText.textContent = "Téléchargement de la galerie basse... ⏳";
            const uploadData = new FormData();
            for (let i = 0; i < bottomFiles.length; i++) { uploadData.append('photos', bottomFiles[i]); }
            
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: uploadData
            });
            if (!response.ok) throw new Error("Échec upload galerie basse");
            const { files: uploadedFiles } = await response.json();
            currentBottomGallery = [...currentBottomGallery, ...uploadedFiles.map(f => f.url)];
        }

        await setDoc(docRef, {
            topTeamText: document.getElementById('aboutTopTeamText').value.trim(),
            passionText: document.getElementById('aboutPassionText').value.trim(),
            objectifText: document.getElementById('aboutObjectifText').value.trim(),
            topGallery: currentTopGallery,
            bottomGallery: currentBottomGallery
        }, { merge: true });

        statusText.textContent = "✅ Contenu structurel et galeries mis à jour !";
        document.getElementById('aboutTopGalleryFiles').value = '';
        document.getElementById('aboutBottomGalleryFiles').value = '';
        loadAboutPageAdmin();
    } catch (err) {
        console.error(err);
        statusText.textContent = "❌ Erreur : " + err.message;
    } finally {
        btn.disabled = false;
    }
});

// NOUVEAU : Supprime une image d'un tableau spécifique à l'aide de sa clé
window.deleteAboutGalleryImg = async (galleryKey, index) => {
    if (!confirm("Supprimer cette image de la galerie ?")) return;
    try {
        const docRef = doc(db, "settings", "aboutPage");
        const docSnap = await getDoc(docRef);
        const gallery = docSnap.data()[galleryKey] || [];
        
        gallery.splice(index, 1);
        await updateDoc(docRef, { [galleryKey]: gallery });
        loadAboutPageAdmin();
    } catch (e) { console.error(e); }
};

// NOUVEAU : Ajout d'un membre à l'équipe avec photo dédiée
window.addTeamMember = async () => {
    const name = document.getElementById('newMemberName').value.trim();
    const role = document.getElementById('newMemberRole').value.trim();
    const fileInput = document.getElementById('newMemberFile');
    const btn = document.getElementById('btnAddMember');

    if (!name || !role) return alert("Veuillez remplir le nom et le rôle du membre.");

    try {
        btn.disabled = true;
        let photoUrl = '';

        if (fileInput.files.length > 0) {
            const uploadData = new FormData();
            uploadData.append('photos', fileInput.files[0]);
            
            const token = await auth.currentUser.getIdToken();
            const response = await fetch('/api/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: uploadData
            });

            if (!response.ok) throw new Error("Échec du téléversement de la photo de profil");
            const { files: uploadedFiles } = await response.json();
            photoUrl = uploadedFiles[0].url;
        }

        const docRef = doc(db, "settings", "aboutPage");
        const docSnap = await getDoc(docRef);
        const members = docSnap.exists() ? (docSnap.data().members || []) : [];

        members.push({ name, role, photo: photoUrl });
        await setDoc(docRef, { members }, { merge: true });

        // Nettoyage des champs de saisie
        document.getElementById('newMemberName').value = '';
        document.getElementById('newMemberRole').value = '';
        fileInput.value = '';
        
        loadAboutPageAdmin();
        alert("✅ Membre d'équipe ajouté avec succès !");
    } catch (err) {
        console.error(err);
        alert("Erreur lors de l'ajout : " + err.message);
    } finally {
        btn.disabled = false;
    }
};

// NOUVEAU : Suppression d'un membre de l'équipe
window.deleteTeamMember = async (index) => {
    if (!confirm("Voulez-vous retirer ce membre de l'équipe ?")) return;
    try {
        const docRef = doc(db, "settings", "aboutPage");
        const docSnap = await getDoc(docRef);
        const members = docSnap.data().members || [];
        
        members.splice(index, 1);
        await updateDoc(docRef, { members: members });
        loadAboutPageAdmin();
    } catch (e) { console.error(e); }
};

// NOUVEAU : Gestion de l'activation de la page Conseils
async function loadGlobalGuideToggle() {
    const toggle = document.getElementById('globalGuideToggle');
    const statusText = document.getElementById('globalGuideStatus');
    if (!toggle) return;

    try {
        const docSnap = await getDoc(doc(db, "settings", "guidesConfig"));
        if (docSnap.exists()) {
            toggle.checked = docSnap.data().isActive;
        } else {
            toggle.checked = true; // Actif par défaut si jamais configuré
        }

        toggle.addEventListener('change', async (e) => {
            statusText.textContent = "Sauvegarde... ⏳";
            await setDoc(doc(db, "settings", "guidesConfig"), { isActive: e.target.checked }, { merge: true });
            statusText.textContent = "✅ Paramètre mis à jour !";
            setTimeout(() => statusText.textContent = '', 2000);
        });
    } catch (error) {
        console.error("Erreur toggle guides:", error);
    }
}

// NOUVEAU : Fonctions de déplacement et de suppression des images du Hero Slider
window.moveSlider = async (index, direction) => {
    try {
        const docRef = doc(db, "settings", "heroSlider");
        const docSnap = await getDoc(docRef);
        const photos = docSnap.data().photos || [];
        const newIndex = index + direction;
        
        if (newIndex >= 0 && newIndex < photos.length) {
            // On intervertit les deux slides
            [photos[index], photos[newIndex]] = [photos[newIndex], photos[index]];
            await updateDoc(docRef, { photos });
            loadSliderPreview();
        }
    } catch (error) {
        console.error("Erreur lors du déplacement de la slide :", error);
    }
};

window.deleteSliderImg = async (index) => {
    if (!confirm("Voulez-vous vraiment supprimer cette image du slider ?")) return;
    try {
        const docRef = doc(db, "settings", "heroSlider");
        const docSnap = await getDoc(docRef);
        const photos = docSnap.data().photos || [];
        
        // Suppression physique sur R2 si nécessaire
        const photoObj = photos[index];
        const url = typeof photoObj === 'object' ? photoObj.url : photoObj;
        
        if (url) {
            const key = new URL(url).pathname.substring(1);
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

        photos.splice(index, 1);
        await updateDoc(docRef, { photos });
        loadSliderPreview();
    } catch (error) {
        console.error("Erreur suppression de la slide :", error);
    }
};

// Récupère la configuration actuelle des livraisons sur Firestore pour pré-remplir le formulaire d'administration
async function loadShippingConfig() {
    try {
        const docRef = doc(db, "config", "shipping");
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            const data = docSnap.data();
            
            if (document.getElementById('shippingColissimo')) {
                document.getElementById('shippingColissimo').value = data.colissimo ?? '';
            }
            if (document.getElementById('shippingChrono13')) {
                document.getElementById('shippingChrono13').value = data.chrono13 ?? '';
            }
            if (document.getElementById('shippingThreshold')) {
                document.getElementById('shippingThreshold').value = data.threshold ?? '';
            }
            if (document.getElementById('shippingHeatPack')) {
                document.getElementById('shippingHeatPack').value = data.heatPack ?? '';
            }
        }
    } catch (error) {
        console.error("Erreur lors de la récupération des tarifs de livraison :", error);
    }
}

// Intercepte la soumission du formulaire pour enregistrer les nouveaux tarifs et le seuil dans Firestore
document.getElementById('shippingConfigForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    
    btn.disabled = true;
    btn.textContent = "ENREGISTREMENT... ⏳";

    const colissimo = parseFloat(document.getElementById('shippingColissimo').value);
    const chrono13 = parseFloat(document.getElementById('shippingChrono13').value);
    const threshold = parseFloat(document.getElementById('shippingThreshold').value);
    const heatPack = parseFloat(document.getElementById('shippingHeatPack').value);

    try {
        await setDoc(doc(db, "config", "shipping"), {
            colissimo,
            chrono13,
            threshold,
            heatPack
        }, { merge: true });
        
        alert("La configuration des livraisons a été mise à jour avec succès !");
    } catch (error) {
        console.error("Erreur lors de la sauvegarde de la configuration :", error);
        alert("Une erreur est survenue lors de l'enregistrement des tarifs.");
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
});

