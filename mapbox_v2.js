/**
 * ============================================
 * CARTOGRAPHIE MCF V2 — CLUSTERING + LEGEND TOGGLES
 * ============================================
 * - Clustering natif Mapbox GL
 * - Icônes custom (école = bâtiment, moniteur = vélo)
 * - Couleur cluster interpolée (ratio école/moniteur)
 * - Légende cliquable = toggle d'affichage
 * - Fiche synthétique + tracking
 * - Filtres disciplines / prestations / tests MCF
 * ============================================
 */

// ==========================================
// CONFIG & STATE
// ==========================================
var locations = [];
var filteredGeoJSON = null;
var activeResult = null;
var debounceTimer = null;
var currentPopup = null;
var initZoom = 6;
var flyZoom = 12;
var layersReady = false;

// Toggle state: which types are visible
var showEcoles = true;
var showMoniteurs = true;

// Bornes France métropolitaine
var FRANCE_BOUNDS = { minLng: -5.5, maxLng: 10.0, minLat: 41.0, maxLat: 51.5 };
var mapBounds = [[FRANCE_BOUNDS.minLng, FRANCE_BOUNDS.minLat], [FRANCE_BOUNDS.maxLng, FRANCE_BOUNDS.maxLat]];

// Couleurs
var COLOR_ECOLE = '#D4AF37';
var COLOR_ECOLE_DARK = '#B8960C';
var COLOR_MONITEUR = '#00A0E1';
var COLOR_MONITEUR_DARK = '#0077b6';
var COLOR_TEXT_ECOLE = '#3a3a3a';

// ==========================================
// FILTERS DATA
// ==========================================
var filtersData = [
    {
        title: "Disciplines", id: "discipline",
        data: {
            "BMX": "fas fa-bicycle", "FatBike": "fa-solid fa-motorcycle",
            "Gravel": "fas fa-road", "Mobilité/Remise en selle": "fa-solid fa-vest-patches",
            "Route": "fas fa-route", "Trial": "fa-solid fa-person-biking-mountain",
            "VTT": "fas fa-biking", "VTT Descente": "fas fa-biking",
            "VTT Enduro": "fas fa-biking", "VTT Electrique": "fas fa-biking"
        }
    },
    {
        title: "Type de Prestation", id: "prestation",
        data: {
            "Cours particuliers": "fas fa-chalkboard-teacher", "Format Club": "fas fa-users",
            "Formation": "fas fa-book", "Randonnée/Balade": "fas fa-hiking",
            "Stage": "fas fa-calendar-alt", "Séminaire": "fas fa-briefcase",
            "Voyage à vélo": "fa-solid fa-plane"
        }
    },
    {
        title: "Tests MCF", id: "test_mcf",
        data: {
            "Loupiot-Biclou": "fa-solid fa-child",
            "Bikers": "fa-solid fa-person-biking",
            "Rocket-Gachette": "fa-solid fa-rocket"
        }
    }
];

// ==========================================
// TRACKING + POSTMESSAGE MODULE
// ==========================================
// MODE DE TRACKING :
//   'proxy'  → appelle un Cloudflare Worker (seul mode fonctionnel)
//   L'API OHME bloque les appels CORS depuis le navigateur,
//   un proxy serveur est obligatoire.
var TRACKING_MODE = 'proxy';

// URL du Cloudflare Worker (remplace tracking.php)
// Déploie cloudflare-worker-tracking.js sur Cloudflare Workers
// puis remplace cette URL par l'URL de ton Worker
var TRACKING_PROXY_URL = 'https://mcf-tracking.YOUR-SUBDOMAIN.workers.dev/track';

var SQUARESPACE_ORIGIN = 'https://www.moniteurcycliste.com';

var MCFTracking = {

    // Envoie un postMessage au parent Squarespace pour préremplir le formulaire
    notifyParent: function(location) {
        try {
            window.parent.postMessage({
                type: 'MCF_MONITEUR_SELECTED',
                payload: {
                    moniteur_id: location.code_ohme_id || location.code,
                    code_mcf: location.code,
                    nom_complet: (location.name || '').trim()
                }
            }, SQUARESPACE_ORIGIN);
        } catch (e) {
            console.warn('[MCF] postMessage failed:', e);
        }
    },

    // Envoie le tracking via le Cloudflare Worker (mode proxy)
    _trackViaProxy: function(location, eventType) {
        var payload = {
            event_type: eventType || 'pin_click',
            code_ohme_id: location.code_ohme_id,
            code_mcf: location.code,
            nom_complet: (location.name || '').trim(),
            type_structure: location.ecole ? 'ecole' : 'moniteur',
            timestamp: new Date().toISOString()
        };

        // sendBeacon (fire-and-forget, survit à la navigation)
        try {
            var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
            if (navigator.sendBeacon) {
                navigator.sendBeacon(TRACKING_PROXY_URL, blob);
                return;
            }
        } catch (e) {}

        // Fallback fetch
        try {
            fetch(TRACKING_PROXY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true
            }).catch(function(err) {
                console.warn('[MCF] Tracking proxy error:', err);
            });
        } catch (e) {}
    },

    // Point d'entrée tracking — envoie au Cloudflare Worker
    trackEvent: function(location, eventType) {
        if (!location.code_ohme_id) {
            console.warn('[MCF] Tracking skipped: pas de code_ohme_id');
            return;
        }
        this._trackViaProxy(location, eventType);
    },

    // Clic sur un pin → tracking OHME + postMessage parent
    trackPinClick: function(location) {
        this.trackEvent(location, 'pin_click');
        this.notifyParent(location);
    },

    // Clic sur "Voir les coordonnées" → tracking OHME séparé
    trackCoordClick: function(location) {
        this.trackEvent(location, 'coord_click');
        this.notifyParent(location);
    }
};

// ==========================================
// UTILS
// ==========================================
function getUrlParameter(name) {
    return new URLSearchParams(window.location.search).get(name);
}
function normalizeText(text) {
    return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function debounce(fn, delay) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fn, delay);
}
function isInMetropolitanFrance(lng, lat) {
    return lng >= FRANCE_BOUNDS.minLng && lng <= FRANCE_BOUNDS.maxLng &&
           lat >= FRANCE_BOUNDS.minLat && lat <= FRANCE_BOUNDS.maxLat;
}
function parseCoords(loc) {
    var parts = loc.position.split(',');
    if (parts.length !== 2) return null;
    var lng = parseFloat(parts[0]);
    var lat = parseFloat(parts[1]);
    if (isNaN(lng) || isNaN(lat)) return null;
    return [lng, lat];
}

// ==========================================
// CREATE MARKER PIN IMAGES (Canvas) — flat, no icons
// ==========================================
function createMarkerIcon(color, darkColor, iconType, size) {
    size = size || 40;
    var w = size;
    var h = size + 10;
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');

    var cx = w / 2;
    var cy = w / 2;
    var r = w * 0.42;

    // Shadow
    ctx.beginPath();
    ctx.arc(cx, cy + 2, r + 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fill();

    // Main circle — flat gradient
    var grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, darkColor);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // White border
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();

    // Arrow
    var arrowY = cy + r - 1;
    ctx.beginPath();
    ctx.moveTo(cx - 6, arrowY);
    ctx.lineTo(cx, arrowY + 8);
    ctx.lineTo(cx + 6, arrowY);
    ctx.closePath();
    ctx.fillStyle = darkColor;
    ctx.fill();

    // École: school building icon (white)
    if (iconType === 'ecole') {
        var s = r * 0.55; // icon scale
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Base building
        var bx = cx - s * 0.65;
        var by = cy - s * 0.15;
        var bw2 = s * 1.3;
        var bh2 = s * 0.75;
        ctx.fillRect(bx, by, bw2, bh2);

        // Roof (triangle)
        ctx.beginPath();
        ctx.moveTo(cx, cy - s * 0.7);
        ctx.lineTo(bx - s * 0.1, by + 1);
        ctx.lineTo(bx + bw2 + s * 0.1, by + 1);
        ctx.closePath();
        ctx.fill();

        // Door (dark gold/blue)
        ctx.fillStyle = darkColor;
        ctx.fillRect(cx - s * 0.12, by + bh2 * 0.4, s * 0.24, bh2 * 0.6);

        // Windows
        var winS = s * 0.17;
        ctx.fillRect(bx + s * 0.15, by + bh2 * 0.2, winS, winS);
        ctx.fillRect(bx + bw2 - s * 0.15 - winS, by + bh2 * 0.2, winS, winS);
    }

    var imgData = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: new Uint8Array(imgData.data.buffer) };
}

// ==========================================
// CLUSTER BUBBLE IMAGES (flat gold / blue)
// ==========================================
function createClusterBubble(type, diameter) {
    var d = diameter;
    var canvas = document.createElement('canvas');
    canvas.width = d;
    canvas.height = d;
    var ctx = canvas.getContext('2d');
    var cx = d / 2;
    var cy = d / 2;
    var r = d / 2 - 2;

    // Shadow
    ctx.beginPath();
    ctx.arc(cx + 1, cy + 1.5, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fill();

    if (type === 'gold') {
        // Flat gold gradient
        var grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
        grad.addColorStop(0, '#FFD700');
        grad.addColorStop(0.5, '#DAA520');
        grad.addColorStop(1, '#B8860B');
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // Thin dark gold border
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#8B6914';
        ctx.stroke();

    } else {
        // Flat blue gradient
        var grad2 = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
        grad2.addColorStop(0, '#33C1FF');
        grad2.addColorStop(0.5, '#00A0E1');
        grad2.addColorStop(1, '#0077b6');
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = grad2;
        ctx.fill();

        // White border
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
    }

    var imgData = ctx.getImageData(0, 0, d, d);
    return { width: d, height: d, data: new Uint8Array(imgData.data.buffer) };
}

// ==========================================
// MAPBOX INIT
// ==========================================
mapboxgl.accessToken = 'pk.eyJ1IjoibWNmZ3Jlbm9ibGUiLCJhIjoiY20ya2tlN2NoMDIyOTJxcXlmdHYyeW94cSJ9.U5T1hrXmQtLjFiIlcEM_hw';

var map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v11',
});

map.fitBounds(mapBounds, { padding: 30 });
map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');

// ==========================================
// GEOLOCATION
// ==========================================
function getLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function(pos) {
        var coords = [pos.coords.longitude, pos.coords.latitude];
        var el = document.createElement('div');
        el.className = 'user-location-dot';
        new mapboxgl.Marker(el).setLngLat(coords).addTo(map);
    }, function() {});
}

// ==========================================
// BUILD GEOJSON
// ==========================================
function locationsToGeoJSON(locs) {
    return {
        type: 'FeatureCollection',
        features: locs.map(function(loc) {
            var coords = parseCoords(loc);
            if (!coords) return null;
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: coords },
                properties: {
                    code: loc.code,
                    name: loc.name || '',
                    ecole: loc.ecole === true ? 1 : 0,
                    adresse: loc.adresse || '',
                    cp: loc.cp || '',
                    city: loc.city || '',
                    tel: loc.tel || '',
                    email: loc.email || '',
                    site_internet: loc.site_internet || '',
                    discipline: JSON.stringify(loc.discipline || []),
                    prestation: JSON.stringify(loc.prestation || []),
                    test_mcf: JSON.stringify(loc.test_mcf || []),
                    code_ohme_id: loc.code_ohme_id || ''
                }
            };
        }).filter(Boolean)
    };
}

// ==========================================
// SETUP LAYERS
// ==========================================
function setupMapLayers(geojson) {
    // --- Add custom marker images ---
    var ecoleIcon = createMarkerIcon(COLOR_ECOLE, COLOR_ECOLE_DARK, 'ecole', 40);
    map.addImage('icon-ecole', ecoleIcon);

    var moniteurIcon = createMarkerIcon(COLOR_MONITEUR, COLOR_MONITEUR_DARK, 'moniteur', 28);
    map.addImage('icon-moniteur', moniteurIcon);

    // --- Generate cluster bubble images (gold metallic + blue) ---
    var clusterSizes = [
        { suffix: 'sm', diameter: 40 },
        { suffix: 'md', diameter: 48 },
        { suffix: 'lg', diameter: 60 },
        { suffix: 'xl', diameter: 76 }
    ];

    clusterSizes.forEach(function(s) {
        map.addImage('cluster-gold-' + s.suffix, createClusterBubble('gold', s.diameter));
        map.addImage('cluster-blue-' + s.suffix, createClusterBubble('blue', s.diameter));
    });

    // --- Source avec clustering ---
    map.addSource('locations', {
        type: 'geojson',
        data: geojson,
        cluster: true,
        clusterMaxZoom: 13,
        clusterRadius: 55,
        clusterProperties: {
            ecoleCount: ['+', ['case', ['==', ['get', 'ecole'], 1], 1, 0]],
            moniteurCount: ['+', ['case', ['==', ['get', 'ecole'], 0], 1, 0]]
        }
    });

    // -------- CLUSTERS: gold metallic bubble or blue bubble --------
    map.addLayer({
        id: 'clusters',
        type: 'symbol',
        source: 'locations',
        filter: ['has', 'point_count'],
        layout: {
            'icon-image': [
                'step', ['get', 'point_count'],
                // <20
                ['case', ['>=', ['get', 'ecoleCount'], 1], 'cluster-gold-sm', 'cluster-blue-sm'],
                20,
                ['case', ['>=', ['get', 'ecoleCount'], 1], 'cluster-gold-md', 'cluster-blue-md'],
                50,
                ['case', ['>=', ['get', 'ecoleCount'], 1], 'cluster-gold-lg', 'cluster-blue-lg'],
                100,
                ['case', ['>=', ['get', 'ecoleCount'], 1], 'cluster-gold-xl', 'cluster-blue-xl']
            ],
            'icon-allow-overlap': true,
            'icon-size': 1
        }
    });

    // -------- CLUSTER COUNT --------
    map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'locations',
        filter: ['has', 'point_count'],
        layout: {
            'text-field': '{point_count_abbreviated}',
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-size': [
                'step', ['get', 'point_count'],
                13, 20, 14, 50, 16, 100, 18
            ],
            'text-allow-overlap': true,
            'text-offset': [0, 0.05]
        },
        paint: {
            'text-color': [
                'case',
                ['>=', ['get', 'ecoleCount'], 1], '#3a2800',
                '#fff'
            ],
            'text-halo-color': [
                'case',
                ['>=', ['get', 'ecoleCount'], 1], 'rgba(255,215,0,0.4)',
                'rgba(0,0,0,0.2)'
            ],
            'text-halo-width': 1
        }
    });

    // -------- MONITEURS — en dessous (sort-key=1 = rendu en premier = en dessous) --------
    map.addLayer({
        id: 'moniteur-points',
        type: 'symbol',
        source: 'locations',
        filter: ['all',
            ['!', ['has', 'point_count']],
            ['==', ['get', 'ecole'], 0]
        ],
        layout: {
            'icon-image': 'icon-moniteur',
            'icon-size': 1,
            'icon-allow-overlap': true,
            'icon-anchor': 'bottom',
            'symbol-sort-key': 1
        }
    });

    // -------- ÉCOLES — TOUJOURS AU-DESSUS (sort-key=0 = prioritaire) --------
    map.addLayer({
        id: 'ecole-points',
        type: 'symbol',
        source: 'locations',
        filter: ['all',
            ['!', ['has', 'point_count']],
            ['==', ['get', 'ecole'], 1]
        ],
        layout: {
            'icon-image': 'icon-ecole',
            'icon-size': 1,
            'icon-allow-overlap': true,
            'icon-anchor': 'bottom',
            'symbol-sort-key': 0,
            'symbol-z-order': 'source'
        }
    });

    layersReady = true;

    // ==============================
    // INTERACTIONS
    // ==============================

    // Click école/moniteur — ÉCOLE TOUJOURS PRIORITAIRE
    // Un seul handler unifié pour éviter double-clic quand les pins se superposent
    map.on('click', function(e) {
        // 1. Check clusters first
        var clusterFeats = map.queryRenderedFeatures(e.point, { layers: ['clusters', 'cluster-count'] });
        if (clusterFeats.length > 0) {
            var clustFeat = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
            if (clustFeat.length > 0) {
                var clusterId = clustFeat[0].properties.cluster_id;
                map.getSource('locations').getClusterExpansionZoom(clusterId, function(err, zoom) {
                    if (err) return;
                    map.easeTo({ center: clustFeat[0].geometry.coordinates, zoom: zoom });
                });
            }
            return;
        }

        // 2. Check école first (priorité)
        var ecoleFeats = map.queryRenderedFeatures(e.point, { layers: ['ecole-points'] });
        if (ecoleFeats.length > 0) {
            var props = ecoleFeats[0].properties;
            var loc = findLocationByCode(props.code);
            if (loc) {
                openLocationCard(loc);
                MCFTracking.trackPinClick(loc);
                map.easeTo({ center: ecoleFeats[0].geometry.coordinates, zoom: Math.max(map.getZoom(), flyZoom) });
            }
            return;
        }

        // 3. Then moniteur
        var moniteurFeats = map.queryRenderedFeatures(e.point, { layers: ['moniteur-points'] });
        if (moniteurFeats.length > 0) {
            var props2 = moniteurFeats[0].properties;
            var loc2 = findLocationByCode(props2.code);
            if (loc2) {
                openLocationCard(loc2);
                MCFTracking.trackPinClick(loc2);
                map.easeTo({ center: moniteurFeats[0].geometry.coordinates, zoom: Math.max(map.getZoom(), flyZoom) });
            }
            return;
        }

        // 4. Click on empty map → close card
        closeLocationCard();
    });

    // Cursors
    ['clusters', 'cluster-count', 'ecole-points', 'moniteur-points'].forEach(function(layerId) {
        map.on('mouseenter', layerId, function() { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layerId, function() {
            map.getCanvas().style.cursor = '';
            if (currentPopup) { currentPopup.remove(); currentPopup = null; }
        });
    });

    // Hover tooltips — école prioritaire
    ['ecole-points', 'moniteur-points'].forEach(function(layerId) {
        map.on('mouseenter', layerId, function(e) {
            if (currentPopup) currentPopup.remove();
            // Si on hover un moniteur, vérifier s'il y a une école au même endroit
            var featureToShow = e.features[0];
            if (layerId === 'moniteur-points') {
                var ecoleFeats = map.queryRenderedFeatures(e.point, { layers: ['ecole-points'] });
                if (ecoleFeats.length > 0) {
                    featureToShow = ecoleFeats[0]; // afficher le nom de l'école
                }
            }
            var props = featureToShow.properties;
            var coords = featureToShow.geometry.coordinates.slice();
            currentPopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 20 })
                .setLngLat(coords)
                .setText(props.name)
                .addTo(map);
        });
    });

    // Hover on cluster → show count breakdown
    ['clusters', 'cluster-count'].forEach(function(cid) {
        map.on('mouseenter', cid, function(e) {
            if (currentPopup) currentPopup.remove();
            var features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
            if (!features.length) return;
            var props = features[0].properties;
            var coords = features[0].geometry.coordinates.slice();
            var ecoles = props.ecoleCount || 0;
            var moniteurs = props.moniteurCount || 0;
            var parts = [];
            if (ecoles > 0) parts.push(ecoles + ' école' + (ecoles > 1 ? 's' : ''));
            if (moniteurs > 0) parts.push(moniteurs + ' moniteur' + (moniteurs > 1 ? 's' : ''));
            currentPopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 20 })
                .setLngLat(coords)
                .setText(parts.join(', '))
                .addTo(map);
        });
    });
}

function findLocationByCode(code) {
    for (var i = 0; i < locations.length; i++) {
        if (locations[i].code === code) return locations[i];
    }
    return null;
}

// ==========================================
// LOAD DATA
// ==========================================
map.on('load', function() {
    getLocation();

    fetch('jsonmap.json')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var showParam = getUrlParameter('show');

            locations = data.filter(function(loc) {
                if (showParam === 'ecole' && loc.ecole !== true) return false;
                if (showParam === 'moniteur' && loc.ecole === true) return false;
                var parts = loc.position.split(',');
                if (parts.length !== 2) return false;
                var lng = parseFloat(parts[0]);
                var lat = parseFloat(parts[1]);
                if (isNaN(lng) || isNaN(lat)) return false;
                if (!isInMetropolitanFrance(lng, lat)) return false;
                return true;
            });

            locations.sort(function(a, b) { return (b.ecole === true ? 1 : 0) - (a.ecole === true ? 1 : 0); });
            locations.forEach(function(loc, i) { loc.code = i + 1; });

            var ecoleCount = locations.filter(function(l) { return l.ecole; }).length;
            console.log('[MCF-V2] ✅ ' + locations.length + ' locations (' + ecoleCount + ' écoles, ' + (data.length - locations.length) + ' filtrées)');

            filteredGeoJSON = locationsToGeoJSON(locations);
            setupMapLayers(filteredGeoJSON);
            updateResultCount(locations.length);
        })
        .catch(function(err) { console.error('Erreur chargement JSON:', err); });
});

// ==========================================
// APPLY FILTERS (includes legend toggle)
// ==========================================
function applyFilters() {
    var selectedDisciplines = getCheckedValues('discipline');
    var selectedPrestations = getCheckedValues('prestation');
    var selectedTestsMCF = getCheckedValues('test_mcf');
    var searchTerm = normalizeText(document.getElementById('filter-search').value);

    var filtered = locations.filter(function(loc) {
        // Legend toggle
        if (!showEcoles && loc.ecole === true) return false;
        if (!showMoniteurs && loc.ecole !== true) return false;

        // Search
        if (searchTerm.length > 1) {
            if (calculateRelevanceScore(loc, searchTerm) === 0) return false;
        }
        // Disciplines
        var locDisc = loc.discipline || [];
        if (selectedDisciplines.length > 0) {
            var m = false;
            for (var i = 0; i < selectedDisciplines.length; i++) {
                if (locDisc.indexOf(selectedDisciplines[i]) !== -1) { m = true; break; }
            }
            if (!m) return false;
        }
        // Prestations
        var locPrest = loc.prestation || [];
        if (selectedPrestations.length > 0) {
            var m2 = false;
            for (var j = 0; j < selectedPrestations.length; j++) {
                if (locPrest.indexOf(selectedPrestations[j]) !== -1) { m2 = true; break; }
            }
            if (!m2) return false;
        }
        // Tests MCF
        var locTests = loc.test_mcf || [];
        if (selectedTestsMCF.length > 0) {
            var m3 = false;
            for (var k = 0; k < selectedTestsMCF.length; k++) {
                if (locTests.indexOf(selectedTestsMCF[k]) !== -1) { m3 = true; break; }
            }
            if (!m3) return false;
        }
        return true;
    });

    filteredGeoJSON = locationsToGeoJSON(filtered);
    var source = map.getSource('locations');
    if (source) source.setData(filteredGeoJSON);
    updateResultCount(filtered.length);
}

function getCheckedValues(groupId) {
    var cbs = document.querySelectorAll('.filter-cb[data-group="' + groupId + '"]:checked');
    var vals = [];
    cbs.forEach(function(cb) { vals.push(cb.value); });
    return vals;
}

function calculateRelevanceScore(location, searchTerm) {
    var score = 0;
    var ns = normalizeText(searchTerm);
    if (location.name && normalizeText(location.name).indexOf(ns) !== -1) score += 3;
    if (location.adresse && normalizeText(location.adresse).indexOf(ns) !== -1) score += 2;
    if (location.city && normalizeText(location.city).indexOf(ns) !== -1) score += 2;
    if (location.tel && normalizeText(location.tel).indexOf(ns) !== -1) score += 1;
    if (location.email && normalizeText(location.email).indexOf(ns) !== -1) score += 1;
    return score;
}

function updateResultCount(count) {
    document.getElementById('result-count').textContent =
        count === 0 ? 'Aucun résultat' : count + ' résultat(s)';
}

// ==========================================
// LEGEND TOGGLE
// ==========================================
function setupLegendToggles() {
    var legendEcole = document.getElementById('legend-ecole');
    var legendMoniteur = document.getElementById('legend-moniteur');

    legendEcole.addEventListener('click', function() {
        // Can't disable both: if moniteurs already off, don't allow turning off ecoles
        if (!showMoniteurs && showEcoles) return; // can't turn off last one
        showEcoles = !showEcoles;
        updateLegendUI();
        applyFilters();
    });

    legendMoniteur.addEventListener('click', function() {
        if (!showEcoles && showMoniteurs) return;
        showMoniteurs = !showMoniteurs;
        updateLegendUI();
        applyFilters();
    });
}

function updateLegendUI() {
    var legendEcole = document.getElementById('legend-ecole');
    var legendMoniteur = document.getElementById('legend-moniteur');

    if (showEcoles) {
        legendEcole.classList.remove('legend-item--disabled');
    } else {
        legendEcole.classList.add('legend-item--disabled');
    }

    if (showMoniteurs) {
        legendMoniteur.classList.remove('legend-item--disabled');
    } else {
        legendMoniteur.classList.add('legend-item--disabled');
    }
}

// ==========================================
// GENERATE FILTERS UI
// ==========================================
function generateFilters() {
    var container = document.getElementById('filters-container');

    filtersData.forEach(function(group) {
        var toggler = document.createElement('div');
        toggler.className = 'filter-group__toggler';
        toggler.innerHTML =
            group.title +
            '<span class="count-badge" id="' + group.id + '-count"></span>' +
            '<i class="fa-solid fa-chevron-down chevron"></i>';

        var optionsDiv = document.createElement('div');
        optionsDiv.className = 'filter-group__options';
        optionsDiv.id = group.id + '-options';

        var list = document.createElement('div');
        list.className = 'filter-group__list';

        Object.keys(group.data).forEach(function(label) {
            var iconClass = group.data[label];
            var option = document.createElement('label');
            option.className = 'filter-option';
            option.innerHTML =
                '<i class="' + iconClass + ' filter-icon"></i>' +
                '<input type="checkbox" class="filter-cb" data-group="' + group.id + '" value="' + label + '">' +
                '<span class="filter-label">' + label + '</span>';
            list.appendChild(option);
        });

        optionsDiv.appendChild(list);
        container.appendChild(toggler);
        container.appendChild(optionsDiv);

        toggler.addEventListener('click', function() {
            optionsDiv.classList.toggle('open');
            toggler.classList.toggle('open');
        });
    });

    container.addEventListener('change', function(e) {
        if (e.target.classList.contains('filter-cb')) {
            e.target.closest('.filter-option').classList.toggle('checked', e.target.checked);
            applyFilters();
            updateFilterCounts();
            updateBadge();
        }
    });
}

function updateFilterCounts() {
    filtersData.forEach(function(group) {
        var count = document.querySelectorAll('.filter-cb[data-group="' + group.id + '"]:checked').length;
        document.getElementById(group.id + '-count').textContent = count > 0 ? '(' + count + ')' : '';
    });
}

function updateBadge() {
    var total = document.querySelectorAll('.filter-cb:checked').length;
    var badge = document.getElementById('active-filters-badge');
    badge.style.display = total > 0 ? 'inline-flex' : 'none';
    badge.textContent = total;
}

// ==========================================
// LOCATION CARD
// ==========================================
function openLocationCard(loc) {
    activeResult = loc;
    var card = document.getElementById('location-card');
    var content = document.getElementById('card-content');
    var isEcole = loc.ecole === true;
    var typeLabel = isEcole ? 'École MCF' : 'Moniteur indépendant';
    var typeClass = isEcole ? 'ecole' : 'moniteur';

    var makeTags = function(items, filterIdx) {
        return (items || []).map(function(item) {
            var icon = filtersData[filterIdx] && filtersData[filterIdx].data[item] ? filtersData[filterIdx].data[item] : '';
            return '<span class="card-tag">' + (icon ? '<i class="' + icon + '"></i>' : '') + item + '</span>';
        }).join('');
    };

    var discTags = makeTags(loc.discipline, 0);
    var prestTags = makeTags(loc.prestation, 1);
    var testTags = makeTags(loc.test_mcf, 2);
    var addressParts = [loc.adresse, [loc.cp, loc.city].filter(Boolean).join(' ')].filter(Boolean);

    content.innerHTML =
        '<div class="card-header">' +
            '<div class="card-type-badge card-type-badge--' + typeClass + '">' +
                '<i class="fa-solid ' + (isEcole ? 'fa-school' : 'fa-person-biking') + '"></i> ' +
                typeLabel +
            '</div>' +
            '<div class="card-name">' + (loc.name || '') + '</div>' +
            (addressParts.length ? '<div class="card-address"><i class="fa-solid fa-location-dot"></i> ' + addressParts.join('<br>') + '</div>' : '') +
        '</div>' +
        '<div class="card-info">' +
            (discTags ? '<div class="card-info-row"><i class="fa-solid fa-bicycle"></i><div><div class="card-info-label">Disciplines</div><div class="card-tags">' + discTags + '</div></div></div>' : '') +
            (prestTags ? '<div class="card-info-row"><i class="fa-solid fa-list-check"></i><div><div class="card-info-label">Type de prestation</div><div class="card-tags">' + prestTags + '</div></div></div>' : '') +
            (testTags ? '<div class="card-info-row"><i class="fa-solid fa-award"></i><div><div class="card-info-label">Tests MCF</div><div class="card-tags">' + testTags + '</div></div></div>' : '') +
        '</div>' +
        '<div class="card-cta" id="card-cta">' +
            '<button class="btn-voir-coordonnees ' + (isEcole ? 'btn-voir-coordonnees--ecole' : '') + '" id="btn-voir-coord">' +
                '<i class="fa-solid fa-eye"></i> Voir les coordonnées' +
            '</button>' +
        '</div>' +
        '<div id="card-coordonnees" class="card-coordonnees" style="display:none;"></div>';

    document.getElementById('btn-voir-coord').addEventListener('click', function() { revealCoordinates(loc); });
    card.style.display = 'block';
}

function revealCoordinates(loc) {
    MCFTracking.trackCoordClick(loc);
    var isEcole = loc.ecole === true;
    var coordsDiv = document.getElementById('card-coordonnees');
    document.getElementById('card-cta').style.display = 'none';

    var html = '';
    if (loc.tel) html += '<div class="coord-item"><i class="fa-solid fa-phone"></i><a href="tel:' + loc.tel + '">' + loc.tel + '</a></div>';
    if (loc.email) html += '<div class="coord-item"><i class="fa-solid fa-envelope"></i><a href="mailto:' + loc.email + '">' + loc.email + '</a></div>';
    if (loc.site_internet) {
        var expanded = [];
        loc.site_internet.split(' - ').forEach(function(l) { l.split(' ; ').forEach(function(s) { expanded.push(s); }); });
        expanded.forEach(function(trimmed) {
            trimmed = trimmed.trim();
            if (!trimmed) return;
            try {
                var url = new URL(trimmed);
                var display = url.hostname.replace(/^www\./, '');
                html += '<div class="coord-item"><i class="fa-solid fa-globe"></i><a href="' + trimmed + '" target="_blank">' + display + ' <i class="fa-solid fa-up-right-from-square" style="font-size:10px;"></i></a></div>';
            } catch (e) {
                html += '<div class="coord-item"><i class="fa-solid fa-globe"></i><span>' + trimmed + '</span></div>';
            }
        });
    }

    html += '<button class="btn-contacter ' + (isEcole ? 'btn-contacter--ecole' : '') + '" id="btn-contacter">' +
            '<i class="fa-solid fa-paper-plane"></i> Contacter ' + loc.name + '</button>';

    coordsDiv.innerHTML = html;
    coordsDiv.style.display = 'block';

    document.getElementById('btn-contacter').addEventListener('click', function() {
        window.open('https://www.moniteurcycliste.com/contactcarto?id=' + loc.code + '&contact=' + encodeURIComponent(loc.name), '_blank');
    });
}

function closeLocationCard() {
    document.getElementById('location-card').style.display = 'none';
    activeResult = null;
    if (currentPopup) { currentPopup.remove(); currentPopup = null; }
}

// ==========================================
// UI EVENT HANDLERS
// ==========================================
document.addEventListener('DOMContentLoaded', function() {
    generateFilters();
    setupLegendToggles();

    document.getElementById('filters-toggle').addEventListener('click', function() {
        var panel = document.getElementById('filters-panel');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('filters-close').addEventListener('click', function() {
        document.getElementById('filters-panel').style.display = 'none';
    });

    document.getElementById('card-close').addEventListener('click', function(e) {
        e.stopPropagation();
        closeLocationCard();
    });

    document.getElementById('filter-search').addEventListener('input', function() {
        debounce(applyFilters, 250);
    });

    document.getElementById('filters-reset').addEventListener('click', function() {
        document.querySelectorAll('.filter-cb').forEach(function(cb) {
            cb.checked = false;
            cb.closest('.filter-option').classList.remove('checked');
        });
        document.getElementById('filter-search').value = '';
        showEcoles = true;
        showMoniteurs = true;
        updateLegendUI();
        updateFilterCounts();
        updateBadge();
        applyFilters();
    });
});
