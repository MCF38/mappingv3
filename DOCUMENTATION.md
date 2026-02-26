# Cartographie MCF V2 — Documentation

## 1. Architecture des fichiers

```
alphaMapbox_v2/
├── index.html          # HTML V2 (sans panneau latéral)
├── mapbox_v2.css        # Styles V2
├── mapbox_v2.js         # Logique V2 complète
├── tracking.php         # Endpoint tracking côté serveur
├── makeJsonMap.php      # Génération JSON (MAJ : ajout test_mcf)
├── jsonmap.json         # Données source (copier depuis V1)
└── DOCUMENTATION.md     # Ce fichier
```

## 2. MAJ de la cartographie

### 2.1 Distinction Écoles / Moniteurs
- **Écoles MCF** → marqueur **OR** (gradient doré) avec icône `fa-school`
- **Moniteurs indépendants** → marqueur **BLEU** avec icône `fa-person-biking`
- Classe CSS : `.marker-ecole` / `.marker-moniteur`

### 2.2 Suppression du panneau latéral
- Plus de `<div id="panel">` ni de `<div id="results">`
- L'interaction se fait exclusivement via la carte
- Les filtres sont dans un overlay en haut à gauche (`#filters-overlay`)

### 2.3 Nouveau parcours UX
1. L'utilisateur arrive → carte plein écran avec légende
2. Il ouvre les filtres (bouton "Filtres" en haut à gauche)
3. Il sélectionne disciplines / prestations / tests MCF
4. Il clique sur un marqueur carte
5. Une **fiche synthétique** s'ouvre à droite :
   - Badge type (École / Moniteur)
   - Nom
   - Adresse
   - Disciplines (tags)
   - Prestations (tags)
   - Tests MCF (tags)
   - **Bouton "Voir les coordonnées"**
6. Au clic sur "Voir les coordonnées" :
   - Événement de tracking envoyé
   - Téléphone, email, site web révélés
   - Bouton "Contacter" affiché

## 3. Événements de tracking

### 3.1 Événement déclenché
**Uniquement** au clic sur le bouton **"Voir les coordonnées"**

### 3.2 Payload de l'événement
```json
{
  "event_type": "clic_moniteur",
  "moniteur_id": 123,
  "code_ohme_id": 2251799853008470,
  "timestamp": "2025-02-09T14:30:00.000Z",
  "origine": "cartographie",
  "type_structure": "ecole"
}
```

### 3.3 Implémentation

| Composant | Fichier | Rôle |
|-----------|---------|------|
| Frontend  | `mapbox_v2.js` → `MCFTracking.trackCoordClick()` | Envoi via `sendBeacon` vers `tracking.php` |
| Backend   | `tracking.php` | Réception, log local, transmission vers OHME |
| Log local | `tracking_log.json` | Fichier JSON incrémenté à chaque clic |

### 3.4 Options OHME (à arbitrer)

**Option A — Événements personnalisés (recommandée)**
- Décommenter le bloc `sendOhmeEvent()` dans `tracking.php`
- Adapter l'URL/endpoint selon les capacités API OHME
- Exploitable dans tableaux de bord / exports OHME

**Option B — Champ incrémenté**
- Décommenter le bloc `incrementOhmeClickCount()` dans `tracking.php`
- Incrémente un champ `clic_count` côté OHME
- ⚠️ Aucune incrémentation côté front uniquement

## 4. Champs OHME utilisés

### Structures (écoles)
| Champ JSON carto | Champ OHME source |
|-------------------|-------------------|
| `name` | `fiche_profil_nom_commercial` / `name` |
| `ecole` | `label_ecole` |
| `discipline` | `pratique` |
| `prestation` | `format_s_proposes` |
| **`test_mcf`** | **`tests_mcf`** *(nouveau)* |
| `tel` | `phone` |
| `email` | `email` |
| `site_internet` | `site_web` |

### Contacts (moniteurs)
| Champ JSON carto | Champ OHME source |
|-------------------|-------------------|
| `name` | `fiche_profil_nom_prenom` / `firstname + lastname` |
| `ecole` | `false` (toujours) |
| `discipline` | `pratique` |
| `prestation` | `format_s_proposes` |
| **`test_mcf`** | **`tests_mcf`** *(nouveau)* |
| `tel` | `telephone_professionnel` / `phone` |
| `email` | `mail_professionnel` / `email` |
| `site_internet` | `site_internet` |

### Champ `tests_mcf` dans OHME
- Type : **tableau de valeurs** (multi-sélection)
- Valeurs possibles : `Loupiot-Biclou`, `Bikers`, `Rocket-Gachette`
- ⚠️ Le remplissage de ce champ est piloté côté MCF

## 5. Filtres disponibles

| Catégorie | Sous-catégories |
|-----------|----------------|
| Disciplines | BMX, FatBike, Gravel, Mobilité/Remise en selle, Route, Trial, VTT, VTT Descente, VTT Enduro, VTT Electrique |
| Type de Prestation | Cours particuliers, Format Club, Formation, Randonnée/Balade, Stage, Séminaire, Voyage à vélo |
| **Tests MCF** *(nouveau)* | **Loupiot-Biclou, Bikers, Rocket-Gachette** |

Multi-sélection possible dans chaque catégorie.

## 6. Validation

### Test avec un moniteur test
1. Charger `index.html?show=moniteur`
2. Vérifier marqueur **bleu** avec icône vélo
3. Cliquer → fiche synthétique avec badge "Moniteur indépendant"
4. Cliquer "Voir les coordonnées" → vérifier log console (`console.table`)
5. Vérifier téléphone/email/site affichés
6. Cliquer "Contacter" → redirection vers formulaire MCF

### Test avec une école test
1. Charger `index.html?show=ecole`
2. Vérifier marqueur **OR** avec icône école
3. Cliquer → fiche synthétique avec badge doré "École MCF"
4. Cliquer "Voir les coordonnées" → vérifier tracking
5. Vérifier que le bouton CTA est doré

### Test des filtres
1. Charger `index.html` (tout)
2. Ouvrir filtres → Disciplines → cocher "VTT"
3. Vérifier que seuls les résultats VTT restent sur la carte
4. Ouvrir Tests MCF → cocher "Bikers"
5. Vérifier le croisement des filtres

## 7. Indicateurs de succès (KPIs)

Exploitables via `tracking_log.json` ou dashboard OHME :

- **Nombre de clics "Voir coordonnées"** par moniteur / école / période
- **Comparaison** écoles vs indépendants (champ `type_structure`)
- **Utilisation des filtres Tests MCF** (observable via les patterns de navigation)

## 8. URLs de déploiement

```
# Tout afficher
https://mcf38.github.io/mappingV2/

# Écoles uniquement
https://mcf38.github.io/mappingV2/?show=ecole

# Moniteurs uniquement
https://mcf38.github.io/mappingV2/?show=moniteur
```
