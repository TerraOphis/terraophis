// =========================================================
// ADMIN > CONTENU DU SITE
// Édition des textes, photos et blocs de toutes les pages, de la FAQ et des liens.
// Tout est enregistré dans Firestore : settings/siteContent (champ "data" en JSON).
// =========================================================
import { db, auth } from '../firebase-config.js';
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import * as DEFAULTS from '../defaults.js';

const ADMIN_EMAILS = ["martin.stuis11@gmail.com", "terra.ophis@gmail.com"];
const contentRef = doc(db, 'settings', 'siteContent');
const SITE_CACHE_KEY = 'to_content_v1'; // même clé que app.js : le site se met à jour tout de suite dans ce navigateur
const UPLOAD_FOLDER = 'site-content';
const DEFAULT_PHOTO = '../assets/img/emblem.png';

const PAGES = [
    { id: 'home', label: 'Accueil', files: ['../index.html'], url: '../' },
    { id: 'boutique', label: 'Boutique', files: ['../boutique.html'], url: '../boutique', hint: 'Les produits se gèrent dans l\'onglet « Produits ».' },
    { id: 'apropos', label: 'À propos', files: ['../about.html'], url: '../about', hint: 'L\'histoire, les galeries et l\'équipe se gèrent dans l\'onglet « Affichage ».' },
    { id: 'conseils', label: 'Conseils', files: ['../conseils.html'], url: '../conseils', hint: 'Les fiches détaillées se gèrent dans l\'onglet « Guides ».' },
    { id: 'layout', label: 'Menu & pied de page', files: ['../components/navbar.html', '../components/footer.html'], url: '../' },
    { id: 'cgv', label: 'CGV', files: ['../cgv.html'], url: '../cgv.html' },
    { id: 'mentions', label: 'Mentions légales', files: ['../mentions-legales.html'], url: '../mentions-legales.html' },
    { id: 'confidentialite', label: 'Confidentialité', files: ['../politique-confidentialite.html'], url: '../politique-confidentialite.html' }
];

const VIEWS = [
    { group: 'Pages' },
    ...PAGES.map(p => ({ id: `page-${p.id}`, label: p.label, page: p })),
    { group: 'Listes & réglages' },
    { id: 'faq', label: 'FAQ (accueil)', url: '../#faq', hint: 'Questions fréquentes affichées en bas de l\'accueil.' },
    { id: 'settings', label: 'Liens & sauvegarde', url: '../', hint: 'Réseaux sociaux, e-mail affiché et sauvegarde du contenu.' }
];

// =========================================================
// ÉTAT
// =========================================================
const clone = (o) => JSON.parse(JSON.stringify(o));
const defaultState = () => ({ texts: {}, images: {}, hidden: {}, faq: clone(DEFAULTS.faq), settings: clone(DEFAULTS.settings) });

let state = defaultState();
let saved = clone(state);
let meta = null;
let currentView = null;
let ready = false;

const isDirty = () => JSON.stringify(state) !== JSON.stringify(saved);
const collectUrls = (s) => new Set(Object.values(s.images || {}));

// =========================================================
// OUTILS DOM
// =========================================================
const root = document.getElementById('cmsRoot');
const $ = (sel) => root.querySelector(sel);

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'value' || k === 'checked') node[k] = v;
        else node.setAttribute(k, v === true ? '' : v);
    }
    children.flat(Infinity).forEach(c => { if (c != null && c !== false) node.append(c); });
    return node;
}

const ICONS = {
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>'
};

const iconBtn = (icon, title, onclick, extra = {}) =>
    el('button', { type: 'button', class: `cms-icon-btn ${extra.class || ''}`, title, 'aria-label': title, html: ICONS[icon] || icon, onclick, disabled: extra.disabled });

const toast = (message, isError = false) => (window.notify ? window.notify(message, isError ? 'error' : 'success') : alert(message));

function changed() {
    const dirty = isDirty();
    $('#cmsSave').disabled = !dirty;
    const st = $('#cmsState');
    st.textContent = dirty ? '● Modifications non enregistrées' : 'Tout est enregistré';
    st.classList.toggle('dirty', dirty);
}

// =========================================================
// CHAMPS
// =========================================================
const cleanHtml = (html) => html.replace(/ style="[^"]*"/g, '').replace(/(<br\s*\/?>|\s)+$/g, '').trim();

function richEditor(value, onChange, { title = false } = {}) {
    const rte = el('div', { class: `cms-rte${title ? ' title' : ''}`, contenteditable: 'true', spellcheck: 'true', html: value });
    rte.addEventListener('input', () => onChange(cleanHtml(rte.innerHTML)));
    rte.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertLineBreak'); }
    });
    rte.addEventListener('paste', (e) => {
        e.preventDefault();
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
    const keepFocus = (fn) => (e) => { e.preventDefault(); rte.focus(); fn(); onChange(cleanHtml(rte.innerHTML)); };
    const tools = [
        el('button', { type: 'button', class: 'cms-icon-btn', title: 'Gras', onmousedown: keepFocus(() => document.execCommand('bold')) }, 'G'),
        el('button', { type: 'button', class: 'cms-icon-btn', title: 'Italique', style: 'font-style:italic', onmousedown: keepFocus(() => document.execCommand('italic')) }, 'I'),
        el('button', {
            type: 'button', class: 'cms-icon-btn', title: 'Lien', html: ICONS.link, onmousedown: keepFocus(() => {
                const url = prompt('Adresse du lien (ex : boutique, conseils ou https://…)');
                if (url) document.execCommand('createLink', false, url);
            })
        })
    ];
    return { rte, tools };
}

async function uploadImage(file) {
    const token = await auth.currentUser.getIdToken();
    const body = new FormData();
    body.append('folderName', UPLOAD_FOLDER);
    body.append('photos', file);
    const res = await fetch('/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data.files[0].url;
}

function imageField(value, onChange, { def = DEFAULT_PHOTO, label = 'Photo' } = {}) {
    let current = value;
    const img = el('img', { alt: '' });
    const preview = el('div', { class: 'cms-img-preview' }, img);
    const input = el('input', { type: 'file', accept: 'image/*', hidden: true });
    const removeBtn = el('button', { type: 'button', class: 'cms-btn cms-btn-danger cms-btn-sm' }, 'Retirer la photo');
    const pickBtn = el('button', { type: 'button', class: 'cms-btn cms-btn-ghost cms-btn-sm', onclick: () => input.click() }, 'Choisir une photo');

    const refresh = () => {
        img.src = current || def;
        img.classList.toggle('default', !current);
        removeBtn.hidden = !current;
        pickBtn.textContent = current ? 'Changer la photo' : 'Choisir une photo';
    };

    input.addEventListener('change', async () => {
        const file = input.files[0];
        input.value = '';
        if (!file) return;
        preview.classList.add('loading');
        pickBtn.disabled = true;
        try {
            current = await uploadImage(file);
            onChange(current);
            refresh();
        } catch (err) {
            console.error(err);
            toast(`❌ Envoi de la photo impossible : ${err.message}`, true);
        } finally {
            preview.classList.remove('loading');
            pickBtn.disabled = false;
        }
    });
    removeBtn.addEventListener('click', () => { current = ''; onChange(''); refresh(); });
    refresh();

    return el('div', {},
        el('span', { class: 'cms-label' }, label),
        el('div', { class: 'cms-img-field' }, preview,
            el('div', { class: 'cms-img-actions' }, pickBtn, removeBtn, el('p', { class: 'cms-hint' }, 'JPG, PNG ou WebP. Redimensionnée automatiquement.')),
            input)
    );
}

function inputField(label, value, onInput, { type = 'text', placeholder = '', hint = '' } = {}) {
    const id = `cms-${Math.random().toString(36).slice(2, 9)}`;
    return el('div', { class: 'cms-input-wrap' },
        el('label', { class: 'cms-label', for: id }, label),
        el('input', { id, type, class: 'cms-input', placeholder, value: value ?? '', oninput: (e) => onInput(e.target.value) }),
        hint && el('p', { class: 'cms-hint' }, hint));
}

function moveItem(list, i, delta) {
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
}

// =========================================================
// PAGES
// =========================================================
const pageCache = new Map();

async function fetchPage(file) {
    if (!pageCache.has(file)) {
        const res = await fetch(file, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`${file} : ${res.status}`);
        pageCache.set(file, await res.text());
    }
    return pageCache.get(file);
}

function labelFor(node) {
    const tag = node.tagName;
    const cls = node.classList;
    const parent = node.parentElement?.classList || { contains: () => false };
    if (tag === 'TITLE') return "Titre de l'onglet (Google)";
    if (tag === 'META') return 'Description (Google)';
    if (parent.contains('btn')) return 'Bouton';
    if (cls.contains('btn-explorer')) return 'Bouton';
    if (parent.contains('trust-chip')) return 'Pastille';
    if (parent.contains('sticker')) return 'Pastille ronde';
    if (parent.contains('hero-badge')) return 'Badge flottant';
    if (parent.contains('marquee-track')) return 'Texte défilant';
    if (parent.contains('stat')) return tag === 'STRONG' ? 'Chiffre (animé)' : 'Légende du chiffre';
    if (cls.contains('eyebrow')) return 'Étiquette';
    if (cls.contains('hand')) return 'Note manuscrite';
    if (tag === 'A') return 'Lien';
    return { H1: 'Titre principal', H2: 'Titre', H3: 'Sous-titre', H4: 'Petit titre', P: 'Texte', LI: 'Élément de liste', SUMMARY: 'Question', FIGCAPTION: 'Légende de la photo', LABEL: 'Libellé' }[tag] || 'Texte';
}

function parseBlocks(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const blocks = [];

    const metaFields = [...parsed.head.querySelectorAll('[data-c]')].map(n => ({
        type: 'plain', key: n.dataset.c, label: labelFor(n),
        def: n.tagName === 'META' ? n.getAttribute('content') : n.textContent
    }));
    if (metaFields.length) blocks.push({ key: null, label: 'Référencement Google', fixed: true, fields: metaFields });

    parsed.querySelectorAll('[data-s]').forEach(b => {
        const seen = new Set();
        const fields = [];
        b.querySelectorAll('[data-c], [data-c-img]').forEach(n => {
            const key = n.dataset.c || n.dataset.cImg;
            if (seen.has(key)) return;
            seen.add(key);
            if (n.dataset.cImg) fields.push({ type: 'image', key, label: 'Photo du bloc', def: '../' + n.getAttribute('src') });
            else fields.push({ type: 'rich', key, label: labelFor(n), def: n.innerHTML.trim(), title: /^H[12]$/.test(n.tagName) });
        });
        blocks.push({ key: b.dataset.s, label: b.dataset.sLabel, fixed: Boolean(b.dataset.sFixed), fields });
    });
    return blocks;
}

const countModified = (block) => block.fields.filter(f => (f.type === 'image' ? state.images[f.key] : state.texts[f.key]) != null).length;

function pageField(field, onCount) {
    const wrap = el('div', { class: 'cms-field' });
    const tag = el('span', { class: 'cms-tag' }, 'Modifié');
    const isSet = () => (field.type === 'image' ? state.images[field.key] : state.texts[field.key]) != null;
    const refreshTag = () => { tag.hidden = !isSet(); onCount(); };

    if (field.type === 'image') {
        wrap.append(imageField(state.images[field.key] || '', (url) => {
            if (url) state.images[field.key] = url; else delete state.images[field.key];
            refreshTag();
            changed();
        }, { def: field.def, label: field.label }));
        refreshTag();
        return wrap;
    }

    const setValue = (v) => {
        const normalized = field.type === 'plain' ? v.trim() : v;
        const def = field.type === 'plain' ? field.def.trim() : cleanHtml(field.def);
        if (normalized === def) delete state.texts[field.key]; else state.texts[field.key] = normalized;
        refreshTag();
        changed();
    };

    let editor, tools = [];
    if (field.type === 'plain') {
        editor = el('textarea', { class: 'cms-input', rows: field.label.startsWith('Description') ? 3 : 1, value: state.texts[field.key] ?? field.def, oninput: (e) => setValue(e.target.value) });
    } else {
        ({ rte: editor, tools } = richEditor(state.texts[field.key] ?? field.def, setValue, { title: field.title }));
    }

    const resetBtn = iconBtn('reset', 'Revenir au texte d\'origine', () => {
        delete state.texts[field.key];
        if (field.type === 'plain') editor.value = field.def; else editor.innerHTML = field.def;
        refreshTag();
        changed();
    });

    wrap.append(
        el('div', { class: 'cms-field-head' },
            el('span', { class: 'cms-label' }, field.label), tag,
            el('div', { class: 'cms-field-tools' }, tools, resetBtn)),
        editor);
    refreshTag();
    return wrap;
}

function blockCard(block, open) {
    const count = el('span', { class: 'cms-count' });
    const updateCount = () => {
        const n = countModified(block);
        count.textContent = n ? `${n} modifié${n > 1 ? 's' : ''}` : `${block.fields.length} champ${block.fields.length > 1 ? 's' : ''}`;
        count.classList.toggle('mod', n > 0);
    };

    const card = el('section', { class: `cms-blk${open ? ' open' : ''}` });
    const head = el('div', { class: 'cms-blk-head', onclick: () => card.classList.toggle('open') },
        el('span', { class: 'cms-chev', html: ICONS.chev }), el('h3', {}, block.label), count);

    if (!block.fixed && block.key) {
        const checkbox = el('input', { type: 'checkbox', checked: !state.hidden[block.key] });
        const text = el('span', {}, 'Affiché');
        const sw = el('label', { class: 'cms-switch', title: 'Afficher ou masquer ce bloc sur le site', onclick: (e) => e.stopPropagation() }, checkbox, el('i'), text);
        const sync = () => { card.classList.toggle('is-hidden', !checkbox.checked); text.textContent = checkbox.checked ? 'Affiché' : 'Masqué'; };
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) delete state.hidden[block.key]; else state.hidden[block.key] = true;
            sync();
            changed();
        });
        sync();
        head.append(sw);
    }

    card.append(head, el('div', { class: 'cms-blk-body' },
        block.fields.length ? block.fields.map(f => pageField(f, updateCount)) : el('p', { class: 'cms-hint' }, 'Ce bloc n\'a pas de texte modifiable ici : vous pouvez seulement l\'afficher ou le masquer.')));
    updateCount();
    return card;
}

async function renderPageView(page, container) {
    container.append(el('p', { class: 'cms-empty' }, 'Chargement de la page…'));
    const blocks = (await Promise.all(page.files.map(fetchPage))).flatMap(parseBlocks);
    container.innerHTML = '';
    if (page.hint) container.append(el('p', { class: 'cms-note' }, 'ℹ️ ' + page.hint));
    blocks.forEach((b, i) => container.append(blockCard(b, i === (blocks[0].key ? 0 : 1))));
}

// =========================================================
// FAQ
// =========================================================
function renderFaqView(container) {
    const list = state.faq;
    container.append(el('div', { class: 'cms-toolbar' },
        el('p', {}, `${list.length} question${list.length > 1 ? 's' : ''}.`),
        el('button', { type: 'button', class: 'cms-btn cms-btn-leaf', onclick: () => { list.push({ question: 'Nouvelle question ?', reponse: '<p>Votre réponse…</p>' }); changed(); render(); } }, '+ Ajouter une question')));

    list.forEach((item, i) => {
        const { rte, tools } = richEditor(item.reponse, (v) => { item.reponse = v; changed(); });
        container.append(el('section', { class: 'cms-panel cms-faq-item' },
            el('div', { class: 'cms-stack' },
                inputField('Question', item.question, (v) => { item.question = v; changed(); }),
                el('div', { class: 'cms-field', style: 'padding:0;border:none' },
                    el('div', { class: 'cms-field-head' }, el('span', { class: 'cms-label' }, 'Réponse'), el('div', { class: 'cms-field-tools' }, tools)),
                    rte)),
            el('div', { class: 'cms-side-actions' },
                iconBtn('up', 'Monter', () => { moveItem(list, i, -1); changed(); render(); }, { disabled: i === 0 }),
                iconBtn('down', 'Descendre', () => { moveItem(list, i, 1); changed(); render(); }, { disabled: i === list.length - 1 }),
                iconBtn('trash', 'Supprimer', () => { if (confirm('Supprimer cette question ?')) { list.splice(i, 1); changed(); render(); } }, { class: 'danger' }))));
    });
}

// =========================================================
// LIENS & SAUVEGARDE
// =========================================================
function renderSettingsView(container) {
    const s = state.settings;
    const last = meta?.updatedAt?.toDate
        ? `Dernier enregistrement le ${meta.updatedAt.toDate().toLocaleString('fr-FR')} par ${meta.updatedBy}.`
        : 'Aucun contenu enregistré pour le moment : le site affiche le contenu d\'origine.';

    const download = () => {
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `terraophis-contenu-${new Date().toISOString().slice(0, 10)}.json` });
        a.click();
        URL.revokeObjectURL(a.href);
    };

    const fileInput = el('input', { type: 'file', accept: 'application/json', hidden: true });
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (!confirm('Remplacer tout le contenu actuel par cette sauvegarde ? (rien n\'est publié tant que vous n\'enregistrez pas)')) return;
            state = { ...defaultState(), ...data };
            changed();
            render();
            toast('Sauvegarde chargée : vérifiez puis enregistrez.');
        } catch {
            toast('❌ Fichier de sauvegarde invalide.', true);
        }
    });

    const resetAll = () => {
        if (!confirm('Remettre TOUS les textes, photos et la FAQ à leur contenu d\'origine ? Rien n\'est publié tant que vous n\'enregistrez pas.')) return;
        state = defaultState();
        changed();
        render();
    };

    container.append(
        el('section', { class: 'cms-panel' },
            el('h3', {}, 'Liens'),
            inputField('Lien Instagram', s.instagram, (v) => { s.instagram = v.trim(); changed(); }, { type: 'url', placeholder: 'https://www.instagram.com/…' }),
            inputField('Lien Facebook', s.facebook, (v) => { s.facebook = v.trim(); changed(); }, { type: 'url', placeholder: 'https://www.facebook.com/…', hint: 'Laissez vide pour masquer l\'icône Facebook.' }),
            inputField('E-mail affiché', s.email, (v) => { s.email = v.trim(); changed(); }, { type: 'email', placeholder: 'contact@…', hint: 'Icône e-mail du pied de page. Laissez vide pour la masquer.' })),
        el('section', { class: 'cms-panel' },
            el('h3', {}, 'Sauvegarde'),
            el('p', { class: 'cms-hint' }, last),
            el('div', { class: 'cms-row' },
                el('button', { type: 'button', class: 'cms-btn cms-btn-ghost', onclick: download }, 'Télécharger une sauvegarde'),
                el('button', { type: 'button', class: 'cms-btn cms-btn-ghost', onclick: () => fileInput.click() }, 'Restaurer une sauvegarde'),
                el('button', { type: 'button', class: 'cms-btn cms-btn-danger', onclick: resetAll }, 'Tout remettre par défaut'),
                fileInput)));
}

// =========================================================
// NAVIGATION INTERNE
// =========================================================
async function render(viewId = currentView) {
    const view = VIEWS.find(v => v.id === viewId) || VIEWS.find(v => v.id);
    const container = $('#cmsContent');
    const scroll = currentView === view.id ? window.scrollY : null;
    currentView = view.id;

    root.querySelectorAll('.cms-side-link').forEach(b => b.classList.toggle('active', b.dataset.view === view.id));
    $('#cmsTitle').textContent = view.page ? `Page « ${view.label} »` : view.label;
    $('#cmsHint').textContent = view.page ? 'Cliquez sur un bloc pour modifier ses textes et photos.' : view.hint || '';
    $('#cmsViewSite').href = view.page?.url || view.url || '../';

    container.innerHTML = '';
    try {
        if (view.page) await renderPageView(view.page, container);
        else if (view.id === 'faq') renderFaqView(container);
        else if (view.id === 'settings') renderSettingsView(container);
    } catch (err) {
        console.error(err);
        container.innerHTML = '';
        container.append(el('p', { class: 'cms-empty' }, `Impossible de charger cette section : ${err.message}`));
    }
    if (scroll != null) window.scrollTo(0, scroll);
}

function buildShell() {
    root.innerHTML = '';
    const side = el('aside', { class: 'cms-side' }, VIEWS.map(v => v.group
        ? el('div', { class: 'cms-side-group' }, v.group)
        : el('button', { type: 'button', class: 'cms-side-link', 'data-view': v.id, onclick: () => { render(v.id); root.scrollIntoView({ behavior: 'smooth' }); } }, v.label)));

    root.append(
        el('div', { class: 'cms-bar', id: 'cmsBar' },
            el('div', { class: 'cms-bar-title' }, el('h2', { id: 'cmsTitle' }), el('p', { id: 'cmsHint' })),
            el('div', { class: 'cms-bar-actions' },
                el('span', { class: 'cms-state', id: 'cmsState' }),
                el('a', { class: 'cms-btn cms-btn-ghost', id: 'cmsViewSite', href: '../', target: '_blank' }, 'Voir la page ↗'),
                el('button', { type: 'button', class: 'cms-btn cms-btn-primary', id: 'cmsSave', disabled: true, onclick: save }, 'Enregistrer'))),
        el('div', { class: 'cms-layout' }, side, el('div', { class: 'cms-content', id: 'cmsContent' })));

    // La barre d'enregistrement reste visible sous la navigation de l'admin
    const nav = document.getElementById('adminNav');
    const syncTop = () => { $('#cmsBar').style.top = `${nav?.offsetHeight || 0}px`; };
    window.addEventListener('resize', syncTop);
    new MutationObserver(syncTop).observe(document.getElementById('tab-contenu'), { attributes: true, attributeFilter: ['style'] });
    syncTop();
}

// =========================================================
// CHARGEMENT / ENREGISTREMENT
// =========================================================
async function loadContent() {
    const snap = await getDoc(contentRef);
    state = defaultState();
    if (snap.exists()) {
        const data = snap.data();
        meta = { updatedAt: data.updatedAt, updatedBy: data.updatedBy };
        try { Object.assign(state, JSON.parse(data.data || '{}')); } catch (err) { console.error('Contenu illisible :', err); }
    }
    saved = clone(state);
    changed();
}

async function save() {
    if (!isDirty()) return;
    const btn = $('#cmsSave');
    btn.disabled = true;
    btn.textContent = 'Enregistrement…';
    try {
        const raw = JSON.stringify(state);
        await setDoc(contentRef, { data: raw, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.email });

        const stillUsed = collectUrls(state);
        const removed = [...collectUrls(saved)].filter(u => !stillUsed.has(u));
        saved = clone(state);
        meta = { updatedAt: { toDate: () => new Date() }, updatedBy: auth.currentUser.email };
        try { localStorage.setItem(SITE_CACHE_KEY, raw); } catch { /* stockage indisponible */ }
        toast('Contenu enregistré et publié ✓');

        // Nettoyage des photos retirées (uniquement celles envoyées depuis cet onglet)
        const keys = removed
            .map(url => { try { return decodeURIComponent(new URL(url).pathname.slice(1)); } catch { return ''; } })
            .filter(k => k.startsWith(`${UPLOAD_FOLDER}/`));
        if (keys.length) {
            auth.currentUser.getIdToken()
                .then(token => fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ keys }) }))
                .catch(err => console.warn('Nettoyage des anciennes photos impossible :', err));
        }
    } catch (err) {
        console.error(err);
        toast(err.code === 'permission-denied'
            ? '❌ Enregistrement refusé : droits administrateur requis.'
            : `❌ Erreur d'enregistrement : ${err.message}`, true);
    } finally {
        btn.textContent = 'Enregistrer';
        changed();
    }
}

// =========================================================
// DÉMARRAGE
// =========================================================
onAuthStateChanged(auth, async (user) => {
    if (ready || !user || !ADMIN_EMAILS.includes(user.email)) return;
    ready = true;
    buildShell();
    try {
        await loadContent();
    } catch (err) {
        console.error(err);
        toast(`❌ Lecture du contenu impossible : ${err.message}`, true);
    }
    render(VIEWS.find(v => v.id).id);
});

document.addEventListener('keydown', (e) => {
    const tab = document.getElementById('tab-contenu');
    if (ready && tab?.style.display !== 'none' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
    }
});

window.addEventListener('beforeunload', (e) => {
    if (ready && isDirty()) e.preventDefault();
});
