// =========================================================
// ADMIN > QR CODES PERMANENTS
// Chaque QR imprimé pointe vers /qr/<code> sur ce site ; la destination se modifie ici.
// Données : settings/qrCodes (liens) et settings/qrStats (nombre de scans, tenu par le serveur).
// =========================================================
import { db, auth } from '../firebase-config.js';
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const ADMIN_EMAILS = ["martin.stuis11@gmail.com", "terra.ophis@gmail.com"];
const QR_LIB = 'vendor/qrcode-generator-1.4.4.js'; // copie locale (licence MIT) : aucune dépendance externe
const LOGOS = {
    'terra-ophis': { label: 'Logo Terra Ophis', file: '../assets/img/qr/terra-ophis.svg' },
    'terra-mustela': { label: 'Logo Terra Mustela', file: '../assets/img/qr/terra-mustela.svg' },
    '': { label: 'Sans logo' }
};
// Valeurs par défaut identiques à celles du serveur (server.js > QR_DEFAULTS)
const DEFAULT_LINKS = {
    ophis: { label: 'Terra Ophis — boutique & conseils', url: 'https://terraophis.fr/', logo: 'terra-ophis' },
    mustela: { label: 'Terra Mustela — élevage de furets', url: 'https://www.instagram.com/terra.mustela/', logo: 'terra-mustela' }
};
const PUBLIC_ORIGIN = 'https://terraophis.fr';

const root = document.getElementById('qrRoot');
let links = {};
let stats = {};
let ready = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = (msg, type) => (window.notify ? window.notify(msg, type) : alert(msg));
const shortUrl = (code) => `${PUBLIC_ORIGIN}/qr/${code}`;

function loadQrLib() {
    if (window.qrcode) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = QR_LIB;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Bibliothèque QR indisponible'));
        document.head.appendChild(s);
    });
}

// QR vectoriel (correction H : jusqu'à 30 % du code peut être masqué par le logo)
async function buildQrSvg(code, logoKey) {
    await loadQrLib();
    const qr = window.qrcode(0, 'H');
    qr.addData(shortUrl(code));
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    const size = n + quiet * 2;
    const logo = LOGOS[logoKey]?.file;
    const c = n / 2;
    const r = logo ? n * 0.135 : 0;
    let d = '';
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            if (!qr.isDark(y, x)) continue;
            if (logo && Math.hypot(x + 0.5 - c, y + 0.5 - c) < r + 0.9) continue;
            d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
        }
    }
    let logoSvg = '';
    if (logo) {
        const src = await (await fetch(logo)).text();
        const [, vw, vh] = src.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
        const inner = src.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
        const w = r * 1.55;
        const s = w / Math.max(vw, vh);
        const cx = quiet + c;
        logoSvg = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="#fbf7ec"/>`
            + `<g transform="translate(${cx - vw * s / 2} ${cx - vh * s / 2}) scale(${s})">${inner}</g>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 10}" height="${size * 10}" shape-rendering="crispEdges">`
        + `<rect width="${size}" height="${size}" fill="#ffffff"/><path fill="#2f2418" d="${d}"/>${logoSvg}</svg>`;
}

function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function downloadPng(code, logoKey) {
    const svg = await buildQrSvg(code, logoKey);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1200;
    canvas.getContext('2d').drawImage(img, 0, 0, 1200, 1200);
    canvas.toBlob(blob => download(`qr-${code}.png`, blob, 'image/png'));
}

function render() {
    const rows = Object.entries(links).map(([code, l]) => `
        <div class="qr-row" data-code="${esc(code)}">
            <div class="qr-preview" data-preview="${esc(code)}">⏳</div>
            <div class="qr-fields">
                <div class="qr-head">
                    <strong>${esc(l.label || code)}</strong>
                    <span class="qr-scans">${stats[code] || 0} scan${(stats[code] || 0) > 1 ? 's' : ''}</span>
                </div>
                <div class="qr-short">QR imprimé : <code>${esc(shortUrl(code))}</code></div>
                <label>Nom</label>
                <input type="text" data-field="label" value="${esc(l.label)}">
                <label>Destination (où le QR emmène)</label>
                <input type="url" data-field="url" value="${esc(l.url)}" placeholder="https://…">
                <label>Logo au centre</label>
                <select data-field="logo">${Object.entries(LOGOS).map(([k, v]) => `<option value="${k}" ${k === (l.logo || '') ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
                <div class="qr-actions">
                    <a class="btn-outline" href="${esc(shortUrl(code))}" target="_blank" rel="noopener">Tester ↗</a>
                    <button type="button" class="btn-outline" data-dl="svg">Télécharger SVG</button>
                    <button type="button" class="btn-outline" data-dl="png">Télécharger PNG</button>
                    ${DEFAULT_LINKS[code] ? '' : '<button type="button" class="btn-logout" data-del>Supprimer</button>'}
                </div>
            </div>
        </div>`).join('');

    root.innerHTML = `
        <section class="admin-section">
            <div class="section-header"><h2>🔳 QR codes permanents</h2></div>
            <p class="qr-intro">Les QR codes imprimés (cartes de visite, étiquettes…) mènent vers une adresse courte de ce site, puis redirigent vers la destination choisie ici.
            Vous pouvez changer la destination à tout moment : <strong>les QR déjà imprimés restent valables</strong>. Ne supprimez jamais un code déjà imprimé.</p>
            <div class="qr-list">${rows}</div>
            <div class="qr-new">
                <h3>Nouveau QR code</h3>
                <div class="qr-new-grid">
                    <input type="text" id="qrNewCode" placeholder="code (ex : salon-2027)">
                    <input type="text" id="qrNewLabel" placeholder="Nom (ex : Stand salon 2027)">
                    <input type="url" id="qrNewUrl" placeholder="Destination https://…">
                    <button type="button" class="btn-outline" id="qrAdd">Ajouter</button>
                </div>
            </div>
            <button type="button" class="btn-buy" id="qrSave" style="margin-top:20px;width:100%">ENREGISTRER LES DESTINATIONS</button>
            <p class="qr-intro" style="margin-top:10px">Une modification met jusqu'à 1 minute à s'appliquer sur les QR scannés.</p>
        </section>`;

    root.querySelectorAll('.qr-row').forEach(row => {
        const code = row.dataset.code;
        row.querySelectorAll('[data-field]').forEach(input => input.addEventListener('input', () => {
            links[code][input.dataset.field] = input.value.trim();
            if (input.dataset.field === 'logo') preview(code);
        }));
        row.querySelector('[data-dl="svg"]').addEventListener('click', async () => download(`qr-${code}.svg`, await buildQrSvg(code, links[code].logo), 'image/svg+xml'));
        row.querySelector('[data-dl="png"]').addEventListener('click', () => downloadPng(code, links[code].logo));
        row.querySelector('[data-del]')?.addEventListener('click', () => {
            if (!confirm(`Supprimer le QR « ${code} » ? S'il est déjà imprimé, il mènera vers l'accueil du site.`)) return;
            delete links[code];
            render();
        });
        preview(code);
    });

    root.querySelector('#qrAdd').addEventListener('click', () => {
        const code = root.querySelector('#qrNewCode').value.trim().toLowerCase();
        const url = root.querySelector('#qrNewUrl').value.trim();
        if (!/^[a-z0-9-]{2,40}$/.test(code)) return toast('❌ Code invalide : lettres minuscules, chiffres et tirets uniquement.', 'error');
        if (links[code]) return toast('❌ Ce code existe déjà.', 'error');
        if (!/^https?:\/\//.test(url)) return toast('❌ La destination doit commencer par https://', 'error');
        links[code] = { label: root.querySelector('#qrNewLabel').value.trim() || code, url, logo: 'terra-ophis' };
        render();
    });
    root.querySelector('#qrSave').addEventListener('click', save);
}

async function preview(code) {
    const box = root.querySelector(`[data-preview="${CSS.escape(code)}"]`);
    if (!box) return;
    try {
        box.innerHTML = await buildQrSvg(code, links[code].logo);
    } catch (err) {
        box.textContent = '⚠️';
        console.error(err);
    }
}

async function save() {
    for (const [code, l] of Object.entries(links)) {
        if (!/^https?:\/\//.test(l.url || '')) return toast(`❌ Destination invalide pour « ${code} ».`, 'error');
    }
    try {
        await setDoc(doc(db, 'settings', 'qrCodes'), { links, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.email });
        toast('Destinations des QR codes enregistrées ✓');
    } catch (err) {
        console.error(err);
        toast(`❌ Enregistrement impossible : ${err.message}`, 'error');
    }
}

onAuthStateChanged(auth, async (user) => {
    if (ready || !user || !ADMIN_EMAILS.includes(user.email)) return;
    ready = true;
    try {
        const [linksSnap, statsSnap] = await Promise.all([getDoc(doc(db, 'settings', 'qrCodes')), getDoc(doc(db, 'settings', 'qrStats'))]);
        links = JSON.parse(JSON.stringify(DEFAULT_LINKS));
        if (linksSnap.exists()) {
            for (const [code, l] of Object.entries(linksSnap.data().links || {})) links[code] = { ...(links[code] || {}), ...l };
        }
        stats = statsSnap.exists() ? statsSnap.data() : {};
    } catch (err) {
        console.error(err);
        links = JSON.parse(JSON.stringify(DEFAULT_LINKS));
    }
    render();
});
